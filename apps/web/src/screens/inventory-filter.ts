export type InventoryStatus = 'normal' | 'low' | 'out' | 'oversold'

export interface FilterableInventoryRow {
  name: string
  sku: string
  barcode: string | null
  category_id: string | null
  current_stock: number
  low_stock_threshold: number
}

export function inventoryStatus(currentStock: number, lowStockThreshold: number): InventoryStatus {
  if (currentStock < 0) return 'oversold'
  if (currentStock === 0) return 'out'
  if (currentStock <= lowStockThreshold) return 'low'
  return 'normal'
}

export function matchesInventoryFilters(
  item: FilterableInventoryRow,
  query: string,
  category: string,
  state: 'all' | InventoryStatus,
): boolean {
  if (category !== 'all' && item.category_id !== category) return false
  if (state !== 'all' && inventoryStatus(item.current_stock, item.low_stock_threshold) !== state) return false
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [item.name, item.sku, item.barcode ?? ''].some(value => value.toLocaleLowerCase().includes(normalized))
}
