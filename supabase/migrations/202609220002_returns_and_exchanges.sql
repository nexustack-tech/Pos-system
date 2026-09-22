-- Phase 2: partial returns and exchanges. These additions retain the original sale,
-- payment and receipt as immutable records; every return is its own append-only record.

-- A sale can have multiple partial returns. The previous unique key encoded the Phase 1
-- whole-order-only rule, so remove only that key while retaining the store-scoped primary link.
alter table public.pos_refunds
  drop constraint if exists pos_refunds_store_id_order_id_key;

alter table public.pos_refunds
  add column operation_id uuid,
  add column reason_code text check (reason_code is null or reason_code in
    ('damaged', 'customer_changed_mind', 'incorrect_item', 'pricing_error', 'other')),
  add column reason_note text check (reason_note is null or char_length(trim(reason_note)) between 1 and 500),
  add column payment_outcome text check (payment_outcome is null or payment_outcome in
    ('cash_refund', 'external_card_refund_confirmed', 'exchange_equal', 'exchange_customer_paid', 'exchange_store_owes')),
  add column external_reference text check (external_reference is null or char_length(trim(external_reference)) between 1 and 120),
  add column exchange_order_id uuid,
  add constraint pos_refunds_operation_unique unique (store_id, operation_id),
  add constraint pos_refunds_exchange_order_fkey foreign key (store_id, exchange_order_id)
    references public.pos_orders(store_id, id);

-- New return lines retain the exact allocation of every component of the original line.
-- Existing whole-order refunds remain valid with null allocations; they are immutable history.
alter table public.pos_refund_items
  add column restock_quantity integer check (restock_quantity is null or (restock_quantity >= 0 and restock_quantity <= quantity)),
  add column subtotal_cents bigint check (subtotal_cents is null or subtotal_cents between 0 and 1000000000),
  add column discount_cents bigint check (discount_cents is null or discount_cents between 0 and 1000000000),
  add column tax_cents bigint check (tax_cents is null or tax_cents between 0 and 1000000000);

create index pos_refund_items_by_original_line on public.pos_refund_items(store_id, order_item_id);
create index pos_refunds_by_exchange_order on public.pos_refunds(store_id, exchange_order_id) where exchange_order_id is not null;

-- Audit records need structured, immutable return evidence in addition to the concise target
-- users see in the activity feed. Null preserves historical audit entries.
alter table public.audit_log
  add column details jsonb;
