import { createHash } from 'node:crypto'
import { Router } from 'express'
import { db } from '../db.js'
import { ApiError, requireStoreMember, requireStoreManager, sendApiError } from './auth.js'
import { allocateReturnCents, boundedInteger, calculateDiscountedLine, discountNeedsManagerApproval, MAX_CENTS, sumDiscountedLines, type LineDiscount } from '../../../../packages/domain/src/money.js'
import { requireCashierTerminal, requireDeviceTerminal } from '../terminal-auth/routes.js'

export const ordersRouter = Router()
export const terminalOrdersRouter = Router()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type JsonRecord = Record<string, unknown>
function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'validation_failed', `${name} is required.`)
  return value as JsonRecord
}
function text(value: unknown, name: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(422, 'validation_failed', `${name} is invalid.`)
  return value
}
function id(value: unknown, name: string): string {
  const result = text(value, name, 36)
  if (!uuid.test(result)) throw new ApiError(422, 'validation_failed', `${name} must be a UUID.`)
  return result
}
function cents(value: unknown, name: string, max = MAX_CENTS): number {
  try { return boundedInteger(value as number, name, 0, max) }
  catch { throw new ApiError(422, 'validation_failed', `${name} must be valid integer cents.`) }
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 40)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new ApiError(422, 'validation_failed', `${name} must be a valid UTC timestamp.`)
  }
  return result
}
const RETURN_REASONS = ['damaged', 'customer_changed_mind', 'incorrect_item', 'pricing_error', 'other'] as const
type ReturnReason = typeof RETURN_REASONS[number]
type ReturnLineRequest = { order_item_id: string; quantity: number; restock_quantity: number }
function parseReturnRequest(raw: unknown) {
  const body = record(raw, 'Return')
  const storeId = id(body.store_id, 'Store ID')
  const operationId = id(body.operation_id, 'Operation ID')
  const reason = body.reason
  if (!RETURN_REASONS.includes(reason as ReturnReason)) throw new ApiError(422, 'validation_failed', 'Return reason is invalid.')
  const reasonNote = body.reason_note === undefined || body.reason_note === null || body.reason_note === '' ? null : text(body.reason_note, 'Return note', 500)
  if (reason === 'other' && !reasonNote) throw new ApiError(422, 'validation_failed', 'A note is required when the return reason is other.')
  const outcome = body.payment_outcome
  if (outcome !== 'cash_refund' && outcome !== 'external_card_refund_confirmed') {
    throw new ApiError(422, 'validation_failed', 'Select cash refund or confirmed external card refund.')
  }
  const externalReference = body.external_reference === undefined || body.external_reference === null || body.external_reference === ''
    ? null : text(body.external_reference, 'External reference', 120)
  if (outcome === 'external_card_refund_confirmed' && body.external_refund_confirmed !== true) {
    throw new ApiError(422, 'validation_failed', 'Confirm that the external card refund was completed outside the POS.')
  }
  const linesRaw = body.lines
  if (!Array.isArray(linesRaw) || linesRaw.length < 1 || linesRaw.length > 100) throw new ApiError(422, 'validation_failed', 'Select at least one line to return.')
  const lines = linesRaw.map((rawLine, index) => {
    const line = record(rawLine, `Return line ${index + 1}`)
    const quantity = line.quantity
    const restockQuantity = line.restock_quantity
    if (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 10_000) throw new ApiError(422, 'validation_failed', 'Return quantity is invalid.')
    if (!Number.isInteger(restockQuantity) || (restockQuantity as number) < 0 || (restockQuantity as number) > (quantity as number)) throw new ApiError(422, 'validation_failed', 'Restock quantity cannot exceed returned quantity.')
    return { order_item_id: id(line.order_item_id, 'Order item ID'), quantity: quantity as number, restock_quantity: restockQuantity as number }
  })
  if (new Set(lines.map(line => line.order_item_id)).size !== lines.length) throw new ApiError(422, 'validation_failed', 'Each original line can appear only once in a return.')
  return { storeId, operationId, reason: reason as ReturnReason, reasonNote, outcome, externalReference, lines }
}
// A line may send discount_kind/discount_value together, or omit both for no discount.
function parseDiscount(item: JsonRecord, label: string): LineDiscount {
  const kind = item.discount_kind
  if (kind === null || kind === undefined) {
    if (item.discount_value !== null && item.discount_value !== undefined) throw new ApiError(422, 'validation_failed', `${label} discount value must be empty when no discount is applied.`)
    return null
  }
  if (kind !== 'percent' && kind !== 'fixed') throw new ApiError(422, 'validation_failed', `${label} discount kind is invalid.`)
  if (!Number.isSafeInteger(item.discount_value) || (item.discount_value as number) < 0) throw new ApiError(422, 'validation_failed', `${label} discount value is invalid.`)
  return kind === 'percent' ? { kind: 'percent', bps: item.discount_value as number } : { kind: 'fixed', cents: item.discount_value as number }
}

