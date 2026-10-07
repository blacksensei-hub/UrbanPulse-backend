import express from 'express';
import { verifyWebhookSignature } from '../utils/paystackHelper.js';
import { logger } from '../utils/logger.js';
import { confirmPayment } from '../utils/payments.js';

const router = express.Router();

// IMPORTANT: this router is mounted with express.raw() in server.js so req.body is a Buffer.
// Paystack signs the raw body with HMAC-SHA512 and sends the digest in `x-paystack-signature`.
router.post('/paystack', async (req, res) => {
  const sig = req.headers['x-paystack-signature'];
  const raw = req.body; // Buffer

  if (!verifyWebhookSignature(raw, sig)) {
    logger.warn('Paystack webhook signature verification failed');
    return res.status(401).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    logger.warn(`Paystack webhook body parse failed: ${err.message}`);
    return res.status(400).send('Invalid body');
  }

  // The essential path (DB transaction + notifications + referral qualify) is awaited
  // BEFORE responding — on serverless (Vercel), the platform can freeze/terminate the
  // function as soon as the response is sent, so any work left running after res.json()
  // is not guaranteed to complete. Paystack tolerates several seconds here, so the extra
  // latency is worth the reliability. We still always return 200 (Paystack retries on
  // non-2xx, which wouldn't fix a code bug anyway) — but only after doing the work, or
  // after logging loudly why it failed.
  try {
    // Marks the order paid only for a full payment in cedis, matched to the
    // order even if its payment page was opened twice (utils/payments.js).
    if (event?.event === 'charge.success' && event?.data?.reference) {
      await confirmPayment(event.data.reference, event.data);
    }
  } catch (err) {
    logger.error('Paystack webhook handling error', {
      event: event?.event,
      reference: event?.data?.reference,
      err: err.message,
      stack: err.stack,
    });
  }

  res.json({ received: true });
});

export default router;
