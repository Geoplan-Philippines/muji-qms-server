-- Replace the global unique on order_number with a PARTIAL unique index scoped to
-- (store_id, order_number) over ACTIVE statuses only. SERVED and CANCELLED are
-- terminal/history, so an order number becomes reusable once the previous order
-- leaves the active set.

-- DropIndex
DROP INDEX "orders_order_number_key";

-- CreateIndex (partial unique: only one active order per (store, number))
CREATE UNIQUE INDEX "uniq_active_order_number"
  ON "orders" ("store_id", "order_number")
  WHERE "order_status" IN ('PREPARING', 'ON_HOLD');