export function validateOperation(raw: unknown) {
  const body = record(raw, 'Operation')
  const order = record(body.order, 'Order')
  const payment = record(body.payment, 'Payment')
  const items = body.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new ApiError(422, 'validation_failed', 'An order needs 1 to 100 items.')
  const storeId = id(order.store_id, 'Store ID')
  const customerId = order.customer_id === null || order.customer_id === undefined ? null : id(order.customer_id, 'Customer ID')
  const operationId = id(body.operation_id, 'Operation ID')
  if (operationId !== id(order.id, 'Order ID')) throw new ApiError(422, 'validation_failed', 'Order ID must match operation ID.')
  const parsedItems = items.map((rawItem, index) => {
    const item = record(rawItem, `Item ${index + 1}`)
    if (!Number.isSafeInteger(item.catalog_version) || (item.catalog_version as number) < 1 || (item.catalog_version as number) > MAX_CENTS) {
      throw new ApiError(422, 'validation_failed', `Item ${index + 1} catalog version is invalid.`)
    }
    const price = cents(item.snapshot_price_cents, 'Unit price')
    const discount = parseDiscount(item, `Item ${index + 1}`)
    let line: ReturnType<typeof calculateDiscountedLine>
    try { line = calculateDiscountedLine(price, item.quantity as number, item.snapshot_tax_bps as number, discount) }
    catch { throw new ApiError(422, 'validation_failed', `Item ${index + 1} has invalid quantity, tax, discount or amount.`) }
    if (line.subtotalCents !== item.subtotal_cents || line.discountAppliedCents !== item.discount_applied_cents ||
        line.taxableCents !== item.taxable_cents || line.taxCents !== item.tax_cents || line.totalCents !== item.total_cents) {
      throw new ApiError(422, 'total_mismatch', `Item ${index + 1} totals do not match.`)
    }
    return { id: id(item.id, 'Item ID'), product_id: id(item.product_id, 'Product ID'),
      snapshot_name: text(item.snapshot_name, 'Item name'), snapshot_sku: text(item.snapshot_sku, 'Item SKU', 80),
      snapshot_price_cents: price, snapshot_tax_bps: item.snapshot_tax_bps as number,
      catalog_version: item.catalog_version as number, quantity: item.quantity as number,
      discount_kind: discount?.kind ?? null, discount_value: discount ? (discount.kind === 'percent' ? discount.bps : discount.cents) : null,
      subtotal_cents: line.subtotalCents, discount_applied_cents: line.discountAppliedCents,
      taxable_cents: line.taxableCents, tax_cents: line.taxCents, total_cents: line.totalCents }
  })
  if (new Set(parsedItems.map(item => item.id)).size !== parsedItems.length) {
    throw new ApiError(422, 'validation_failed', 'Item IDs must be unique within a sale.')
  }
  let totals: ReturnType<typeof sumDiscountedLines>
  try {
    totals = sumDiscountedLines(parsedItems.map(item => ({ subtotalCents: item.subtotal_cents, discountAppliedCents: item.discount_applied_cents,
      taxableCents: item.taxable_cents, taxCents: item.tax_cents, totalCents: item.total_cents })))
  } catch { throw new ApiError(422, 'total_mismatch', 'Order exceeds the supported money range.') }
  if (totals.subtotalCents !== order.subtotal_cents || totals.discountCents !== order.discount_cents ||
      totals.taxCents !== order.tax_cents || totals.totalCents !== order.total_cents) {
    throw new ApiError(422, 'total_mismatch', 'Order totals do not match line totals.')
  }
  const employeeId = order.employee_id === null || order.employee_id === undefined ? null : id(order.employee_id, 'Employee ID')
  const managerId = order.manager_id === null || order.manager_id === undefined ? null : id(order.manager_id, 'Manager ID')
  const managerApprovedAt = order.manager_approved_at === null || order.manager_approved_at === undefined ? null : timestamp(order.manager_approved_at, 'Manager approval time')
  if ((managerId === null) !== (managerApprovedAt === null)) throw new ApiError(422, 'validation_failed', 'Manager approval evidence is incomplete.')
  const needsApproval = parsedItems.some(item => discountNeedsManagerApproval(item.subtotal_cents, item.discount_applied_cents))
  if (needsApproval && managerId === null) throw new ApiError(422, 'validation_failed', 'A discount on this sale requires manager approval.')
  const method = payment.method
  if (method !== 'cash' && method !== 'card') throw new ApiError(422, 'validation_failed', 'Payment method is invalid.')
  const amount = cents(payment.amount_cents, 'Payment amount')
  const tendered = cents(payment.tendered_cents, 'Tendered amount')
  const change = cents(payment.change_cents, 'Change amount')
  if (amount !== totals.totalCents || (method === 'cash' && tendered !== amount + change) ||
      (method === 'card' && (tendered !== amount || change !== 0))) {
    throw new ApiError(422, 'total_mismatch', 'Payment does not balance with the order.')
  }
  const generatedAt = timestamp(order.client_generated_at, 'Sale time')
  if (!Number.isSafeInteger(order.catalog_version) || (order.catalog_version as number) < 1 || (order.catalog_version as number) > MAX_CENTS) {
    throw new ApiError(422, 'validation_failed', 'Catalog version is invalid.')
  }
  return { operationId, storeId, items: parsedItems, totals,
    order: { customer_id: customerId, receipt_number: text(order.receipt_number, 'Receipt number', 100),
      catalog_version: order.catalog_version as number,
      client_generated_at: generatedAt, employee_id: employeeId, manager_id: managerId, manager_approved_at: managerApprovedAt },
    payment: { id: id(payment.id, 'Payment ID'), method, amount_cents: amount,
      tendered_cents: tendered, change_cents: change,
      reference: payment.reference === null || payment.reference === undefined ? null : text(payment.reference, 'Card reference', 120) } }
}

