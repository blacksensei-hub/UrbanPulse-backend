/**
 * The VAT rate an order was actually charged, for the "VAT (12.5%)" line on
 * receipts and emails. Orders don't store the rate, but they store what it
 * produced: tax = subtotal × rate, rounded to the pesewa (routes/orders.js).
 * So the rate is recovered from the order itself, the simplest one (whole
 * number, then 1 and 2 decimals) that reproduces the tax exactly. An order
 * placed before a rate change keeps showing the rate it paid, not today's.
 *
 * `currentRate` (Admin → Settings) is preferred whenever it reproduces the
 * order's tax: on a small basket several close rates (2.2%, 2.25%) round to
 * the same pesewa, and the setting says which one it really was.
 */
const reproduces = (subtotal, tax, r) => Math.abs(+(subtotal * r / 100).toFixed(2) - tax) < 0.005;

export function vatRatePercent(order, currentRate) {
  const subtotal = Number(order?.subtotal);
  const tax = Number(order?.tax);
  if (!(subtotal > 0) || !Number.isFinite(tax) || tax < 0) return null;
  const current = Number(currentRate);
  if (currentRate != null && currentRate !== '' && Number.isFinite(current) && reproduces(subtotal, tax, current)) return current;
  const raw = (tax / subtotal) * 100;
  for (const places of [0, 1, 2]) {
    const r = Number(raw.toFixed(places));
    if (reproduces(subtotal, tax, r)) return r;
  }
  return Number(raw.toFixed(2));
}

export function vatLabel(order, currentRate) {
  const r = vatRatePercent(order, currentRate);
  return r == null ? 'VAT' : `VAT (${r}%)`;
}
