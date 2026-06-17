import express from 'express';
import { getSettings } from '../utils/settingsCache.js';
import { asyncHandler } from '../utils/helpers.js';

const router = express.Router();

const PUBLIC_KEYS = new Set([
  'store_name', 'support_email', 'support_whatsapp', 'business_address', 'currency',
  'shipping_standard_ghs', 'shipping_express_ghs', 'free_shipping_threshold_ghs',
  'maintenance_mode', 'maintenance_message',
  'feature_referrals', 'feature_wishlist', 'feature_reviews',
  'feature_preorders', 'feature_cod', 'feature_paystack',
]);

router.get('/public', asyncHandler(async (_req, res) => {
  const all = await getSettings();
  const pub = {};
  for (const k of PUBLIC_KEYS) {
    if (k in all) pub[k] = all[k];
  }
  res.json(pub);
}));

export default router;
