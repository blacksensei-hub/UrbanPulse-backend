// Order pricing rules that the checkout page also shows before you pay.
// MIRRORED in frontend/src/lib/pricing.js: change both together, or the
// total a customer sees won't be the total they're charged.
// (review/pricing-parity.mjs checks the two agree.)

export const GHANA_REGIONS = [
  'Greater Accra', 'Ashanti', 'Central', 'Eastern', 'Western', 'Western North',
  'Volta', 'Oti', 'Northern', 'Savannah', 'North East', 'Upper East',
  'Upper West', 'Bono', 'Bono East', 'Ahafo',
];

const on = (v) => v === true || v === 'true';

function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return v;
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * Delivery fee. With region pricing off (the default), exactly the old flat
 * rule: express costs the express rate; standard is free at or above the
 * free-delivery threshold, otherwise the standard rate. With it on, a region
 * listed in `delivery_regions` swaps in its own standard/express rates; an
 * unlisted region (or a blank rate) falls back to the flat ones. The free
 * threshold still applies to standard delivery everywhere.
 *
 * delivery_regions: { "Greater Accra": { "standard": 25, "express": 60 }, ... }
 */
export function shippingFor({ subtotal, method, region, settings = {} }) {
  let standard = Number(settings.shipping_standard_ghs ?? 30);
  let express = Number(settings.shipping_express_ghs ?? 80);
  const freeOver = Number(settings.free_shipping_threshold_ghs ?? 1000);
  if (on(settings.delivery_regions_enabled) && region) {
    const rates = parseJson(settings.delivery_regions, {})?.[region];
    if (rates) {
      if (num(rates.standard) !== null) standard = num(rates.standard);
      if (num(rates.express) !== null) express = num(rates.express);
    }
  }
  if (method === 'express') return express;
  return subtotal >= freeOver ? 0 : standard;
}

/**
 * Active bundles from settings: [{ id, name, product_ids: [..], price_ghs, active }].
 * Only bundles of 2+ distinct products with a positive price count.
 */
export function activeBundles(settings = {}) {
  const list = parseJson(settings.bundles, []);
  if (!Array.isArray(list)) return [];
  return list.filter((b) => b && on(b.active ?? true)
    && Array.isArray(b.product_ids) && new Set(b.product_ids.map(Number)).size >= 2
    && Number(b.price_ghs) > 0);
}

/**
 * Bundle saving for a cart. A "set" is one unit of every product in the
 * bundle; the saving per set is what those units cost separately minus the
 * bundle price (never negative: a bundle that wouldn't save money is
 * ignored). Units are used once across bundles, highest-priced first, so the
 * customer always gets the larger saving.
 *
 * items: [{ product_id, price, quantity }]
 * → { discount, lines: [{ id, name, sets, saving }], note }
 */
export function bundleDiscount(items, settings = {}) {
  const bundles = activeBundles(settings);
  if (!bundles.length || !items?.length) return { discount: 0, lines: [], note: null };

  const pool = new Map(); // product_id -> unit prices, most expensive first
  for (const it of items) {
    const id = Number(it.product_id);
    const units = pool.get(id) ?? [];
    for (let q = 0; q < Number(it.quantity); q++) units.push(Number(it.price));
    pool.set(id, units);
  }
  for (const units of pool.values()) units.sort((a, b) => b - a);

  const lines = [];
  for (const b of bundles) {
    const ids = [...new Set(b.product_ids.map(Number))];
    const price = Number(b.price_ghs);
    let sets = 0;
    let saving = 0;
    while (ids.every((id) => (pool.get(id)?.length ?? 0) > 0)) {
      const separate = ids.reduce((s, id) => s + pool.get(id)[0], 0);
      if (separate <= price) break;
      ids.forEach((id) => pool.get(id).shift());
      sets += 1;
      saving += separate - price;
    }
    if (sets) lines.push({ id: b.id, name: b.name, sets, saving: +saving.toFixed(2) });
  }
  const discount = +lines.reduce((s, l) => s + l.saving, 0).toFixed(2);
  const note = lines.length ? lines.map((l) => (l.sets > 1 ? `${l.name} ×${l.sets}` : l.name)).join(', ') : null;
  return { discount, lines, note };
}
