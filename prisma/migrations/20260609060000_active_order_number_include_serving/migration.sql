-- SERVING (now-serving / still on the board) must hold the order number too.
-- Recreate the partial unique index to include it, matching the frontend lifecycle.
-- SERVED (collected) and CANCELLED stay terminal and free the number for reuse.

-- DropIndex
DROP INDEX "uniq_active_order_number";

-- CreateIndex
CREATE UNIQUE INDEX "uniq_active_order_number"
  ON "orders" ("store_id", "order_number")
  WHERE "order_status" IN ('PREPARING', 'SERVING', 'ON_HOLD');
