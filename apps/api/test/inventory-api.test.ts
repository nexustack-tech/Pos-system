import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'

// Phase 2: Inventory Operations — API-level correctness tests. These exercise the real
// createApp() HTTP surface (POST /inventory/adjust, cycle counts, etc.) against an in-memory
// Postgres (PGlite) with every migration applied, plus a tiny fake "Supabase identity" HTTP
// server so requireStoreManager()'s real auth.getUser(token) call resolves distinct owner/
// manager/cashier fixture users — the same technique apps/api/test/catalog-browser-check.ts
// uses, minus the Playwright/browser parts this file doesn't need (these are transaction/RBAC/
// ledger correctness tests, not UI tests; the UI is covered separately).
//
// Numbered comments below map directly to the 10 acceptance scenarios from the Phase 2 spec.

const root = fileURLToPath(new URL('../../../', import.meta.url))
const MIGRATIONS = [
  '202609130001_auth_and_stores.sql',
  '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql',
  '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql',
  '202609160001_customers_and_sale_attachment.sql',
  '202609170001_change_feed_product_entity.sql',
  '202609170002_cart_discounts.sql',
  '202609180001_terminal_name_uniqueness.sql',
  '202609180002_pos_orders_report_read_access.sql',
  '202609180002_store_business_details.sql',
  '202609180003_tax_rate_change_feed.sql',
  '202609180004_product_images.sql',
  '202609180005_refunds.sql',
  '202609190001_audit_log.sql',
  '202609190001_store_onboarding_status.sql',
  '202609190002_remove_demo_catalog_seed.sql',
  '202609190003_store_sync_feed_init.sql',
  '202609200001_service_role_only_rls_policies.sql',
  '202609220001_inventory_operations.sql',
  '202609220002_returns_and_exchanges.sql',
]

type AdjustResult = { product_id: string; old_quantity: number; new_quantity: number; delta: number; movement_id: string }

