// Unit checks for src/utils/pricing.js. Run: node scripts-test-pricing.mjs
import { shippingFor, bundleDiscount } from './src/utils/pricing.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const flat = { shipping_standard_ghs: 30, shipping_express_ghs: 80, free_shipping_threshold_ghs: 200 };
// Region pricing off: exactly the old rule.
eq('off: standard under threshold', shippingFor({ subtotal: 120, method: 'standard', region: 'Ashanti', settings: flat }), 30);
eq('off: standard at threshold is free', shippingFor({ subtotal: 200, method: 'standard', settings: flat }), 0);
eq('off: express ignores threshold', shippingFor({ subtotal: 500, method: 'express', settings: flat }), 80);

const regional = { ...flat, delivery_regions_enabled: true,
  delivery_regions: { 'Greater Accra': { standard: 20, express: 50 }, 'Upper West': { standard: 60, express: '' } } };
eq('on: listed region uses its rates', shippingFor({ subtotal: 120, method: 'standard', region: 'Greater Accra', settings: regional }), 20);
eq('on: listed region express', shippingFor({ subtotal: 120, method: 'express', region: 'Greater Accra', settings: regional }), 50);
eq('on: blank express falls back to flat', shippingFor({ subtotal: 120, method: 'express', region: 'Upper West', settings: regional }), 80);
eq('on: unlisted region falls back to flat', shippingFor({ subtotal: 120, method: 'standard', region: 'Volta', settings: regional }), 30);
eq('on: threshold still makes standard free', shippingFor({ subtotal: 250, method: 'standard', region: 'Upper West', settings: regional }), 0);
eq('on: settings stored as a JSON string', shippingFor({ subtotal: 120, method: 'standard', region: 'Greater Accra', settings: { ...regional, delivery_regions: JSON.stringify(regional.delivery_regions), delivery_regions_enabled: 'true' } }), 20);

const b = { bundles: [{ id: 'jj', name: 'Jersey + Jeans', product_ids: [3, 2], price_ghs: 170, active: true }] };
const jersey = { product_id: 3, price: 120, quantity: 1 };
const jeans = { product_id: 2, price: 60, quantity: 1 };
eq('no bundles configured → nothing', bundleDiscount([jersey, jeans], {}).discount, 0);
eq('one of each → saves 10', bundleDiscount([jersey, jeans], b).discount, 10);
eq('note names the bundle', bundleDiscount([jersey, jeans], b).note, 'Jersey + Jeans');
eq('only one product → nothing', bundleDiscount([jersey], b).discount, 0);
eq('2 jerseys + 1 jeans → one set', bundleDiscount([{ ...jersey, quantity: 2 }, jeans], b).lines[0].sets, 1);
eq('2 + 2 → two sets, saves 20', bundleDiscount([{ ...jersey, quantity: 2 }, { ...jeans, quantity: 2 }], b).discount, 20);
eq('two sets are noted ×2', bundleDiscount([{ ...jersey, quantity: 2 }, { ...jeans, quantity: 2 }], b).note, 'Jersey + Jeans ×2');
eq('bundle dearer than separate → ignored', bundleDiscount([jersey, jeans], { bundles: [{ ...b.bundles[0], price_ghs: 200 }] }).discount, 0);
eq('inactive bundle → ignored', bundleDiscount([jersey, jeans], { bundles: [{ ...b.bundles[0], active: false }] }).discount, 0);
eq('single-product "bundle" → ignored', bundleDiscount([jersey, jeans], { bundles: [{ ...b.bundles[0], product_ids: [3, 3] }] }).discount, 0);
eq('variant price differences: dearest units used first',
  bundleDiscount([{ product_id: 3, price: 130, quantity: 1 }, { product_id: 3, price: 120, quantity: 1 }, jeans], b).discount, 20);

console.log(`\n${fail ? 'FAILED' : 'all passed'}`);
process.exit(fail ? 1 : 0);
