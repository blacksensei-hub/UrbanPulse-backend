import express from 'express';
import { body, validationResult } from 'express-validator';
import { query, tx } from '../db/index.js';
import { asyncHandler, badRequest, notFound } from '../utils/helpers.js';
import { initializeTransaction, verifyTransaction } from '../utils/paystackHelper.js';
import { getSettings } from '../utils/settingsCache.js';
import { awardPointsForOrder } from '../utils/loyalty.js';

const router = express.Router();

// POST /api/checkout/session — initialize a Paystack transaction for a pending order
router.post(
  '/session',
  body('order_id').isInt(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw badRequest('Validation', errors.array());

    const { order_id, payment_method } = req.body;
    const { rows } = await query('SELECT * FROM orders WHERE id = $1', [order_id]);
    const order = rows[0];
    if (!order) throw notFound('Order');
    if (order.payment_method === 'cod') throw badRequest('COD orders do not need a Paystack session');
    if (order.payment_status === 'paid') throw badRequest('Already paid');

    const cfg = await getSettings();
    if (cfg.feature_paystack === 'false') throw badRequest('Online payments are currently unavailable');

    // Use the order_number as the Paystack reference so we can correlate webhook events.
    const reference = order.order_number;
    const email = order.email || order.shipping_address?.email;
    if (!email) throw badRequest('Customer email required');

    const CHANNELS = {
      mobile_money: ['mobile_money'],
      card:         ['card', 'bank'],
    };
    const channels = CHANNELS[payment_method] ?? ['mobile_money', 'card', 'bank'];

    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';

    const data = await initializeTransaction({
      email,
      amount: order.total, // helper converts GHS → pesewas
      reference,
      callback_url: `${frontend}/order-success?id=${order.id}&reference=${reference}`,
      metadata: {
        order_id: order.id,
        order_number: order.order_number,
        custom_fields: [
          { display_name: 'Order Number', variable_name: 'order_number', value: order.order_number },
        ],
      },
      channels,
    });

    await query(
      'UPDATE orders SET paystack_reference = $1 WHERE id = $2',
      [reference, order.id]
    );

    // Frontend expects { url } — keep the field name stable.
    res.json({ url: data.authorization_url, reference: data.reference, access_code: data.access_code });
  })
);

// GET /api/checkout/verify/:reference — fallback for clients that land on the callback
// before the webhook has fired. Idempotent: just marks the order paid if Paystack confirms it.
router.get('/verify/:reference', asyncHandler(async (req, res) => {
  const data = await verifyTransaction(req.params.reference);
  if (data?.status === 'success') {
    await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE orders
           SET payment_status = 'paid', status = 'processing'
         WHERE paystack_reference = $1
           AND payment_status <> 'paid'
         RETURNING *`,
        [req.params.reference]
      );
      const order = rows[0];
      if (order) await awardPointsForOrder(c, order);
    });
  }
  res.json({ status: data?.status, reference: data?.reference });
}));

export default router;
