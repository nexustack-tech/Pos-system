/**
 * InventoryScreen — Owner / Manager Backoffice (Phase 2: Inventory Operations)
 *
 * Extends the Product Catalog screen's design language and fetch/auth patterns
 * (see ProductCatalogScreen.tsx) with:
 *   - a live inventory table (stock, 4-state pill incl. oversold/negative, inline
 *     low-stock threshold editing, per-product movement history)
 *   - manual stock adjustments (POST /inventory/adjust)
 *   - a cycle-count workflow as a second "mode" of this same screen (start ->
 *     count -> review -> submit / cancel), resumable across a page refresh via
 *     a `cycle_count` URL query param.
 *
 * Online-only by design: adjustments and cycle-count mutations are never queued
 * offline (that would touch posDb.outbox / posDb.stock_adjustments, which belong
 * exclusively to the existing offline checkout overlay). When offline, mutating
 * actions are disabled with an inline message instead.
 *
 * After every successful mutation, the authoritative server response (never a
 * client-computed number) is projected into posDb.server_stock so the change is
 * visible immediately here and on every other screen that reads it, without
 * waiting for the periodic sync poll.
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { formatCents } from '../../../../packages/domain/src/money'
import { posDb } from '../lib/db'
import { activeStoreId, accessToken, configuredApiUrl } from '../lib/catalog'
import { resolveFinancialAccess } from '../lib/management-access'
import { inventoryStatus as computeStatus, matchesInventoryFilters, type InventoryStatus } from './inventory-filter'
import './product-catalog.css'
import './inventory.css'

// ---------------------------------------------------------------------------
// Types mirroring apps/api/src/routes/inventory.ts exactly (the authoritative
// contract). Not imported directly since the frontend build does not depend on
// the API package's source.
// ---------------------------------------------------------------------------

interface InventoryRow {
  product_id: string
  name: string
  sku: string
  barcode: string | null
  category_id: string | null
  category_name: string | null
  unit_price_cents: string
  current_stock: number
  low_stock_threshold: number
  status: InventoryStatus
}

interface MovementRow {
  id: string
  product_id: string
  product_name: string | null
  delta: number
  reason: string
  adjustment_reason: string | null
  note: string | null
  old_quantity: number | null
  new_quantity: number | null
  actor_name: string | null
  cycle_count_id: string | null
  server_received_at: string
}

interface AdjustResult {
  product_id: string
  old_quantity: number
  new_quantity: number
  delta: number
  movement_id: string
}

interface CycleCountItem {
  id: string
  product_id: string
  product_name: string
  sku: string
  expected_quantity: number
  counted_quantity: number | null
  counted_at: string | null
}

interface CycleCountSession {
  id: string
  status: 'open' | 'submitted' | 'cancelled'
  started_at: string
  submitted_at: string | null
  note: string | null
  items: CycleCountItem[]
}

interface SubmitResult {
  adjusted: AdjustResult[]
  unchanged_count: number
}

const ADJUSTMENT_REASONS = ['damaged', 'expired', 'lost', 'received', 'correction', 'other'] as const
type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]

const REASON_LABEL: Record<string, string> = {
  damaged: 'Damaged', expired: 'Expired', lost: 'Lost', received: 'Received', correction: 'Correction', other: 'Other',
}

const STATE_LABEL: Record<'all' | InventoryStatus, string> = {
  all: 'All', normal: 'Normal', low: 'Low', out: 'Out', oversold: 'Oversold',
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Mirrors apps/api/src/lib/stockable.ts's inventoryStatus() exactly, so a
 * locally-applied mutation (adjust / cycle-count submit / threshold change) can
 * recompute a row's pill state without a full refetch. */
function pillInfo(status: InventoryStatus): { cls: string; label: string } {
  if (status === 'normal') return { cls: 'in', label: 'In Stock' }
  if (status === 'low') return { cls: 'low', label: 'Low Stock' }
  if (status === 'out') return { cls: 'out', label: 'Out of Stock' }
  return { cls: 'oversold', label: 'Oversold' }
}

function movementLabel(m: MovementRow): string {
  if (m.reason === 'manual_adjustment') {
    return `Adjustment${m.adjustment_reason ? ` — ${REASON_LABEL[m.adjustment_reason] ?? m.adjustment_reason}` : ''}`
  }
  if (m.reason === 'cycle_count') return 'Cycle count'
  if (m.reason === 'sale') return 'Sale'
  if (m.reason === 'refund') return 'Refund'
  if (m.reason === 'opening_stock') return 'Opening stock'
  return m.reason
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** formatCents() throws on an unsafe/out-of-range value; guard the render so a
 * malformed price can never crash the whole screen. */
function safeFormatCents(raw: string, currency: string): string {
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000) return '—'
  return formatCents(n, currency)
}

// ---------------------------------------------------------------------------
// Fetch helpers — same auth/fetch pattern as ProductCatalogScreen.tsx.
// ---------------------------------------------------------------------------