test('Phase 2 inventory operations: RBAC, transactional ledger, isolation, negative stock, rollback, sync, and checkout/refund regression', async () => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  process.env.SUPABASE_URL = 'http://127.0.0.1:3591'
  process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'
  const { db } = await import('../src/db.js')
  const { createApp } = await import('../src/app.js')

  const database = new PGlite()
  let identityServer: ReturnType<express.Express['listen']> | undefined
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';
      create schema storage;
      create table storage.buckets(id text primary key, name text, public boolean);
      create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
      create function storage.foldername(name text) returns text[] language sql as
        $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;`)
    for (const name of MIGRATIONS) {
      const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
      await database.exec(sql)
    }

    // ── Fixture data: one store, two products (A and B — used for the sibling-isolation check),
    // an owner, a manager and a cashier, all as real store_memberships rows (web Bearer-token
    // auth, not the separate PIN-based terminal cashier flow). ──────────────────────────────
    const owner = randomUUID(), manager = randomUUID(), cashier = randomUUID(), store = randomUUID()
    const productA = randomUUID(), productB = randomUUID()
    await database.query('insert into auth.users(id) values ($1),($2),($3)', [owner, manager, cashier])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Fixture Store','inv-fixture',$2)", [store, owner])
    await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner'),($1,$3,'manager'),($1,$4,'cashier')", [store, owner, manager, cashier])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-A','Product A',1000),($3,$2,'SKU-B','Product B',2000)`, [productA, store, productB])
    await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,20),($1,$3,20)', [store, productA, productB])

    // ── Fake Supabase identity server: resolves a Bearer token to one of the three fixture
    // users. requireStoreManager()/requireStoreMember() call the real @supabase/supabase-js
    // client's auth.getUser(token), which makes an HTTP GET to SUPABASE_URL/auth/v1/user — this
    // stub answers that call. The subsequent owner/manager role check queries Postgres directly
    // (not Supabase REST), so no other endpoint needs stubbing. ────────────────────────────────
    const tokenFor = (userId: string) => `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture-${userId}`
    const ownerToken = tokenFor(owner), managerToken = tokenFor(manager), cashierToken = tokenFor(cashier)
    const usersByToken = new Map([
      [ownerToken, { id: owner, aud: 'authenticated', role: 'authenticated', email: 'owner@fixture.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }],
      [managerToken, { id: manager, aud: 'authenticated', role: 'authenticated', email: 'manager@fixture.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }],
      [cashierToken, { id: cashier, aud: 'authenticated', role: 'authenticated', email: 'cashier@fixture.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }],
    ])
    const identity = express()
    identity.get('/auth/v1/user', (req, res) => {
      const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1]
      const user = token ? usersByToken.get(token) : undefined
      if (!user) { res.sendStatus(401); return }
      res.json(user)
    })
    identityServer = identity.listen(3591, '127.0.0.1')

    // ── PGlite-backed pg.Pool stand-in, same monkey-patch every other integration test here uses. ──
    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
    let tail = Promise.resolve()
    const query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.query = query
    // A real pg.Pool hands out a separate physical connection per connect() call, so two
    // concurrent transactions never block each other unless they lock the same row. PGlite is a
    // single connection, so overlapping "begin ... commit" blocks from concurrent connect() calls
    // would interleave on top of each other and corrupt transaction state. Chaining a tail promise
    // serializes connect() calls onto that one connection, which is exactly what every other
    // fixture in this test suite already does (see orders-duplicate-submit.test.ts).
    fixture.connect = async () => {
      const previous = tail; let release!: () => void
      tail = new Promise<void>(resolve => { release = resolve }); await previous
      return { query, release }
    }

    server = createApp({ pool: db, origin: 'http://127.0.0.1:3590', supabaseUrl: 'http://127.0.0.1:3591', supabaseKey: 'fixture', secureCookies: false }).listen(3590, '127.0.0.1')
    const base = 'http://127.0.0.1:3590'
    const call = (path: string, token: string | null, init: { method?: string; body?: unknown } = {}) =>
      fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
    const stockOf = async (productId: string) => (await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, productId])).rows[0].current_stock
    const movementsOf = async (productId: string) => (await database.query('select * from public.pos_inventory_movements where store_id=$1 and product_id=$2 order by server_received_at', [store, productId])).rows as Array<Record<string, unknown>>
    const feedPosition = async () => BigInt((await database.query<{ last_position: string }>('select last_position::text as last_position from public.pos_sync_feed_state where store_id=$1', [store])).rows[0].last_position)
    const auditCount = async (action: string) => (await database.query('select id from public.audit_log where store_id=$1 and action=$2', [store, action])).rows.length

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 2. Cashier authorization rejection — UI-hidden buttons are not the security boundary; a
    // direct API call from a cashier-role member must be rejected for every inventory-changing
    // (and inventory-reading) endpoint, with zero DB mutation.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const stockBefore = await stockOf(productA)
      const feedBefore = await feedPosition()

      const readResp = await call(`/inventory?store_id=${store}`, cashierToken)
      assert.equal(readResp.status, 403)

      const adjustResp = await call('/inventory/adjust', cashierToken, { method: 'POST', body: { store_id: store, product_id: productA, delta: 5, reason: 'received', note: 'cashier attempt', operation_id: randomUUID() } })
      assert.equal(adjustResp.status, 403)
      assert.equal((await adjustResp.json()).code, 'authorization_failed')

      const cycleResp = await call('/inventory/cycle-counts', cashierToken, { method: 'POST', body: { store_id: store, product_ids: [productA] } })
      assert.equal(cycleResp.status, 403)

      // No DB mutation occurred anywhere as a side effect of the rejected attempts.
      assert.equal(await stockOf(productA), stockBefore)
      assert.equal(await feedPosition(), feedBefore)
      assert.equal((await database.query('select id from public.pos_cycle_counts where store_id=$1', [store])).rows.length, 0)
      assert.equal((await movementsOf(productA)).length, 0)

      // An unauthenticated request (no token at all) is also rejected, not just role-mismatched.
      assert.equal((await call(`/inventory?store_id=${store}`, null)).status, 401)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 1. Manager manual adjustment — full trace: response, ledger row, audit log, change feed,
    // and authoritative stock, all inside one transaction.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const feedBefore = await feedPosition()
      const resp = await call('/inventory/adjust', managerToken, { method: 'POST', body: { store_id: store, product_id: productA, delta: 7, reason: 'received', note: 'New shipment counted in.', operation_id: randomUUID() } })
      assert.equal(resp.status, 201)
      const body = await resp.json() as { product_id: string; old_quantity: number; new_quantity: number; delta: number; movement_id: string }
      assert.equal(body.old_quantity, 20)
      assert.equal(body.new_quantity, 27)
      assert.equal(body.delta, 7)
      assert.equal(await stockOf(productA), 27)

      const movements = await movementsOf(productA)
      assert.equal(movements.length, 1)
      const movement = movements[0]
      assert.equal(movement.id, body.movement_id)
      assert.equal(movement.reason, 'manual_adjustment')
      assert.equal(movement.adjustment_reason, 'received')
      assert.equal(movement.note, 'New shipment counted in.')
      assert.equal(movement.actor_id, manager)
      assert.equal(movement.old_quantity, 20)
      assert.equal(movement.new_quantity, 27)
      assert.equal(movement.delta, 7)

      assert.equal(await auditCount('inventory.adjusted'), 1)

      const feedRow = await database.query('select entity_type, entity_id, payload from public.pos_change_feed where store_id=$1 order by position desc limit 1', [store])
      assert.equal(feedRow.rows[0].entity_type, 'stock')
      assert.equal(feedRow.rows[0].entity_id, productA)
      assert.equal((feedRow.rows[0].payload as { current_stock: number }).current_stock, 27)
      assert.equal(await feedPosition(), feedBefore + 1n)

      // Movements ledger surfaces the same trace through the API, including the acting manager's name.
      const listResp = await call(`/inventory/movements?store_id=${store}&product_id=${productA}`, managerToken)
      const listed = (await listResp.json() as { items: Array<{ reason: string; old_quantity: number; new_quantity: number }> }).items
      assert.equal(listed.length, 1)
      assert.equal(listed[0].reason, 'manual_adjustment')
      assert.equal(listed[0].old_quantity, 20)
      assert.equal(listed[0].new_quantity, 27)
    }

    // A low-stock threshold is catalog state, not merely a local display preference. Updating it
    // must advance the product revision and publish a product feed entry so other terminals can
    // synchronize the new threshold without waiting for an unrelated stock movement.
    {
      const feedBefore = await feedPosition()
      const before = await database.query<{ revision: string }>('select revision::text as revision from public.pos_products where store_id=$1 and id=$2', [store, productA])
      const resp = await call('/inventory/threshold', managerToken, { method: 'PATCH', body: { store_id: store, product_id: productA, low_stock_threshold: 9 } })
      assert.equal(resp.status, 200)
      const body = await resp.json() as { low_stock_threshold: number; revision: string; checkpoint: string }
      assert.equal(body.low_stock_threshold, 9)
      assert.equal(body.revision, String(Number(before.rows[0].revision) + 1))
      assert.equal(body.checkpoint, String(feedBefore + 1n))
      const row = await database.query<{ low_stock_threshold: number; revision: string }>('select low_stock_threshold, revision::text as revision from public.pos_products where store_id=$1 and id=$2', [store, productA])
      assert.equal(row.rows[0].low_stock_threshold, 9)
      assert.equal(row.rows[0].revision, body.revision)
      const feed = await database.query<{ entity_type: string; entity_id: string; payload: { product: { low_stock_threshold: number; revision: number } } }>('select entity_type, entity_id, payload from public.pos_change_feed where store_id=$1 and position=$2', [store, body.checkpoint])
      assert.equal(feed.rows[0].entity_type, 'product')
      assert.equal(feed.rows[0].entity_id, productA)
      assert.equal(feed.rows[0].payload.product.low_stock_threshold, 9)
      assert.equal(feed.rows[0].payload.product.revision, Number(body.revision))
    }

    // Owner role works identically to manager for the same endpoint (both satisfy requireStoreManager).
    {
      const resp = await call('/inventory/adjust', ownerToken, { method: 'POST', body: { store_id: store, product_id: productA, delta: -2, reason: 'damaged', note: 'Two units crushed in the stockroom.', operation_id: randomUUID() } })
      assert.equal(resp.status, 201)
      assert.equal(await stockOf(productA), 25)
    }

    // A manual adjustment without a note is rejected before it ever reaches the transaction.
    {
      const resp = await call('/inventory/adjust', managerToken, { method: 'POST', body: { store_id: store, product_id: productA, delta: 1, reason: 'correction', note: '   ', operation_id: randomUUID() } })
      assert.equal(resp.status, 422)
      assert.equal(await stockOf(productA), 25)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // Idempotency — a lost response and a retried "Save" click must not double-apply a delta.
    // POST /inventory/adjust reuses the same pos_operation_ledger replay mechanism orders.ts's
    // push() relies on for checkout: a retry with the identical body and operation_id is a true
    // no-op (same result, no second movement, no second stock change); the same operation_id
    // reused for a genuinely different adjustment is rejected outright.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const stockBefore = await stockOf(productA)
      const movementsBefore = (await movementsOf(productA)).length
      const feedBefore = await feedPosition()
      const operationId = randomUUID()
      const body = { store_id: store, product_id: productA, delta: 4, reason: 'correction', note: 'Idempotency check.', operation_id: operationId }

      const first = await call('/inventory/adjust', managerToken, { method: 'POST', body })
      assert.equal(first.status, 201)
      const firstResult = await first.json() as AdjustResult
      assert.equal(firstResult.old_quantity, stockBefore)
      assert.equal(firstResult.new_quantity, stockBefore + 4)
      assert.equal(await stockOf(productA), stockBefore + 4)

      // Exact replay: identical body, same operation_id. Must be a true no-op.
      const replay = await call('/inventory/adjust', managerToken, { method: 'POST', body })
      assert.equal(replay.status, 200)
      assert.deepEqual(await replay.json(), firstResult)
      assert.equal(await stockOf(productA), stockBefore + 4, 'a replayed adjustment must not apply the delta a second time')
      assert.equal((await movementsOf(productA)).length, movementsBefore + 1, 'a replay must not create a second ledger row')
      assert.equal(await feedPosition(), feedBefore + 1n, 'a replay must not advance the feed position a second time')

      // Reusing the same operation_id for a genuinely different adjustment is rejected.
      const conflicting = await call('/inventory/adjust', managerToken, { method: 'POST', body: { ...body, delta: 9 } })
      assert.equal(conflicting.status, 409)
      assert.equal((await conflicting.json()).code, 'operation_id_conflict')
      assert.equal(await stockOf(productA), stockBefore + 4, 'a conflicting reused operation_id must not apply any delta')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 7. Sibling/product isolation — adjusting Product A must never touch Product B's stock or
    // ledger. (This codebase has no product-variant schema; the isolation principle is verified
    // at the product level, which is the only stockable entity that exists — see
    // docs/phase-2-inventory-operations-plan.md's stockable-entity contract decision.)
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const bStockBefore = await stockOf(productB)
      const bMovementsBefore = (await movementsOf(productB)).length
      assert.equal(bStockBefore, 20)
      assert.equal(bMovementsBefore, 0)
      // (Product A was adjusted twice above already; confirm B was never touched by either.)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 8. Negative / oversold stock — never clamp to zero; it must be returned, stored and listed
    // as the true negative number.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const stockBefore = await stockOf(productA)
      const delta = -(stockBefore + 15)   // guaranteed to land exactly on -15 regardless of prior scenarios' deltas
      const resp = await call('/inventory/adjust', managerToken, { method: 'POST', body: { store_id: store, product_id: productA, delta, reason: 'lost', note: 'Stock count shortfall investigated and confirmed lost.', operation_id: randomUUID() } })
      assert.equal(resp.status, 201)
      const body = await resp.json() as { old_quantity: number; new_quantity: number }
      assert.equal(body.old_quantity, stockBefore)
      assert.equal(body.new_quantity, -15)
      assert.equal(await stockOf(productA), -15)

      const listResp = await call(`/inventory?store_id=${store}`, managerToken)
      const items = (await listResp.json() as { items: Array<{ product_id: string; current_stock: number; status: string }> }).items
      const rowA = items.find(item => item.product_id === productA)!
      assert.equal(rowA.current_stock, -15)
      assert.equal(rowA.status, 'oversold')

      const movements = await movementsOf(productA)
      const last = movements[movements.length - 1]
      assert.equal(last.old_quantity, stockBefore)
      assert.equal(last.new_quantity, -15)
      assert.equal(last.delta, delta)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 9. Transaction rollback consistency — a mid-transaction failure must leave nothing
    // committed: no movement, no stock change, no audit entry, no feed advance, no partial
    // application across a multi-item cycle-count submit either.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      // 9a. A single-item adjustment referencing a product outside this store fails cleanly.
      const otherStore = randomUUID()
      await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Other','other-store',$2)", [otherStore, owner])
      const foreignProduct = randomUUID()
      await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-X','Foreign',500)`, [foreignProduct, otherStore])
      await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,10)', [otherStore, foreignProduct])

      const feedBefore = await feedPosition()
      const resp = await call('/inventory/adjust', managerToken, { method: 'POST', body: { store_id: store, product_id: foreignProduct, delta: 5, reason: 'received', note: 'Should never apply.', operation_id: randomUUID() } })
      assert.equal(resp.status, 422)
      assert.equal(await feedPosition(), feedBefore, 'a rejected adjustment must not advance the store feed position')
      assert.equal((await database.query('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [otherStore, foreignProduct])).rows[0].current_stock, 10)

      // 9b. Multi-item cycle-count submit: submitCycleCount processes items `order by product_id`,
      // so to genuinely prove atomicity (not just that a request that never applied anything got
      // rejected) the product that gets a real variance applied and later checked for a leaked
      // write MUST be the one that sorts first — a random UUID doesn't guarantee productA < productB,
      // so sort them explicitly here rather than assuming it. Deleting the second-sorting one's
      // stock row (simulating an unlikely concurrent product removal) fails its lock partway
      // through the loop, after the first-sorting one's variance has already been written — proving
      // the whole submit is one atomic unit, not a sequence of independent per-item commits.
      const [firstProduct, secondProduct] = [productA, productB].sort()
      const startResp = await call('/inventory/cycle-counts', managerToken, { method: 'POST', body: { store_id: store, product_ids: [productA, productB] } })
      assert.equal(startResp.status, 201)
      const session = await startResp.json() as { id: string; items: Array<{ id: string; product_id: string }> }
      const firstItem = session.items.find(item => item.product_id === firstProduct)!
      const secondItem = session.items.find(item => item.product_id === secondProduct)!
      // Give the first-sorting product a real variance (whatever its current stock is, count one
      // fewer) and the second-sorting one a real variance too, so if partial application happened
      // it would be visible on the one we check — then break the second one's row before submit.
      const firstLiveBeforeCount = await stockOf(firstProduct)
      assert.equal((await call(`/inventory/cycle-counts/${session.id}/items/${firstItem.id}`, managerToken, { method: 'PATCH', body: { store_id: store, counted_quantity: Math.max(firstLiveBeforeCount - 1, 0) } })).status, 200)
      assert.equal((await call(`/inventory/cycle-counts/${session.id}/items/${secondItem.id}`, managerToken, { method: 'PATCH', body: { store_id: store, counted_quantity: 5 } })).status, 200)
      const secondStockBeforeDelete = await stockOf(secondProduct)
      await database.query('delete from public.pos_stock where store_id=$1 and product_id=$2', [store, secondProduct])

      const firstStockBefore = await stockOf(firstProduct)
      const firstMovementsBefore = (await movementsOf(firstProduct)).length
      const feedBeforeSubmit = await feedPosition()
      const submitResp = await call(`/inventory/cycle-counts/${session.id}/submit`, managerToken, { method: 'POST', body: { store_id: store } })
      assert.equal(submitResp.status, 422, 'submit must fail once a counted product cannot be locked')

      assert.equal(await stockOf(firstProduct), firstStockBefore, 'the first-processed product must be untouched — the whole submit rolled back even though its own write would have succeeded')
      assert.equal((await movementsOf(firstProduct)).length, firstMovementsBefore)
      assert.equal(await feedPosition(), feedBeforeSubmit)
      const sessionAfter = await database.query<{ status: string }>('select status from public.pos_cycle_counts where id=$1', [session.id])
      assert.equal(sessionAfter.rows[0].status, 'open', 'a rolled-back submit must leave the session open, not partially submitted')

      // Restore the second product's stock row to its pre-deletion value so later assertions about
      // productA/productB in this test see a consistent state, and cancel the broken session so it
      // doesn't linger as "open" for the rest of the test.
      await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,$3)', [store, secondProduct, secondStockBeforeDelete])
      assert.equal((await call(`/inventory/cycle-counts/${session.id}/cancel`, managerToken, { method: 'POST', body: { store_id: store } })).status, 200)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 3 & 4. Cycle count: zero variance creates no movement; a real variance creates exactly one.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const aStock = await stockOf(productA)   // -15 going in
      const bStock = await stockOf(productB)   // 20 going in
      const startResp = await call('/inventory/cycle-counts', managerToken, { method: 'POST', body: { store_id: store, product_ids: [productA, productB], note: 'Weekly count' } })
      const session = await startResp.json() as { id: string; items: Array<{ id: string; product_id: string; expected_quantity: number }> }
      const itemA = session.items.find(item => item.product_id === productA)!
      const itemB = session.items.find(item => item.product_id === productB)!
      assert.equal(itemA.expected_quantity, aStock)
      assert.equal(itemB.expected_quantity, bStock)

      // Count A exactly matching live stock (no variance) and B with a real shortfall.
      const previewA = await call(`/inventory/cycle-counts/${session.id}/items/${itemA.id}`, managerToken, { method: 'PATCH', body: { store_id: store, counted_quantity: Math.max(aStock, 0) } })
      // aStock is negative (-15); counted_quantity must be a non-negative integer, so a real
      // counter physically counts 0 items on the shelf — variance_preview then correctly reports
      // the gap between the physical count (0) and the -15 the ledger shows as still "owed".
      assert.equal(previewA.status, 200)
      const previewAJson = await previewA.json() as { variance_preview: number }
      assert.equal(previewAJson.variance_preview, 0 - aStock)

      await call(`/inventory/cycle-counts/${session.id}/items/${itemB.id}`, managerToken, { method: 'PATCH', body: { store_id: store, counted_quantity: bStock - 3 } })

      const feedBefore = await feedPosition()
      const submitResp = await call(`/inventory/cycle-counts/${session.id}/submit`, managerToken, { method: 'POST', body: { store_id: store } })
      assert.equal(submitResp.status, 200)
      const result = await submitResp.json() as { adjusted: Array<{ product_id: string; old_quantity: number; new_quantity: number; delta: number }>; unchanged_count: number }

      if (aStock === 0) {
        // (Only true if a prior scenario left A at exactly 0 — not the case here, aStock is -15.)
        assert.equal(result.unchanged_count, 1)
      } else {
        // A's physical count (0) differs from the ledger's -15, so it DOES vary and gets adjusted
        // back up to 0 — proving cycle counts correct oversold stock the same as any other variance.
        assert.ok(result.adjusted.some(item => item.product_id === productA))
      }
      const adjustedB = result.adjusted.find(item => item.product_id === productB)
      assert.ok(adjustedB, 'product B had a real variance and must appear in adjusted[]')
      assert.equal(adjustedB!.old_quantity, bStock)
      assert.equal(adjustedB!.new_quantity, bStock - 3)
      assert.equal(adjustedB!.delta, -3)
      assert.equal(await stockOf(productB), bStock - 3)
      assert.equal(await feedPosition(), feedBefore + BigInt(result.adjusted.length), 'exactly one feed entry per adjusted item, none for unchanged ones')

      const bMovements = await movementsOf(productB)
      const cycleMovement = bMovements.find(m => m.reason === 'cycle_count')!
      assert.equal(cycleMovement.cycle_count_id, session.id)
      assert.equal(cycleMovement.old_quantity, bStock)
      assert.equal(cycleMovement.new_quantity, bStock - 3)

      const sessionAfter = await database.query<{ status: string }>('select status from public.pos_cycle_counts where id=$1', [session.id])
      assert.equal(sessionAfter.rows[0].status, 'submitted')

      // Now a dedicated true zero-variance case: fresh session over B alone, counted exactly at
      // its current (just-updated) stock — must produce zero movements and zero feed advance.
      const bNow = await stockOf(productB)
      const zeroSession = await (await call('/inventory/cycle-counts', managerToken, { method: 'POST', body: { store_id: store, product_ids: [productB] } })).json() as { id: string; items: Array<{ id: string; product_id: string }> }
      const zeroItem = zeroSession.items[0]
      await call(`/inventory/cycle-counts/${zeroSession.id}/items/${zeroItem.id}`, managerToken, { method: 'PATCH', body: { store_id: store, counted_quantity: bNow } })
      const bMovementCountBefore = (await movementsOf(productB)).length
      const feedBeforeZero = await feedPosition()
      const zeroSubmit = await call(`/inventory/cycle-counts/${zeroSession.id}/submit`, managerToken, { method: 'POST', body: { store_id: store } })
      assert.equal(zeroSubmit.status, 200)
      const zeroResult = await zeroSubmit.json() as { adjusted: unknown[]; unchanged_count: number }
      assert.equal(zeroResult.adjusted.length, 0, 'zero variance must not create a movement')
      assert.equal(zeroResult.unchanged_count, 1)
      assert.equal(await stockOf(productB), bNow)
      assert.equal((await movementsOf(productB)).length, bMovementCountBefore, 'no new ledger row for the zero-variance item')
      assert.equal(await feedPosition(), feedBeforeZero, 'no change-feed entry for a zero-variance submit')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // Live re-read vs. stale snapshot — submitCycleCount's headline correctness guarantee is that
    // it compares each counted quantity against LIVE pos_stock re-read under lock at submit time,
    // never the expected_quantity snapshot taken when the session started. Every other cycle-count
    // scenario above submits with no intervening stock change, so live and snapshot are always
    // equal there and a (bugged) implementation comparing against the snapshot would pass them
    // identically. This scenario changes live stock AFTER the snapshot is taken, so the two
    // possible implementations diverge and only the correct one passes.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const liveAtStart = await stockOf(productB)
      const startResp = await call('/inventory/cycle-counts', managerToken, { method: 'POST', body: { store_id: store, product_ids: [productB] } })
      const session = await startResp.json() as { id: string; items: Array<{ id: string; product_id: string; expected_quantity: number }> }
      const item = session.items[0]
      assert.equal(item.expected_quantity, liveAtStart, 'the snapshot must equal live stock at session-start time')

      // A sale (or another adjustment) changes live stock AFTER the snapshot was taken, while the
      // count is still in progress — the exact scenario the snapshot-vs-live distinction exists for.
      const liveAtSubmit = liveAtStart - 6
      await database.query('update public.pos_stock set current_stock=$1 where store_id=$2 and product_id=$3', [liveAtSubmit, store, productB])

      // Count exactly the STALE snapshot value (liveAtStart), which now differs from live stock —
      // a live-re-read implementation must treat this as a real variance against liveAtSubmit.
      await call(`/inventory/cycle-counts/${session.id}/items/${item.id}`, managerToken, { method: 'PATCH', body: { store_id: store, counted_quantity: liveAtStart } })
      const submitResp = await call(`/inventory/cycle-counts/${session.id}/submit`, managerToken, { method: 'POST', body: { store_id: store } })
      assert.equal(submitResp.status, 200)
      const result = await submitResp.json() as { adjusted: AdjustResult[]; unchanged_count: number }
      assert.equal(result.unchanged_count, 0, 'counting the stale snapshot value must NOT be treated as unchanged — live stock had moved')
      assert.equal(result.adjusted.length, 1)
      assert.equal(result.adjusted[0].old_quantity, liveAtSubmit, 'the movement\'s old_quantity must be the live value at submit time, not the session-start snapshot')
      assert.equal(result.adjusted[0].new_quantity, liveAtStart)
      assert.equal(await stockOf(productB), liveAtStart)

      // Mirror case: counting the CURRENT live value (which now differs from the stale snapshot)
      // must be treated as unchanged — proves the comparison isn't silently using the snapshot either.
      const liveNow = await stockOf(productB)
      const secondSession = await (await call('/inventory/cycle-counts', managerToken, { method: 'POST', body: { store_id: store, product_ids: [productB] } })).json() as { id: string; items: Array<{ id: string; product_id: string; expected_quantity: number }> }
      const secondItem = secondSession.items[0]
      await database.query('update public.pos_stock set current_stock=$1 where store_id=$2 and product_id=$3', [liveNow - 9, store, productB])
      // secondItem.expected_quantity is now stale too (captured before the line above); count the
      // CURRENT live value directly, bypassing the stale snapshot entirely.
      await call(`/inventory/cycle-counts/${secondSession.id}/items/${secondItem.id}`, managerToken, { method: 'PATCH', body: { store_id: store, counted_quantity: liveNow - 9 } })
      const secondSubmit = await call(`/inventory/cycle-counts/${secondSession.id}/submit`, managerToken, { method: 'POST', body: { store_id: store } })
      assert.equal(secondSubmit.status, 200)
      const secondResult = await secondSubmit.json() as { adjusted: unknown[]; unchanged_count: number }
      assert.equal(secondResult.adjusted.length, 0, 'counting the current live value must produce zero movements even though it differs from the stale snapshot')
      assert.equal(secondResult.unchanged_count, 1)
      assert.equal(await stockOf(productB), liveNow - 9)
    }

    // A cashier cannot record counts or submit/cancel an existing session either (RBAC applies to
    // every cycle-count endpoint, not just creation).
    {
      const anotherSession = await (await call('/inventory/cycle-counts', managerToken, { method: 'POST', body: { store_id: store, product_ids: [productA] } })).json() as { id: string; items: Array<{ id: string }> }
      const item = anotherSession.items[0]
      assert.equal((await call(`/inventory/cycle-counts/${anotherSession.id}/items/${item.id}`, cashierToken, { method: 'PATCH', body: { store_id: store, counted_quantity: 1 } })).status, 403)
      assert.equal((await call(`/inventory/cycle-counts/${anotherSession.id}/submit`, cashierToken, { method: 'POST', body: { store_id: store } })).status, 403)
      assert.equal((await call(`/inventory/cycle-counts/${anotherSession.id}/cancel`, cashierToken, { method: 'POST', body: { store_id: store } })).status, 403)
      // Clean up so it doesn't affect anything below.
      assert.equal((await call(`/inventory/cycle-counts/${anotherSession.id}/cancel`, managerToken, { method: 'POST', body: { store_id: store } })).status, 200)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 5. Persistence across a normal catalog refresh — GET /catalog/snapshot (the same endpoint
    // the offline-first client calls on every refresh) must reflect the manually adjusted stock,
    // not revert it. It reads pos_stock directly, so this also proves the adjustment endpoint
    // wrote through to the one authoritative table the rest of the app already trusts.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const adjustResp = await call('/inventory/adjust', ownerToken, { method: 'POST', body: { store_id: store, product_id: productA, delta: 100, reason: 'correction', note: 'Reconciled against a fresh physical count.', operation_id: randomUUID() } })
      const adjusted = await adjustResp.json() as { new_quantity: number }
      const snapshotResp = await call(`/catalog/snapshot?store_id=${store}`, ownerToken)
      assert.equal(snapshotResp.status, 200)
      const snapshot = await snapshotResp.json() as { stock: Array<{ product_id: string; current_stock: number }> }
      const stockRow = snapshot.stock.find(row => row.product_id === productA)!
      assert.equal(stockRow.current_stock, adjusted.new_quantity, 'a catalog refresh must show the adjusted stock, never the pre-adjustment value')
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 6. Multi-terminal sync via the existing change feed — this is the exact mechanism another
    // terminal's periodic loadCatalog() poll relies on; already exercised implicitly above, but
    // asserted directly here: every accepted stock-changing call advances pos_sync_feed_state and
    // appends a matching pos_change_feed row a second terminal could read.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const feedBefore = await feedPosition()
      const resp = await call('/inventory/adjust', managerToken, { method: 'POST', body: { store_id: store, product_id: productB, delta: 1, reason: 'received', note: 'Sync check.', operation_id: randomUUID() } })
      const body = await resp.json() as { new_quantity: number }
      const feedAfter = await feedPosition()
      assert.equal(feedAfter, feedBefore + 1n)
      const feedRow = await database.query('select store_id, position, entity_type, entity_id, payload from public.pos_change_feed where store_id=$1 and position=$2', [store, feedAfter.toString()])
      assert.equal(feedRow.rows.length, 1)
      assert.equal(feedRow.rows[0].entity_type, 'stock')
      assert.equal(feedRow.rows[0].entity_id, productB)
      assert.equal((feedRow.rows[0].payload as { current_stock: number }).current_stock, body.new_quantity)
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════
    // 10. Existing checkout + refund regression — Phase 2's additive migration and shared
    // pos_inventory_movements/pos_stock/pos_change_feed tables must not have broken the existing
    // sale/refund write paths. Runs a normal owner-authenticated checkout push() and a refund()
    // against a fresh product, confirming both still behave exactly as before Phase 2.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    {
      const checkoutProduct = randomUUID()
      await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-CHECKOUT','Checkout Regression Item',500)`, [checkoutProduct, store])
      await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,10)', [store, checkoutProduct])

      const operationId = randomUUID(), itemId = randomUUID(), paymentId = randomUUID()
      const checkoutBody = {
        operation_id: operationId,
        order: { id: operationId, store_id: store, receipt_number: 'INV-REG-000001', catalog_version: 1,
          client_generated_at: new Date().toISOString(), subtotal_cents: 1500, discount_cents: 0, tax_cents: 0, total_cents: 1500,
          customer_id: null, employee_id: null, manager_id: null, manager_approved_at: null },
        items: [{ id: itemId, product_id: checkoutProduct, snapshot_name: 'Checkout Regression Item', snapshot_sku: 'SKU-CHECKOUT',
          snapshot_price_cents: 500, snapshot_tax_bps: 0, catalog_version: 1, quantity: 3,
          discount_kind: null, discount_value: null, subtotal_cents: 1500, discount_applied_cents: 0, taxable_cents: 1500, tax_cents: 0, total_cents: 1500 }],
        payment: { id: paymentId, method: 'cash', amount_cents: 1500, tendered_cents: 1500, change_cents: 0, reference: null },
      }
      const pushResp = await call('/orders/push', ownerToken, { method: 'POST', body: checkoutBody })
      assert.equal(pushResp.status, 200)
      assert.equal(await stockOf(checkoutProduct), 7, 'checkout must still decrement stock exactly as before Phase 2')
      const saleMovement = (await movementsOf(checkoutProduct)).find(m => m.reason === 'sale')!
      assert.equal(saleMovement.delta, -3)
      // Phase 2 columns are additive and nullable — a sale movement must not be forced to carry them.
      assert.equal(saleMovement.old_quantity, null)
      assert.equal(saleMovement.new_quantity, null)
      assert.equal(saleMovement.actor_id, null)

      const refundResp = await call(`/orders/${operationId}/refund`, ownerToken, { method: 'POST', body: { store_id: store, reason: 'Regression test refund' } })
      assert.equal(refundResp.status, 201)
      assert.equal(await stockOf(checkoutProduct), 10, 'refund must still restore stock exactly as before Phase 2')
      const refundMovement = (await movementsOf(checkoutProduct)).find(m => m.reason === 'refund')!
      assert.equal(refundMovement.delta, 3)
    }
  } finally {
    server?.closeAllConnections(); server?.close()
    identityServer?.closeAllConnections?.(); identityServer?.close()
    await database.close()
    await db.end()
  }
})