async function push(req: import('express').Request, res: import('express').Response, terminal = false) {
  try {
    const operation = validateOperation(req.body)
    if (terminal) {
      const session = await requireDeviceTerminal(req, db)
      if (session.storeId !== operation.storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
      // Prefer the currently authenticated cashier's identity over whatever the client sent, so a
      // sale can't be attributed to a different employee than the one actually unlocked on this
      // device. A device-only session (queued sale synced after logout) has no cashier to check
      // against, so it falls back to the client-sent value's best-effort existence check below.
      try { operation.order.employee_id = (await requireCashierTerminal(req, db)).employeeId }
      catch { /* no active cashier session on this device right now */ }
    } else await requireStoreMember(req, operation.storeId)
    const hash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex')
    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [operation.storeId])
      await client.query('select last_position from public.pos_sync_feed_state where store_id = $1 for update', [operation.storeId])
      const replay = await client.query('select payload_hash,result_json from public.pos_operation_ledger where store_id=$1 and operation_id=$2', [operation.storeId, operation.operationId])
      if (replay.rows[0]) {
        if (replay.rows[0].payload_hash !== hash) throw new ApiError(409, 'operation_id_conflict', 'This operation ID was used for another sale.')
        await client.query('commit')
        res.json(replay.rows[0].result_json)
        return
      }
      const store = await client.query('select name,timezone,currency from public.stores where id=$1', [operation.storeId])
      if (!store.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Store no longer exists.')
      const productIds = [...new Set(operation.items.map(item => item.product_id))]
      const products = await client.query('select id from public.pos_products where store_id=$1 and id = any($2::uuid[])', [operation.storeId, productIds])
      if (products.rowCount !== productIds.length) throw new ApiError(422, 'cross_store_reference', 'An item refers to a product outside this store.')
      if (operation.order.customer_id) {
        const customer = await client.query('select 1 from public.pos_customers where store_id=$1 and id=$2', [operation.storeId, operation.order.customer_id])
        if (!customer.rowCount) {
          // Customer was rejected or not yet synced — accept the order without the customer link
          // rather than blocking this paid sale from syncing permanently.
          // The local Dexie record retains the customer reference for the cashier's view.
          operation.order.customer_id = null
        }
      }
      if (operation.order.employee_id) {
        const employee = await client.query('select 1 from public.terminal_employees where store_id=$1 and id=$2', [operation.storeId, operation.order.employee_id])
        if (!employee.rowCount) {
          // Employee record was removed or never synced — accept the order without cashier
          // attribution rather than blocking this paid sale from syncing permanently.
          operation.order.employee_id = null
        }
      }
      if (operation.order.manager_id) {
        const manager = await client.query(
          "select 1 from public.terminal_employees where store_id=$1 and id=$2 and role='manager' and active=true",
          [operation.storeId, operation.order.manager_id])
        if (!manager.rowCount) throw new ApiError(422, 'validation_failed', 'Manager approval references an employee who is not an active manager for this store.')
      }
      await client.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,customer_id,employee_id,manager_id,manager_approved_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [operation.operationId, operation.storeId, operation.order.receipt_number, store.rows[0].currency,
          store.rows[0].name, store.rows[0].timezone, operation.totals.subtotalCents, operation.totals.discountCents, operation.totals.taxCents,
          operation.totals.totalCents, operation.order.catalog_version, operation.order.client_generated_at, operation.order.customer_id,
          operation.order.employee_id, operation.order.manager_id, operation.order.manager_approved_at])
      for (const item of operation.items) {
        await client.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
          snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,discount_kind,discount_value,
          subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [item.id, operation.storeId, operation.operationId, item.product_id, item.snapshot_name, item.snapshot_sku,
            item.snapshot_price_cents, item.snapshot_tax_bps, item.catalog_version, item.quantity, item.discount_kind, item.discount_value,
            item.subtotal_cents, item.discount_applied_cents, item.taxable_cents, item.tax_cents, item.total_cents])
      }
      await client.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,reference,client_generated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [operation.payment.id, operation.storeId, operation.operationId,
          operation.payment.method, operation.payment.amount_cents, operation.payment.tendered_cents,
          operation.payment.change_cents, operation.payment.reference, operation.order.client_generated_at])
      let position = BigInt((await client.query('select last_position::text from public.pos_sync_feed_state where store_id=$1', [operation.storeId])).rows[0].last_position)
      for (const productId of productIds) {
        const quantity = operation.items.filter(item => item.product_id === productId).reduce((sum, item) => sum + item.quantity, 0)
        await client.query(`insert into public.pos_inventory_movements(store_id,product_id,order_id,operation_id,delta,reason)
          values ($1,$2,$3,$4,$5,'sale')`, [operation.storeId, productId, operation.operationId, operation.operationId, -quantity])
        const stock = await client.query(`update public.pos_stock set current_stock=current_stock-$3, updated_at=now()
          where store_id=$1 and product_id=$2 returning current_stock`, [operation.storeId, productId, quantity])
        if (!stock.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Stock projection is missing for a product.')
        position += 1n
        await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
          values ($1,$2,'stock',$3,$4)`, [operation.storeId, position.toString(), productId, { product_id: productId, current_stock: stock.rows[0].current_stock }])
      }
      position += 1n
      await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
        values ($1,$2,'order',$3,$4)`, [operation.storeId, position.toString(), operation.operationId, { receipt_number: operation.order.receipt_number }])
      await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [operation.storeId, position.toString()])
      const result = { status: 'accepted', operation_id: operation.operationId, accepted_checkpoint: position.toString() }
      await client.query(`insert into public.pos_operation_ledger(store_id,operation_id,payload_hash,status,result_json,accepted_checkpoint)
        values ($1,$2,$3,'accepted',$4,$5)`, [operation.storeId, operation.operationId, hash, result, position.toString()])
      await client.query('commit')
      res.json(result)
    } catch (reason) { await client.query('rollback'); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}