async function apiGet<T>(path: string): Promise<T> {
  const token = await accessToken()
  const resp = await fetch(`${configuredApiUrl()}${path}`, {
    credentials: 'same-origin',
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = (await resp.json().catch(() => ({}))) as T & { message?: string }
  if (!resp.ok) throw new Error(data?.message ?? `Server error (${resp.status})`)
  return data
}

async function apiSend<T = unknown>(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<T> {
  const token = await accessToken()
  const resp = await fetch(`${configuredApiUrl()}${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const data = (await resp.json().catch(() => ({}))) as T & { message?: string }
  if (!resp.ok) throw new Error(data?.message ?? `Server error (${resp.status})`)
  return data
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function InventoryScreen() {
  const [access, setAccess] = useState<'loading' | 'granted' | 'denied'>('loading')
  const [accessErr, setAccessErr] = useState('')
  const [storeId, setStoreId] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [isOnline, setIsOnline] = useState(navigator.onLine)

  const [items, setItems] = useState<InventoryRow[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')

  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState('all')
  const [stateFilter, setStateFilter] = useState<'all' | InventoryStatus>('all')

  const [mode, setMode] = useState<'list' | 'cycle-count'>('list')
  const [allMovementsOpen, setAllMovementsOpen] = useState(false)
  const [drawer, setDrawer] = useState<{ row: InventoryRow; tab: 'adjust' | 'history' } | null>(null)

  const [editingThreshold, setEditingThreshold] = useState<{ productId: string; value: string } | null>(null)
  const [thresholdBusy, setThresholdBusy] = useState(false)
  const [thresholdErr, setThresholdErr] = useState('')

  const [searchParams, setSearchParams] = useSearchParams()

  // Cycle-count state
  const [session, setSession] = useState<CycleCountSession | null>(null)
  const [sessionLoading, setSessionLoading] = useState(false)
  const [sessionErr, setSessionErr] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sessionNote, setSessionNote] = useState('')
  const [startBusy, setStartBusy] = useState(false)
  const [startErr, setStartErr] = useState('')
  const [countInputs, setCountInputs] = useState<Record<string, string>>({})
  const [countBusy, setCountBusy] = useState<Record<string, boolean>>({})
  const [countErrs, setCountErrs] = useState<Record<string, string>>({})
  const [confirmingSubmit, setConfirmingSubmit] = useState(false)
  const [submitBusy, setSubmitBusy] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)

  // ── Bootstrap: store id + currency ──
  useEffect(() => {
    let live = true
    void activeStoreId()
      .then(async (id) => {
        if (!live) return
        setStoreId(id)
        const cfg = await posDb.store_config.get(id)
        if (cfg) setCurrency(cfg.currency)
      })
      .catch((e) => { if (live) setLoadErr(e instanceof Error ? e.message : 'Could not load store.') })
    return () => { live = false }
  }, [])

  // ── Access gate: owner/manager only ──
  useEffect(() => {
    let active = true
    void resolveFinancialAccess()
      .then(() => { if (active) setAccess('granted') })
      .catch((e) => {
        if (!active) return
        setAccess('denied')
        setAccessErr(e instanceof Error ? e.message : 'This page is available to store owners and managers only.')
      })
    return () => { active = false }
  }, [])

  // ── Online/offline reactivity ──
  useEffect(() => {
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const loadInventory = async (id: string) => {
    setLoading(true)
    setLoadErr('')
    try {
      if (!navigator.onLine) {
        const [products, categories, stock] = await Promise.all([
          posDb.products.where('store_id').equals(id).toArray(),
          posDb.categories.where('store_id').equals(id).toArray(),
          posDb.server_stock.toArray(),
        ])
        const categoryNames = new Map(categories.map(category => [category.id, category.name]))
        const stockByProduct = new Map(stock.map(row => [row.product_id, row.current_stock]))
        const cached: InventoryRow[] = products.map(product => {
          const current_stock = stockByProduct.get(product.id) ?? 0
          const low_stock_threshold = product.low_stock_threshold ?? 5
          return {
            product_id: product.id, name: product.name, sku: product.sku, barcode: product.barcode,
            category_id: product.category_id, category_name: product.category_id ? categoryNames.get(product.category_id) ?? null : null,
            unit_price_cents: String(product.unit_price_cents), current_stock, low_stock_threshold,
            status: computeStatus(current_stock, low_stock_threshold),
          }
        }).sort((a, b) => a.name.localeCompare(b.name))
        setItems(cached)
        return
      }
      const data = await apiGet<{ items: InventoryRow[] }>(`/inventory?store_id=${encodeURIComponent(id)}`)
      setItems(data.items)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Could not load inventory.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!storeId || access !== 'granted') return
    void loadInventory(storeId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, access])

  const clearCycleParam = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('cycle_count')
      return next
    }, { replace: true })
  }

  // ── Resume an in-progress cycle count from the URL (e.g. after a refresh) ──
  useEffect(() => {
    if (!storeId || access !== 'granted') return
    const cid = searchParams.get('cycle_count')
    if (!cid) return
    setMode('cycle-count')
    setSessionLoading(true)
    apiGet<CycleCountSession>(`/inventory/cycle-counts/${encodeURIComponent(cid)}?store_id=${encodeURIComponent(storeId)}`)
      .then((data) => {
        if (data.status === 'open') {
          setSession(data)
        } else {
          setSession(null)
          setNotice(data.status === 'submitted' ? 'That cycle count was already submitted.' : 'That cycle count was cancelled.')
          clearCycleParam()
        }
      })
      .catch((e) => {
        setSessionErr(e instanceof Error ? e.message : 'Could not load that cycle count.')
        clearCycleParam()
      })
      .finally(() => setSessionLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, access])

  // Seed the per-item counted-quantity text inputs whenever a (new) session loads.
  useEffect(() => {
    if (!session) { setCountInputs({}); return }
    const seed: Record<string, string> = {}
    for (const it of session.items) seed[it.id] = it.counted_quantity !== null ? String(it.counted_quantity) : ''
    setCountInputs(seed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id])

  const categories = useMemo(() => {
    const map = new Map<string, string>()
    for (const it of items ?? []) if (it.category_id && it.category_name) map.set(it.category_id, it.category_name)
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [items])

  const filtered = useMemo(() => {
    if (!items) return []
    return items.filter(it => matchesInventoryFilters(it, query, catFilter, stateFilter))
  }, [items, catFilter, stateFilter, query])

  const stateCounts = useMemo(() => {
    const c: Record<'all' | InventoryStatus, number> = { all: 0, normal: 0, low: 0, out: 0, oversold: 0 }
    for (const it of items ?? []) { c.all += 1; c[computeStatus(it.current_stock, it.low_stock_threshold)] += 1 }
    return c
  }, [items])

  const applyStockUpdate = (productId: string, newQuantity: number) => {
    setItems((prev) => prev?.map((it) => it.product_id === productId
      ? { ...it, current_stock: newQuantity, status: computeStatus(newQuantity, it.low_stock_threshold) }
      : it) ?? prev)
  }

  // ── Inline threshold editing ──
  const beginEditThreshold = (row: InventoryRow) => {
    setThresholdErr('')
    setEditingThreshold({ productId: row.product_id, value: String(row.low_stock_threshold) })
  }
  const cancelEditThreshold = () => { setEditingThreshold(null); setThresholdErr('') }
  const saveThreshold = async (row: InventoryRow) => {
    if (!editingThreshold) return
    const raw = editingThreshold.value.trim()
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) { setThresholdErr('Enter a whole number, 0 or more.'); return }
    if (n > 1_000_000) { setThresholdErr('Must be 1,000,000 or fewer.'); return }
    if (!isOnline) { setThresholdErr('Connect to the internet to update this threshold.'); return }
    setThresholdBusy(true)
    setThresholdErr('')
    try {
      const result = await apiSend<{ product_id: string; low_stock_threshold: number }>('PATCH', '/inventory/threshold', {
        store_id: storeId, product_id: row.product_id, low_stock_threshold: n,
      })
      setItems((prev) => prev?.map((it) => it.product_id === row.product_id
        ? { ...it, low_stock_threshold: result.low_stock_threshold, status: computeStatus(it.current_stock, result.low_stock_threshold) }
        : it) ?? prev)
      setEditingThreshold(null)
      setNotice(`Low-stock threshold for "${row.name}" set to ${result.low_stock_threshold}.`)
    } catch (e) {
      setThresholdErr(e instanceof Error ? e.message : 'Could not update threshold.')
    } finally {
      setThresholdBusy(false)
    }
  }

  // ── Cycle count: selection (start step) ──
  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const allFilteredSelected = filtered.length > 0 && filtered.every((it) => selected.has(it.product_id))
  const toggleSelectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) { for (const it of filtered) next.delete(it.product_id) }
      else { for (const it of filtered) next.add(it.product_id) }
      return next
    })
  }

  const startCycleCount = async () => {
    if (selected.size === 0) { setStartErr('Select at least one product to count.'); return }
    if (selected.size > 500) { setStartErr('Select 500 products or fewer.'); return }
    if (!isOnline) { setStartErr('Connect to the internet to start a cycle count.'); return }
    setStartBusy(true)
    setStartErr('')
    try {
      const created = await apiSend<CycleCountSession>('POST', '/inventory/cycle-counts', {
        store_id: storeId, product_ids: Array.from(selected), note: sessionNote.trim() || undefined,
      })
      setSession(created)
      setSelected(new Set())
      setSessionNote('')
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('cycle_count', created.id)
        return next
      }, { replace: true })
    } catch (e) {
      setStartErr(e instanceof Error ? e.message : 'Could not start the cycle count.')
    } finally {
      setStartBusy(false)
    }
  }

  // ── Cycle count: counting step ──
  const recordCount = async (item: CycleCountItem) => {
    if (!session) return
    const raw = (countInputs[item.id] ?? '').trim()
    if (raw === '') return
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) {
      setCountErrs((prev) => ({ ...prev, [item.id]: 'Enter a whole number, 0 or more.' }))
      return
    }
    if (!isOnline) {
      setCountErrs((prev) => ({ ...prev, [item.id]: 'Connect to the internet to record a count.' }))
      return
    }
    if (item.counted_quantity === n) return
    setCountBusy((prev) => ({ ...prev, [item.id]: true }))
    setCountErrs((prev) => ({ ...prev, [item.id]: '' }))
    try {
      const result = await apiSend<{ item_id: string; counted_quantity: number; expected_quantity: number; variance_preview: number }>(
        'PATCH',
        `/inventory/cycle-counts/${encodeURIComponent(session.id)}/items/${encodeURIComponent(item.id)}`,
        { store_id: storeId, counted_quantity: n },
      )
      setSession((prev) => prev ? {
        ...prev,
        items: prev.items.map((it) => it.id === item.id ? { ...it, counted_quantity: result.counted_quantity, counted_at: new Date().toISOString() } : it),
      } : prev)
    } catch (e) {
      setCountErrs((prev) => ({ ...prev, [item.id]: e instanceof Error ? e.message : 'Could not record this count.' }))
    } finally {
      setCountBusy((prev) => ({ ...prev, [item.id]: false }))
    }
  }

  const countSummary = useMemo(() => {
    if (!session) return { total: 0, counted: 0, adjusting: 0, unchanged: 0, remaining: 0 }
    let counted = 0, adjusting = 0, unchanged = 0
    for (const it of session.items) {
      if (it.counted_quantity === null) continue
      counted += 1
      if (it.counted_quantity !== it.expected_quantity) adjusting += 1
      else unchanged += 1
    }
    return { total: session.items.length, counted, adjusting, unchanged, remaining: session.items.length - counted }
  }, [session])

  const submitCycleCount = async () => {
    if (!session) return
    if (!isOnline) { setSubmitErr('Connect to the internet to submit this count.'); return }
    setSubmitBusy(true)
    setSubmitErr('')
    try {
      const result = await apiSend<SubmitResult>('POST', `/inventory/cycle-counts/${encodeURIComponent(session.id)}/submit`, { store_id: storeId })
      if (result.adjusted.length > 0) {
        await posDb.server_stock.bulkPut(result.adjusted.map((a) => ({ product_id: a.product_id, current_stock: a.new_quantity, updated_at: new Date().toISOString() })))
        for (const a of result.adjusted) applyStockUpdate(a.product_id, a.new_quantity)
      }
      setSubmitResult(result)
      setSession(null)
      setConfirmingSubmit(false)
      clearCycleParam()
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : 'Could not submit this cycle count.')
    } finally {
      setSubmitBusy(false)
    }
  }

  const cancelCycleCount = async () => {
    if (!session) return
    if (!isOnline) { setSessionErr('Connect to the internet to cancel this count.'); return }
    setCancelBusy(true)
    setSessionErr('')
    try {
      await apiSend('POST', `/inventory/cycle-counts/${encodeURIComponent(session.id)}/cancel`, { store_id: storeId })
      setSession(null)
      setNotice('Cycle count cancelled.')
      clearCycleParam()
    } catch (e) {
      setSessionErr(e instanceof Error ? e.message : 'Could not cancel this cycle count.')
    } finally {
      setCancelBusy(false)
    }
  }

  // ── Render ──

  if (access === 'loading') {
    return <div className="pc-page"><div className="inv-gate"><h2>Loading…</h2></div></div>
  }
  if (access === 'denied') {
    return (
      <div className="pc-page">
        <div className="inv-gate">
          <h2>Owners and managers only</h2>
          <p>{accessErr || 'This page is available to store owners and managers only.'}</p>
        </div>
      </div>
    )
  }

  const isLoading = items === null && !loadErr
  const cycleView: 'loading' | 'start' | 'count' | 'result' = sessionLoading ? 'loading' : submitResult ? 'result' : session ? 'count' : 'start'

  return (
    <div className="pc-page">
      <div className="pc-hero">
        <div>
          <p className="pc-breadcrumb">Store Workspace <span>/</span> Inventory</p>
          <h1 className="pc-title">Inventory operations.</h1>
          <p className="pc-subtitle">Track stock levels, adjust counts, and run cycle counts across your catalog.</p>
        </div>
        <div className="pc-actions">
          <div className="inv-mode-tabs">
            <button type="button" className={`inv-mode-tab ${mode === 'list' ? 'active' : ''}`} onClick={() => setMode('list')}>Inventory</button>
            <button type="button" className={`inv-mode-tab ${mode === 'cycle-count' ? 'active' : ''}`} onClick={() => setMode('cycle-count')}>Cycle count</button>
          </div>
          {mode === 'list' && (
            <>
              <button type="button" className="pc-btn-ghost" onClick={() => void loadInventory(storeId)} disabled={loading || !storeId || !isOnline}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
              <button type="button" className="pc-btn-ghost" onClick={() => setAllMovementsOpen(true)} disabled={!storeId}>
                All movements
              </button>
              <button type="button" className="pc-btn-primary" onClick={() => setMode('cycle-count')} disabled={!storeId}>
                Start cycle count
              </button>
            </>
          )}
        </div>
      </div>

      <div className="pc-content">
        {loadErr && (
          <div className="pc-alert error" role="alert">
            <span>{loadErr}</span>
            <button type="button" className="pc-alert-close" onClick={() => setLoadErr('')} aria-label="Dismiss">✕</button>
          </div>
        )}
        {notice && (
          <div className="pc-alert success" role="status">
            <span>{notice}</span>
            <button type="button" className="pc-alert-close" onClick={() => setNotice('')} aria-label="Dismiss">✕</button>
          </div>
        )}
        {thresholdErr && (
          <div className="pc-alert error" role="alert">
            <span>{thresholdErr}</span>
            <button type="button" className="pc-alert-close" onClick={() => setThresholdErr('')} aria-label="Dismiss">✕</button>
          </div>
        )}
        {!isOnline && (
          <div className="inv-offline-note">You're offline. Showing your last synchronized catalog — adjustments, movement history, and cycle counts require a connection.</div>
        )}

        {/* Search / category / state-filter toolbar — shared by the list table and the
            cycle-count product picker, since both browse the same inventory list. */}
        <div className="pc-toolbar">
          <div className="pc-search">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 10 13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              className="pc-search-input"
              type="search"
              placeholder="Search by name, SKU or barcode…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search products"
            />
            {query && <button type="button" className="pc-search-clear" onClick={() => setQuery('')} aria-label="Clear search">✕</button>}
          </div>
          <select className="pc-cat-select" value={catFilter} onChange={(e) => setCatFilter(e.target.value)} aria-label="Filter by category">
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="inv-state-filters" style={{ marginBottom: 18 }}>
          {(['all', 'normal', 'low', 'out', 'oversold'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={stateFilter === s} className={`inv-state-pill ${stateFilter === s ? 'active' : ''}`} onClick={() => setStateFilter(s)}>
              {STATE_LABEL[s]} <span className="count">{stateCounts[s]}</span>
            </button>
          ))}
          <span className="inv-filter-result" role="status" aria-live="polite">
            Showing {filtered.length} of {items?.length ?? 0} products
          </span>
        </div>

        {mode === 'list' && (
          <>
            {isLoading && (
              <div className="pc-table-wrap" aria-busy="true">
                <p style={{ padding: 48, textAlign: 'center', color: '#9e8f75', margin: 0 }}>Loading inventory…</p>
              </div>
            )}
            {!isLoading && filtered.length === 0 && (
              <div className="pc-state">
                <h2>{items && items.length > 0 ? 'No products match' : 'No products yet'}</h2>
                <p>{items && items.length > 0 ? 'Try adjusting your search or filters.' : 'Add products from the Product Catalog screen to start tracking inventory.'}</p>
              </div>
            )}
            {!isLoading && filtered.length > 0 && (
              <div className="pc-table-wrap" role="table" aria-label="Inventory">
                <div className="inv-thead" role="row">
                  <span>Product</span><span>Category</span><span>Price</span><span>Stock</span><span>Threshold</span><span>Actions</span>
                </div>
                {filtered.map((row) => {
                  const { cls, label } = pillInfo(row.status)
                  const catName = row.category_name ?? ''
                  const isEditing = editingThreshold?.productId === row.product_id
                  return (
                    <div key={row.product_id} className="inv-row" role="row">
                      <div className="inv-cell-name" role="cell">
                        <div className="pc-prod-name" title={row.name}>{row.name}</div>
                        <div className="pc-prod-sku">{row.sku}</div>
                      </div>
                      <div className="inv-cell" role="cell">
                        <span className={`pc-badge ${catName ? '' : 'empty'}`}>{catName || 'Unassigned'}</span>
                      </div>
                      <div className="inv-cell-price" role="cell">{safeFormatCents(row.unit_price_cents, currency)}</div>
                      <div className="inv-cell-stock" role="cell">
                        <span className={`pc-stock-pill ${cls}`}>
                          <span className={`pc-pill-dot ${cls}`} aria-hidden="true" />
                          {label}
                        </span>
                        <span className={`inv-stock-number ${row.current_stock < 0 ? 'negative' : ''}`}>{row.current_stock}</span>
                      </div>
                      <div className="inv-cell" role="cell">
                        {editingThreshold && isEditing ? (
                          <div className="inv-threshold-edit">
                            <input
                              type="number"
                              min={0}
                              step={1}
                              inputMode="numeric"
                              value={editingThreshold.value}
                              onChange={(e) => setEditingThreshold({ productId: row.product_id, value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveThreshold(row)
                                if (e.key === 'Escape') cancelEditThreshold()
                              }}
                              autoFocus
                            />
                            <button type="button" className="save" onClick={() => void saveThreshold(row)} disabled={thresholdBusy} aria-label="Save threshold">✓</button>
                            <button type="button" className="cancel" onClick={cancelEditThreshold} disabled={thresholdBusy} aria-label="Cancel edit">✕</button>
                          </div>
                        ) : (
                          <button type="button" className="inv-threshold-btn" onClick={() => beginEditThreshold(row)} title="Click to edit low-stock threshold">
                            {row.low_stock_threshold} ✎
                          </button>
                        )}
                      </div>
                      <div className="inv-cell-actions" role="cell">
                        <button type="button" className="inv-mini-btn" onClick={() => setDrawer({ row, tab: 'adjust' })}>Adjust</button>
                        <button type="button" className="inv-mini-btn" onClick={() => setDrawer({ row, tab: 'history' })}>History</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {mode === 'cycle-count' && cycleView === 'loading' && (
          <div className="pc-table-wrap"><p style={{ padding: 48, textAlign: 'center', color: '#9e8f75', margin: 0 }}>Loading cycle count…</p></div>
        )}

        {mode === 'cycle-count' && cycleView === 'start' && (
          <>
            {startErr && (
              <div className="pc-alert error" role="alert">
                <span>{startErr}</span>
                <button type="button" className="pc-alert-close" onClick={() => setStartErr('')} aria-label="Dismiss">✕</button>
              </div>
            )}
            {sessionErr && (
              <div className="pc-alert error" role="alert">
                <span>{sessionErr}</span>
                <button type="button" className="pc-alert-close" onClick={() => setSessionErr('')} aria-label="Dismiss">✕</button>
              </div>
            )}
            <div className="pc-group" style={{ marginBottom: 16 }}>
              <p className="pc-group-label">Session note <span className="pc-opt">optional</span></p>
              <textarea
                className="inv-textarea"
                value={sessionNote}
                maxLength={500}
                onChange={(e) => setSessionNote(e.target.value)}
                placeholder="e.g. Weekly cycle count — back stock room"
              />
            </div>
            {isLoading && <div className="pc-table-wrap"><p style={{ padding: 48, textAlign: 'center', color: '#9e8f75', margin: 0 }}>Loading products…</p></div>}
            {!isLoading && filtered.length === 0 && (
              <div className="pc-state"><h2>No products match</h2><p>Adjust your search or filters to find products to count.</p></div>
            )}
            {!isLoading && filtered.length > 0 && (
              <div className="pc-table-wrap">
                <div className="inv-select-bar">
                  <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAllFiltered} aria-label="Select all filtered products" />
                  <span>{selected.size} selected — select all {filtered.length} filtered product{filtered.length === 1 ? '' : 's'}</span>
                </div>
                {filtered.map((row) => (
                  <div key={row.product_id} className="inv-pick-row">
                    <input type="checkbox" checked={selected.has(row.product_id)} onChange={() => toggleSelected(row.product_id)} aria-label={`Select ${row.name}`} />
                    <div>
                      <div className="pc-prod-name">{row.name}</div>
                      <div className="pc-prod-sku">{row.sku}</div>
                    </div>
                    <div className="inv-cell">{row.category_name || 'Unassigned'}</div>
                    <div className="inv-cell">Current: {row.current_stock}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="pc-btn-primary" onClick={() => void startCycleCount()} disabled={startBusy || selected.size === 0 || !isOnline}>
                {startBusy ? 'Starting…' : `Begin count (${selected.size} product${selected.size === 1 ? '' : 's'})`}
              </button>
            </div>
          </>
        )}

        {mode === 'cycle-count' && cycleView === 'count' && session && (
          <>
            {sessionErr && (
              <div className="pc-alert error" role="alert">
                <span>{sessionErr}</span>
                <button type="button" className="pc-alert-close" onClick={() => setSessionErr('')} aria-label="Dismiss">✕</button>
              </div>
            )}
            {session.note && <p style={{ fontSize: 12, color: '#756f63', margin: '0 0 12px' }}>Note: {session.note}</p>}
            <div className="pc-table-wrap">
              <div className="inv-count-row" style={{ background: '#f3ede0' }}>
                <span style={{ fontWeight: 700, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.08em', color: '#9e8f75' }}>Product</span>
                <span style={{ fontWeight: 700, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.08em', color: '#9e8f75', textAlign: 'right' }}>Expected</span>
                <span style={{ fontWeight: 700, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.08em', color: '#9e8f75', textAlign: 'right' }}>Counted</span>
                <span style={{ fontWeight: 700, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.08em', color: '#9e8f75', textAlign: 'right' }}>Variance</span>
                <span style={{ fontWeight: 700, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.08em', color: '#9e8f75', textAlign: 'right' }}>Status</span>
              </div>
              {session.items.map((item) => {
                const variance = item.counted_quantity !== null ? item.counted_quantity - item.expected_quantity : null
                const varianceCls = variance === null ? '' : variance === 0 ? 'zero' : variance > 0 ? 'positive' : 'negative'
                return (
                  <div key={item.id} className={`inv-count-row ${item.counted_quantity !== null ? 'counted' : ''}`}>
                    <div>
                      <div className="pc-prod-name">{item.product_name}</div>
                      <div className="pc-prod-sku">{item.sku}</div>
                    </div>
                    <div className="inv-count-expected">{item.expected_quantity}</div>
                    <div className="inv-count-input-wrap">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1}
                        className="inv-count-input"
                        value={countInputs[item.id] ?? ''}
                        disabled={!isOnline || !!countBusy[item.id]}
                        onChange={(e) => setCountInputs((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        onBlur={() => void recordCount(item)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                        placeholder="—"
                      />
                    </div>
                    <div className={`inv-count-variance ${varianceCls}`}>{variance === null ? '—' : variance > 0 ? `+${variance}` : variance}</div>
                    <div className="inv-count-status">
                      {countBusy[item.id] ? 'Saving…' : countErrs[item.id] ? <span style={{ color: '#b34330' }}>{countErrs[item.id]}</span> : item.counted_quantity !== null ? 'Recorded' : 'Not counted'}
                    </div>
                  </div>
                )
              })}
              <div className="inv-summary-bar">
                <div className="inv-summary-stats">
                  <div className="inv-summary-stat"><span className="num">{countSummary.counted}</span><span className="lbl">Counted</span></div>
                  <div className="inv-summary-stat"><span className="num">{countSummary.unchanged}</span><span className="lbl">Unchanged</span></div>
                  <div className="inv-summary-stat"><span className="num">{countSummary.adjusting}</span><span className="lbl">Will adjust</span></div>
                  <div className="inv-summary-stat"><span className="num">{countSummary.remaining}</span><span className="lbl">Not counted</span></div>
                </div>
                <div className="inv-summary-actions">
                  <button type="button" className="pc-btn-ghost" onClick={() => void cancelCycleCount()} disabled={cancelBusy || !isOnline}>
                    {cancelBusy ? 'Cancelling…' : 'Cancel count'}
                  </button>
                  <button type="button" className="pc-btn-primary" onClick={() => setConfirmingSubmit(true)} disabled={countSummary.counted === 0 || !isOnline}>
                    Review & submit
                  </button>
                </div>
              </div>
            </div>

            {confirmingSubmit && (
              <div
                className="pc-overlay"
                role="dialog"
                aria-modal="true"
                aria-label="Confirm cycle count submission"
                onClick={(e) => { if (e.target === e.currentTarget && !submitBusy) setConfirmingSubmit(false) }}
              >
                <div className="pc-drawer" style={{ width: 'min(480px, 100vw)' }}>
                  <div className="pc-drawer-head">
                    <div className="pc-drawer-head-copy">
                      <p className="pc-drawer-eyebrow">Cycle count</p>
                      <h2 className="pc-drawer-title">Review before submitting</h2>
                    </div>
                    <button type="button" className="pc-drawer-close" onClick={() => setConfirmingSubmit(false)} aria-label="Close">✕</button>
                  </div>
                  <div className="pc-drawer-body">
                    {submitErr && (
                      <div className="pc-alert error" role="alert">
                        <span>{submitErr}</span>
                        <button type="button" className="pc-alert-close" onClick={() => setSubmitErr('')} aria-label="Dismiss">✕</button>
                      </div>
                    )}
                    <div className="inv-confirm-panel">
                      <h3>{countSummary.counted} of {countSummary.total} counted</h3>
                      <p>
                        {countSummary.unchanged} product{countSummary.unchanged === 1 ? '' : 's'} match{countSummary.unchanged === 1 ? 'es' : ''} the current stock —
                        no movement will be created for those. That's expected, not a limitation.
                      </p>
                      <p>{countSummary.adjusting} product{countSummary.adjusting === 1 ? '' : 's'} show a difference and will get a stock adjustment on submit.</p>
                      {countSummary.remaining > 0 && (
                        <p>{countSummary.remaining} product{countSummary.remaining === 1 ? '' : 's'} have not been counted yet and will be left as-is.</p>
                      )}
                      <p style={{ color: '#9e8f75', fontSize: 11 }}>
                        Final adjustments are computed against live stock at the moment of submission, so this preview may shift slightly if stock changed since you started counting.
                      </p>
                    </div>
                  </div>
                  <div className="pc-drawer-foot">
                    <button type="button" className="pc-submit" disabled={submitBusy || !isOnline} onClick={() => void submitCycleCount()}>
                      {submitBusy ? 'Submitting…' : 'Confirm & submit'}
                    </button>
                    <button type="button" className="pc-cancel" onClick={() => setConfirmingSubmit(false)} disabled={submitBusy}>Back to counting</button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {mode === 'cycle-count' && cycleView === 'result' && submitResult && (
          <div className="inv-confirm-panel">
            <h3>Cycle count submitted</h3>
            <div className="inv-result-summary">
              <p>{submitResult.adjusted.length} product{submitResult.adjusted.length === 1 ? '' : 's'} adjusted.</p>
              <p>{submitResult.unchanged_count} product{submitResult.unchanged_count === 1 ? '' : 's'} matched — no movement needed.</p>
            </div>
            {submitResult.adjusted.length > 0 && (
              <div className="pc-table-wrap">
                <div className="inv-adj-thead" role="row"><span>Product</span><span>Old → New</span><span>Delta</span></div>
                {submitResult.adjusted.map((a) => {
                  const row = items?.find((it) => it.product_id === a.product_id)
                  return (
                    <div key={a.movement_id} className="inv-adj-row" role="row">
                      <span className="inv-mv-product">{row?.name ?? a.product_id}</span>
                      <span>{a.old_quantity} → {a.new_quantity}</span>
                      <span className={`inv-mv-delta ${a.delta > 0 ? 'positive' : 'negative'}`}>{a.delta > 0 ? `+${a.delta}` : a.delta}</span>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="inv-confirm-actions">
              <button type="button" className="pc-btn-ghost" onClick={() => setSubmitResult(null)}>Start another count</button>
              <button type="button" className="pc-btn-primary" onClick={() => { setSubmitResult(null); setMode('list') }}>Back to inventory</button>
            </div>
          </div>
        )}
      </div>

      {drawer && (
        <ProductDrawer
          key={drawer.row.product_id}
          row={drawer.row}
          initialTab={drawer.tab}
          storeId={storeId}
          isOnline={isOnline}
          onClose={() => setDrawer(null)}
          onAdjusted={(result) => applyStockUpdate(result.product_id, result.new_quantity)}
        />
      )}
      {allMovementsOpen && <AllMovementsDrawer storeId={storeId} onClose={() => setAllMovementsOpen(false)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-product drawer: Adjust stock / History tabs.
// Keyed by product_id from the caller so switching products remounts this
// component and resets all of its local state automatically.
// ---------------------------------------------------------------------------

function ProductDrawer({
  row, initialTab, storeId, isOnline, onClose, onAdjusted,
}: {
  row: InventoryRow
  initialTab: 'adjust' | 'history'
  storeId: string
  isOnline: boolean
  onClose: () => void
  onAdjusted: (result: AdjustResult) => void
}) {
  const [tab, setTab] = useState<'adjust' | 'history'>(initialTab)
  const [current, setCurrent] = useState(row.current_stock)

  const [sign, setSign] = useState<'increase' | 'decrease'>('increase')
  const [magnitude, setMagnitude] = useState('')
  const [reason, setReason] = useState<AdjustmentReason | ''>('')
  const [note, setNote] = useState('')
  // Stable for the lifetime of one pending attempt: reused if the manager clicks Save again after
  // a failed/timed-out request (the API dedupes on this), and only replaced once a submit actually
  // succeeds, so the next distinct adjustment doesn't accidentally start pre-collided with this one.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID())
  const [errs, setErrs] = useState<{ magnitude?: string; reason?: string; note?: string }>({})
  const [busy, setBusy] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  const [lastResult, setLastResult] = useState<AdjustResult | null>(null)

  const [movements, setMovements] = useState<MovementRow[] | null>(null)
  const [mvErr, setMvErr] = useState('')
  const [mvLoading, setMvLoading] = useState(false)

  const loadMovements = () => {
    setMvLoading(true)
    setMvErr('')
    apiGet<{ items: MovementRow[] }>(`/inventory/movements?store_id=${encodeURIComponent(storeId)}&product_id=${encodeURIComponent(row.product_id)}&limit=50`)
      .then((data) => setMovements(data.items))
      .catch((e) => setMvErr(e instanceof Error ? e.message : 'Could not load movement history.'))
      .finally(() => setMvLoading(false))
  }

  useEffect(() => {
    if (tab === 'history' && movements === null) loadMovements()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const magnitudeNum = Number(magnitude)
  const validMagnitude = magnitude.trim() !== '' && Number.isInteger(magnitudeNum) && magnitudeNum > 0 && magnitudeNum <= 1_000_000
  const delta = validMagnitude ? (sign === 'increase' ? magnitudeNum : -magnitudeNum) : 0
  const resulting = current + delta

  const validate = (): typeof errs => {
    const e: typeof errs = {}
    if (magnitude.trim() === '' || !Number.isInteger(magnitudeNum) || magnitudeNum <= 0) e.magnitude = 'Enter a whole number greater than 0.'
    else if (magnitudeNum > 1_000_000) e.magnitude = 'Maximum adjustment is 1,000,000 units.'
    if (!reason) e.reason = 'Select a reason.'
    if (!note.trim()) e.note = 'A note is required for every adjustment.'
    else if (note.trim().length > 500) e.note = 'Max 500 characters.'
    return e
  }

  const submit = async () => {
    const fieldErrs = validate()
    if (Object.keys(fieldErrs).length) { setErrs(fieldErrs); return }
    if (!isOnline) { setSubmitErr('Connect to the internet to adjust stock.'); return }
    setBusy(true)
    setSubmitErr('')
    try {
      const result = await apiSend<AdjustResult>('POST', '/inventory/adjust', {
        store_id: storeId, product_id: row.product_id, delta, reason, note: note.trim(), operation_id: operationId,
      })
      await posDb.server_stock.put({ product_id: result.product_id, current_stock: result.new_quantity, updated_at: new Date().toISOString() })
      setCurrent(result.new_quantity)
      setLastResult(result)
      onAdjusted(result)
      setOperationId(crypto.randomUUID())
      setMagnitude('')
      setReason('')
      setNote('')
      setErrs({})
      setMovements(null)
      if (tab === 'history') loadMovements()
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : 'Could not save this adjustment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="pc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Inventory for ${row.name}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="pc-drawer">
        <div className="pc-drawer-head">
          <div className="pc-drawer-head-copy">
            <p className="pc-drawer-eyebrow">Inventory · {row.sku}</p>
            <h2 className="pc-drawer-title">{row.name}</h2>
          </div>
          <button type="button" className="pc-drawer-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="inv-drawer-tabs">
          <button type="button" className={`inv-drawer-tab ${tab === 'adjust' ? 'active' : ''}`} onClick={() => setTab('adjust')}>Adjust stock</button>
          <button type="button" className={`inv-drawer-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>History</button>
        </div>

        {tab === 'adjust' ? (
          <div className="pc-drawer-body">
            {submitErr && (
              <div className="pc-alert error" role="alert">
                <span>{submitErr}</span>
                <button type="button" className="pc-alert-close" onClick={() => setSubmitErr('')} aria-label="Dismiss">✕</button>
              </div>
            )}
            {lastResult && !submitErr && (
              <div className="pc-alert success" role="status">
                <span>Saved: {lastResult.old_quantity} → {lastResult.new_quantity}.</span>
                <button type="button" className="pc-alert-close" onClick={() => setLastResult(null)} aria-label="Dismiss">✕</button>
              </div>
            )}
            {!isOnline && <div className="inv-offline-note">Connect to the internet to adjust stock.</div>}

            <div className="inv-current-stock">
              <span className="inv-current-stock-label">Current stock</span>
              <span className={`inv-current-stock-value ${current < 0 ? 'negative' : ''}`}>{current}</span>
            </div>

            <div className="pc-group">
              <p className="pc-group-label">Adjustment</p>
              <div className="pc-field">
                <label>Change amount</label>
                <div className="inv-delta-control">
                  <div className="inv-sign-toggle">
                    <button type="button" className={`inv-sign-btn increase ${sign === 'increase' ? 'active' : ''}`} onClick={() => setSign('increase')} aria-pressed={sign === 'increase'}>+</button>
                    <button type="button" className={`inv-sign-btn decrease ${sign === 'decrease' ? 'active' : ''}`} onClick={() => setSign('decrease')} aria-pressed={sign === 'decrease'}>−</button>
                  </div>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    className={`inv-magnitude-input ${errs.magnitude ? 'err' : ''}`}
                    value={magnitude}
                    onChange={(e) => { setMagnitude(e.target.value); setErrs((prev) => ({ ...prev, magnitude: undefined })) }}
                    placeholder="0"
                  />
                </div>
                {errs.magnitude && <p className="pc-field-err">{errs.magnitude}</p>}
              </div>

              <div className="inv-result-preview">
                <span className="inv-result-label">Resulting stock</span>
                <span className={`inv-result-value ${resulting < 0 ? 'negative' : delta > 0 ? 'increase' : delta < 0 ? 'decrease' : ''}`}>
                  {validMagnitude ? resulting : current}
                </span>
              </div>

              <div className="pc-field">
                <label htmlFor="adj-reason">Reason</label>
                <select
                  id="adj-reason"
                  className={errs.reason ? 'err' : ''}
                  value={reason}
                  onChange={(e) => { setReason(e.target.value as AdjustmentReason | ''); setErrs((prev) => ({ ...prev, reason: undefined })) }}
                >
                  <option value="">Select a reason…</option>
                  {ADJUSTMENT_REASONS.map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
                </select>
                {errs.reason && <p className="pc-field-err">{errs.reason}</p>}
              </div>

              <div className="pc-field">
                <label htmlFor="adj-note">Note</label>
                <textarea
                  id="adj-note"
                  className={`inv-textarea ${errs.note ? 'err' : ''}`}
                  value={note}
                  maxLength={500}
                  onChange={(e) => { setNote(e.target.value); setErrs((prev) => ({ ...prev, note: undefined })) }}
                  placeholder="What happened? (required)"
                />
                <p className="inv-char-count">{note.length}/500</p>
                {errs.note && <p className="pc-field-err">{errs.note}</p>}
              </div>
            </div>
          </div>
        ) : (
          <div className="pc-drawer-body">
            {mvErr && (
              <div className="pc-alert error" role="alert">
                <span>{mvErr}</span>
                <button type="button" className="pc-alert-close" onClick={() => setMvErr('')} aria-label="Dismiss">✕</button>
              </div>
            )}
            <MovementsTable movements={movements} loading={mvLoading} showProduct={false} />
          </div>
        )}

        {tab === 'adjust' && (
          <div className="pc-drawer-foot">
            <button type="button" className="pc-submit" disabled={busy || !isOnline} onClick={() => void submit()}>
              {busy ? 'Saving…' : 'Save adjustment'}
            </button>
            <button type="button" className="pc-cancel" onClick={onClose} disabled={busy}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Store-wide "All movements" panel.
// ---------------------------------------------------------------------------

function AllMovementsDrawer({ storeId, onClose }: { storeId: string; onClose: () => void }) {
  const [movements, setMovements] = useState<MovementRow[] | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    apiGet<{ items: MovementRow[] }>(`/inventory/movements?store_id=${encodeURIComponent(storeId)}&limit=200`)
      .then((data) => { if (live) setMovements(data.items) })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : 'Could not load movement history.') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [storeId])

  return (
    <div className="pc-overlay" role="dialog" aria-modal="true" aria-label="All inventory movements" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pc-drawer" style={{ width: 'min(760px, 100vw)' }}>
        <div className="pc-drawer-head">
          <div className="pc-drawer-head-copy">
            <p className="pc-drawer-eyebrow">Inventory</p>
            <h2 className="pc-drawer-title">All movements</h2>
          </div>
          <button type="button" className="pc-drawer-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="pc-drawer-body">
          {err && (
            <div className="pc-alert error" role="alert">
              <span>{err}</span>
              <button type="button" className="pc-alert-close" onClick={() => setErr('')} aria-label="Dismiss">✕</button>
            </div>
          )}
          <MovementsTable movements={movements} loading={loading} showProduct />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared movements ledger table (per-product History tab and All-movements panel).
// ---------------------------------------------------------------------------

function MovementsTable({ movements, loading, showProduct }: { movements: MovementRow[] | null; loading: boolean; showProduct: boolean }) {
  if (loading && movements === null) return <p className="inv-mv-empty">Loading movement history…</p>
  if (!movements || movements.length === 0) return <p className="inv-mv-empty">No stock movements recorded yet.</p>
  return (
    <div className="pc-table-wrap">
      <div className={`inv-mv-thead ${showProduct ? 'with-product' : ''}`} role="row">
        {showProduct && <span>Product</span>}
        <span>Reason</span>
        <span>Delta</span>
        <span>Old → New</span>
        <span>Note</span>
        <span>When</span>
      </div>
      {movements.map((m) => {
        const deltaCls = m.delta > 0 ? 'positive' : m.delta < 0 ? 'negative' : ''
        return (
          <div key={m.id} className={`inv-mv-row ${showProduct ? 'with-product' : ''}`} role="row">
            {showProduct && <span className="inv-mv-product">{m.product_name ?? '—'}</span>}
            <span><span className="inv-mv-reason">{movementLabel(m)}</span></span>
            <span className={`inv-mv-delta ${deltaCls}`}>{m.delta > 0 ? `+${m.delta}` : m.delta}</span>
            <span>{m.old_quantity !== null && m.new_quantity !== null ? `${m.old_quantity} → ${m.new_quantity}` : '—'}</span>
            <span className="inv-mv-note" title={m.note ?? ''}>{m.note ?? '—'}{m.actor_name ? ` · ${m.actor_name}` : ''}</span>
            <span className="inv-mv-when">{formatWhen(m.server_received_at)}</span>
          </div>
        )
      })}
    </div>
  )
}
