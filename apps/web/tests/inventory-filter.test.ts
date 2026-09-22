import test from 'node:test'
import assert from 'node:assert/strict'
import { inventoryStatus, matchesInventoryFilters } from '../src/screens/inventory-filter.ts'

const rows = [
  { name: 'Ceramic Mug', sku: 'MUG-001', barcode: '111', category_id: 'home', current_stock: 12, low_stock_threshold: 5 },
  { name: 'Canvas Tote', sku: 'TOTE-002', barcode: '222', category_id: 'bags', current_stock: 2, low_stock_threshold: 5 },
  { name: 'Tea Blend', sku: 'TEA-003', barcode: null, category_id: 'food', current_stock: 0, low_stock_threshold: 3 },
]

test('inventory search matches name, SKU and barcode case-insensitively', () => {
  assert.deepEqual(rows.filter(row => matchesInventoryFilters(row, 'mug', 'all', 'all')).map(row => row.sku), ['MUG-001'])
  assert.deepEqual(rows.filter(row => matchesInventoryFilters(row, 'tote-002', 'all', 'all')).map(row => row.sku), ['TOTE-002'])
  assert.deepEqual(rows.filter(row => matchesInventoryFilters(row, '111', 'all', 'all')).map(row => row.sku), ['MUG-001'])
})

test('inventory state filters derive their value from current stock and threshold', () => {
  assert.equal(inventoryStatus(12, 5), 'normal')
  assert.equal(inventoryStatus(2, 5), 'low')
  assert.equal(inventoryStatus(0, 5), 'out')
  assert.deepEqual(rows.filter(row => matchesInventoryFilters(row, '', 'all', 'low')).map(row => row.sku), ['TOTE-002'])
})
