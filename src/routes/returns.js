import express from 'express';
import { query, tx } from '../db/index.js';
import { asyncHandler, badRequest, notFound, buildRMANumber } from '../utils/helpers.js';
import { requireAuth } from '../middleware/auth.js';
import { canReturnOrder } from '../utils/returns.js';
import { sendEmail, emailTemplates } from '../utils/email.js';

const router = express.Router();

const VALID_RESOLUTIONS = ['refund', 'store_credit', 'exchange'];

// POST /api/returns
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { order_id, items, customer_note, resolution } = req.body;

  if (!VALID_RESOLUTIONS.includes(resolution))
    throw badRequest('resolution must be one of: refund, store_credit, exchange');
  if (!Array.isArray(items) || items.length === 0)
    throw badRequest('At least one item is required');

  // Verify order belongs to this user
  const { rows: [order] } = await query(
    'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
    [order_id, req.user.id]
  );
  if (!order) throw notFound('Order');

  // Check 30-day eligibility
  const eligibility = await canReturnOrder(order);
  if (!eligibility.eligible) throw badRequest(eligibility.reason);

  // Fetch all order_items and build lookup map
  const { rows: orderItems } = await query(
    'SELECT * FROM order_items WHERE order_id = $1',
    [order_id]
  );
  const orderItemMap = Object.fromEntries(orderItems.map((i) => [i.id, i]));

  // Count already-returned (non-rejected) quantities per order_item
  const { rows: priorReturns } = await query(
    `SELECT ri.order_item_id, SUM(ri.quantity)::int AS returned_qty
     FROM return_items ri
     JOIN returns r ON r.id = ri.return_id
     WHERE r.order_id = $1 AND r.status NOT IN ('rejected')
     GROUP BY ri.order_item_id`,
    [order_id]
  );
  const alreadyReturned = Object.fromEntries(
    priorReturns.map((r) => [r.order_item_id, r.returned_qty])
  );

  // Validate each requested item
  for (const item of items) {
    const oi = orderItemMap[item.order_item_id];
    if (!oi) throw badRequest(`Item ${item.order_item_id} does not belong to this order`);
    if (!Number.isInteger(item.quantity) || item.quantity <= 0)
      throw badRequest(`Quantity for item ${item.order_item_id} must be a positive integer`);
    const maxReturnable = oi.quantity - (alreadyReturned[oi.id] ?? 0);
    if (item.quantity > maxReturnable)
      throw badRequest(
        `Cannot return more than ${maxReturnable} unit(s) of "${oi.product_name}"`
      );
  }

  // Create return + items atomically
  const returnRecord = await tx(async (c) => {
    const { rows: [ret] } = await c.query(
      `INSERT INTO returns (order_id, user_id, status, resolution, customer_note)
       VALUES ($1, $2, 'requested', $3, $4)
       RETURNING *`,
      [order_id, req.user.id, resolution, customer_note ?? null]
    );

    // Set RMA number using the auto-increment id (race-safe)
    const rma = buildRMANumber(ret.id);
    const { rows: [updated] } = await c.query(
      'UPDATE returns SET rma_number = $1 WHERE id = $2 RETURNING *',
      [rma, ret.id]
    );

    for (const item of items) {
      const oi = orderItemMap[item.order_item_id];
      await c.query(
        `INSERT INTO return_items (return_id, order_item_id, variant_id, quantity, reason_code)
         VALUES ($1, $2, $3, $4, $5)`,
        [updated.id, item.order_item_id, oi.variant_id ?? null, item.quantity, item.reason_code ?? null]
      );
    }

    return updated;
  });

  // Notify admin (non-blocking)
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_FROM;
  if (adminEmail) {
    sendEmail({
      to: adminEmail,
      ...emailTemplates.returnRequested(returnRecord, req.user.name),
    }).catch(() => {});
  }

  res.status(201).json(returnRecord);
}));

// GET /api/returns/me
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, COUNT(ri.id)::int AS item_count
     FROM returns r
     LEFT JOIN return_items ri ON ri.return_id = r.id
     WHERE r.user_id = $1
     GROUP BY r.id
     ORDER BY r.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
}));

// GET /api/returns/:id
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows: [ret] } = await query(
    'SELECT * FROM returns WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!ret) throw notFound('Return');

  const { rows: returnItems } = await query(
    `SELECT ri.*, oi.product_name, oi.unit_price, oi.variant_description, oi.product_image
     FROM return_items ri
     JOIN order_items oi ON oi.id = ri.order_item_id
     WHERE ri.return_id = $1`,
    [ret.id]
  );

  res.json({ ...ret, items: returnItems });
}));

export default router;
