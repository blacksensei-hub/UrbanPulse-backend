-- Features 3-8 (back-in-stock alerts, bundles, visitor stats, size charts).
-- Additive only: new tables and new nullable/defaulted columns, nothing
-- dropped or rewritten. Safe to run more than once. Run it on Neon BEFORE
-- deploying the backend that uses it; until then those features stay off.
--
-- Delivery-by-region and bundle definitions live in site_settings (no
-- schema needed). Order tracking needs no schema either.

-- ── 3. Back-in-stock alerts ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_alerts (
  id           SERIAL PRIMARY KEY,
  variant_id   INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  email        TEXT,
  phone        TEXT,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at  TIMESTAMPTZ,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
-- One pending alert per person per size; asking twice is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS stock_alerts_pending_email
  ON stock_alerts (variant_id, lower(email)) WHERE notified_at IS NULL AND email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_alerts_pending_phone
  ON stock_alerts (variant_id, phone) WHERE notified_at IS NULL AND phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_alerts_pending
  ON stock_alerts (variant_id) WHERE notified_at IS NULL;

-- ── 4. Bundles: the discount is recorded on the order ───────────────────
-- Without these, receipts and emails (which derive store credit as the gap
-- between the parts and the total) would show a bundle saving as credit.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bundle_discount_ghs NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bundle_note TEXT;

-- ── 5. Visitor stats: daily aggregate counts only ───────────────────────
-- No IP addresses, no cookies, no user IDs, nothing that identifies a
-- person: a row is "this page, from this source, on this kind of device,
-- on this day: N views, M of them the first page of a visit".
CREATE TABLE IF NOT EXISTS visit_stats (
  day       DATE    NOT NULL,
  path      TEXT    NOT NULL,
  source    TEXT    NOT NULL DEFAULT '',
  medium    TEXT    NOT NULL DEFAULT '',
  campaign  TEXT    NOT NULL DEFAULT '',
  device    TEXT    NOT NULL DEFAULT '',
  views     INTEGER NOT NULL DEFAULT 0,
  landings  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, source, medium, campaign, device)
);

-- ── 7. Order tracking: point the FAQ at the new page ────────────────────
UPDATE content_pages
SET body = replace(body,
      'Sign in and open your account''s Orders page to see where your order is.',
      'Use [Track an order](/track) with your order number and the email or phone you ordered with, or sign in and open your account''s Orders page.'),
    updated_at = NOW()
WHERE slug = 'faq' AND body LIKE '%Sign in and open your account''s Orders page to see where your order is.%';

-- ── 8. Size charts ──────────────────────────────────────────────────────
-- size_chart: { "unit": "cm", "columns": ["Size","Chest","Length"],
--               "rows": [["S","52","70"], ...], "note": "..." }
ALTER TABLE products ADD COLUMN IF NOT EXISTS size_chart JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS fit_note TEXT;

-- ── Privacy policy: say what the visit counts and restock sign-ups keep ─
UPDATE content_pages
SET body = replace(body,
      '- **Communications** —',
      '- **Restock requests** — the email address or phone number you give when you ask to be told a sold-out size is back. We use it for that one message and nothing else.
- **Communications** —'),
    updated_at = NOW()
WHERE slug = 'privacy' AND body NOT LIKE '%**Restock requests**%' AND body LIKE '%- **Communications** —%';

UPDATE content_pages
SET body = replace(body,
      'We do not currently use any third-party analytics trackers or advertising pixels.',
      'We count visits ourselves, anonymously: for each day we keep how many times each page was viewed, which site or tagged link a visit came from, and whether it was a phone, tablet or desktop. We do not store IP addresses, set cookies for this, or link a count to you or your account, and if you reject analytics in the cookie banner while signed in, your visits are not counted at all.

We do not currently use any third-party analytics trackers or advertising pixels.'),
    updated_at = NOW()
WHERE slug = 'privacy' AND body NOT LIKE '%We count visits ourselves%'
  AND body LIKE '%We do not currently use any third-party analytics trackers or advertising pixels.%';