// ---------------------------------------------------------------------------
// POST /orders/:id/refund — owner/manager whole-order refund.
// Money-correctness code: held to the same review bar as checkout itself (validateOperation
// above). No partial line items, no re-charging — the entire order's total is reversed and its
// stock restored. The original pos_orders/pos_order_items rows are never touched; the refund is
// its own append-only record, per docs/04_er_diagrams.md:98's suggested shape (reference the sale
// through order_id, the return through a separate refund_id — never the other way around).
// ---------------------------------------------------------------------------
async function createReturn(req: import('express').Request, res: import('express').Response) {
  try {
    const orderId = id(req.params.id, 'Order ID')
    const request = parseReturnRequest(req.body)
    const actorId = await requireStoreManager(req, request.storeId)
    const hash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex')
    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [request.storeId])
      let position = BigInt((await client.query<{ last_position: string }>('select last_position::text as last_position from public.pos_sync_feed_state where store_id=$1 for update', [request.storeId])).rows[0].last_position)
      const replay = await client.query<{ payload_hash: string; result_json: unknown }>('select payload_hash,result_json from public.pos_operation_ledger where store_id=$1 and operation_id=$2', [request.storeId, request.operationId])
      if (replay.rows[0]) {
        if (replay.rows[0].payload_hash !== hash) throw new ApiError(409, 'operation_id_conflict', 'This operation ID was used for a different return.')
        await client.query('commit'); res.json(replay.rows[0].result_json); return
      }
      const order = await client.query('select id,receipt_number from public.pos_orders where store_id=$1 and id=$2', [request.storeId, orderId])
      if (!order.rows[0]) throw new ApiError(404, 'not_found', 'Order not found.')
      const itemIds = request.lines.map(line => line.order_item_id)
      const originals = await client.query<{
        id: string; product_id: string; quantity: number; subtotal_cents: string; discount_applied_cents: string; tax_cents: string; total_cents: string
      }>(`select id,product_id,quantity,subtotal_cents::text,discount_applied_cents::text,tax_cents::text,total_cents::text
          from public.pos_order_items where store_id=$1 and order_id=$2 and id=any($3::uuid[]) for update`, [request.storeId, orderId, itemIds])
      if (originals.rowCount !== request.lines.length) throw new ApiError(422, 'cross_store_reference', 'A selected line does not belong to this sale.')
      const returned = await client.query<{ order_item_id: string; quantity: string }>(`select ri.order_item_id, coalesce(sum(ri.quantity),0)::text as quantity
          from public.pos_refund_items ri join public.pos_refunds r on r.id=ri.refund_id and r.store_id=ri.store_id
          where ri.store_id=$1 and ri.order_item_id=any($2::uuid[]) group by ri.order_item_id`, [request.storeId, itemIds])
      const returnedByItem = new Map(returned.rows.map(row => [row.order_item_id, Number(row.quantity)]))
      const selections = request.lines.map(line => {
        const original = originals.rows.find(item => item.id === line.order_item_id)!
        const already = returnedByItem.get(original.id) ?? 0
        if (line.quantity + already > original.quantity) throw new ApiError(409, 'return_quantity_conflict', 'This return exceeds the quantity originally sold.')
        return { ...line, original, already,
          subtotal_cents: allocateReturnCents(Number(original.subtotal_cents), original.quantity, already, line.quantity),
          discount_cents: allocateReturnCents(Number(original.discount_applied_cents), original.quantity, already, line.quantity),
          tax_cents: allocateReturnCents(Number(original.tax_cents), original.quantity, already, line.quantity),
          amount_cents: allocateReturnCents(Number(original.total_cents), original.quantity, already, line.quantity) }
      })
      const amount = selections.reduce((sum, line) => sum + line.amount_cents, 0)
      if (!Number.isSafeInteger(amount) || amount > MAX_CENTS) throw new ApiError(422, 'validation_failed', 'Return amount exceeds the supported limit.')
      const header = await client.query<{ id: string; created_at: string }>(`insert into public.pos_refunds
        (store_id,order_id,amount_cents,reason,reason_code,reason_note,payment_outcome,external_reference,operation_id,refunded_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id,created_at`,
        [request.storeId, orderId, amount, request.reasonNote, request.reason, request.reasonNote, request.outcome, request.externalReference, request.operationId, actorId])
      for (const line of selections) await client.query(`insert into public.pos_refund_items
        (store_id,refund_id,order_item_id,product_id,quantity,restock_quantity,subtotal_cents,discount_cents,tax_cents,amount_cents)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [request.storeId, header.rows[0].id, line.original.id, line.original.product_id, line.quantity, line.restock_quantity, line.subtotal_cents, line.discount_cents, line.tax_cents, line.amount_cents])
      for (const line of selections.filter(line => line.restock_quantity > 0)) {
        await client.query(`insert into public.pos_inventory_movements(store_id,product_id,order_id,operation_id,delta,reason,actor_id)
          values ($1,$2,$3,gen_random_uuid(),$4,'refund',$5)`, [request.storeId, line.original.product_id, orderId, line.restock_quantity, actorId])
        const stock = await client.query<{ current_stock: number }>('update public.pos_stock set current_stock=current_stock+$3,updated_at=now() where store_id=$1 and product_id=$2 returning current_stock', [request.storeId, line.original.product_id, line.restock_quantity])
        if (!stock.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Stock projection is missing for a returned product.')
        position += 1n
        await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload) values ($1,$2,'stock',$3,$4)`, [request.storeId, position.toString(), line.original.product_id, { product_id: line.original.product_id, current_stock: stock.rows[0].current_stock }])
      }
      position += 1n
      await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload) values ($1,$2,'refund',$3,$4)`, [request.storeId, position.toString(), header.rows[0].id, { order_id: orderId, refund_id: header.rows[0].id, amount_cents: amount }])
      await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [request.storeId, position.toString()])
      await client.query('insert into public.audit_log(store_id,actor_id,action,target,details) values ($1,$2,$3,$4,$5)', [request.storeId, actorId, 'return.created', `Return ${header.rows[0].id} for ${order.rows[0].receipt_number}: ${amount} cents`, { order_id: orderId, refund_id: header.rows[0].id, reason: request.reason, amount_cents: amount, payment_outcome: request.outcome, lines: selections.map(line => ({ order_item_id: line.original.id, quantity: line.quantity, restock_quantity: line.restock_quantity })) }])
      const result = { return: { id: header.rows[0].id, order_id: orderId, amount_cents: amount, created_at: header.rows[0].created_at, payment_outcome: request.outcome }, operation_id: request.operationId, accepted_checkpoint: position.toString() }
      await client.query('insert into public.pos_operation_ledger(store_id,operation_id,payload_hash,status,result_json,accepted_checkpoint) values ($1,$2,$3,$4,$5,$6)', [request.storeId, request.operationId, hash, 'accepted', result, position.toString()])
      await client.query('commit'); res.status(201).json(result)
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  } catch (error) { sendApiError(res, error) }
}

async function refund(req: import('express').Request, res: import('express').Response) {
  try {
    const orderId = id(req.params.id, 'Order ID')
    const body = req.body as Record<string, unknown>
    const storeId = id(body.store_id, 'Store ID')
    const reason = body.reason === null || body.reason === undefined || body.reason === ''
      ? null : text(body.reason, 'Refund reason', 240)

    const userId = await requireStoreManager(req, storeId)

    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [storeId])
      await client.query('select last_position from public.pos_sync_feed_state where store_id=$1 for update', [storeId])

      const orderRes = await client.query<{ id: string; total_cents: string }>(
        'select id, total_cents::text as total_cents from public.pos_orders where store_id=$1 and id=$2',
        [storeId, orderId],
      )
      if (!orderRes.rows[0]) throw new ApiError(404, 'not_found', 'Order not found.')
      const order = orderRes.rows[0]

      const existing = await client.query('select 1 from public.pos_refunds where store_id=$1 and order_id=$2', [storeId, orderId])
      if (existing.rowCount) throw new ApiError(409, 'refund_conflict', 'This order has already been refunded.')

      const itemsRes = await client.query<{ id: string; product_id: string; quantity: number; total_cents: string }>(
        'select id, product_id, quantity, total_cents::text as total_cents from public.pos_order_items where store_id=$1 and order_id=$2',
        [storeId, orderId],
      )
      if (!itemsRes.rowCount) throw new ApiError(422, 'validation_failed', 'Order has no line items to refund.')
      const items = itemsRes.rows

      const refundRes = await client.query<{ id: string; store_id: string; order_id: string; amount_cents: string; reason: string | null; refunded_by: string; created_at: string }>(
        `insert into public.pos_refunds (store_id, order_id, amount_cents, reason, refunded_by)
         values ($1,$2,$3,$4,$5)
         returning id, store_id, order_id, amount_cents::text as amount_cents, reason, refunded_by, created_at`,
        [storeId, orderId, order.total_cents, reason, userId],
      )
      const refundRow = refundRes.rows[0]

      for (const item of items) {
        await client.query(
          `insert into public.pos_refund_items (store_id, refund_id, order_item_id, product_id, quantity, amount_cents)
           values ($1,$2,$3,$4,$5,$6)`,
          [storeId, refundRow.id, item.id, item.product_id, item.quantity, item.total_cents],
        )
      }

      // Reverse stock once per distinct product (checkout already merges same-product cart lines,
      // but this groups defensively rather than assuming that holds for every historical order).
      const byProduct = new Map<string, number>()
      for (const item of items) byProduct.set(item.product_id, (byProduct.get(item.product_id) ?? 0) + item.quantity)

      let position = BigInt((await client.query('select last_position::text from public.pos_sync_feed_state where store_id=$1', [storeId])).rows[0].last_position)
      for (const [productId, quantity] of byProduct) {
        await client.query(
          `insert into public.pos_inventory_movements (store_id, product_id, order_id, operation_id, delta, reason)
           values ($1,$2,$3,gen_random_uuid(),$4,'refund')`,
          [storeId, productId, orderId, quantity],
        )
        const stock = await client.query(`update public.pos_stock set current_stock=current_stock+$3, updated_at=now()
          where store_id=$1 and product_id=$2 returning current_stock`, [storeId, productId, quantity])
        if (!stock.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Stock projection is missing for a refunded product.')
        position += 1n
        await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
          values ($1,$2,'stock',$3,$4)`, [storeId, position.toString(), productId, { product_id: productId, current_stock: stock.rows[0].current_stock }])
      }

      position += 1n
      await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
        values ($1,$2,'refund',$3,$4)`, [storeId, position.toString(), refundRow.id, { order_id: orderId, refund_id: refundRow.id, amount_cents: order.total_cents }])
      await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [storeId, position.toString()])

      await client.query('commit')
      res.status(201).json({ refund: refundRow })
    } catch (reason2) {
      await client.query('rollback')
      throw reason2
    } finally {
      client.release()
    }
  } catch (reason) {
    sendApiError(res, reason)
  }
}

ordersRouter.post('/push', (req, res) => void push(req, res))
terminalOrdersRouter.post('/push', (req, res) => void push(req, res, true))
ordersRouter.post('/:id/returns', (req, res) => void createReturn(req, res))
ordersRouter.post('/:id/refund', (req, res) => void refund(req, res))
