-- ════════════════════════════════════════════════════════════════════════
-- Drop list: people who asked to hear about new drops, and what was sent.
-- Safe to run more than once.
-- ════════════════════════════════════════════════════════════════════════

-- One row per contact. Someone who gives an email and a phone number gets
-- two rows, so each can be unsubscribed on its own.
CREATE TABLE IF NOT EXISTS drop_subscribers (
  id              SERIAL PRIMARY KEY,
  channel         TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  address         TEXT NOT NULL,              -- lower-case email, or 233XXXXXXXXX
  source          TEXT NOT NULL DEFAULT '',   -- which form: home, footer, ...
  token           TEXT NOT NULL UNIQUE,       -- for the unsubscribe link
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ,
  UNIQUE (channel, address)
);

-- One row per announcement sent from Admin → Drop list.
CREATE TABLE IF NOT EXISTS drop_broadcasts (
  id          SERIAL PRIMARY KEY,
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  channels    TEXT[] NOT NULL,
  total       INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

-- Who each announcement goes to, fixed when it's sent. Sending works through
-- this list a few at a time, so a long send survives a closed tab or a
-- server restart and can be resumed.
CREATE TABLE IF NOT EXISTS drop_deliveries (
  broadcast_id  INTEGER NOT NULL REFERENCES drop_broadcasts(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES drop_subscribers(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | sent | failed | skipped
  claimed_at    TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  error         TEXT,
  PRIMARY KEY (broadcast_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS drop_deliveries_open
  ON drop_deliveries (broadcast_id) WHERE status IN ('pending', 'sending');

-- ── Privacy policy: say what the drop list keeps ────────────────────────
UPDATE content_pages
SET body = replace(body,
      '- **Restock requests** —',
      '- **Drop list** — the email address or phone number you give to hear about new drops. We use it only for those announcements, and every message has a link to unsubscribe.
- **Restock requests** —'),
    updated_at = NOW()
WHERE slug = 'privacy' AND body NOT LIKE '%**Drop list**%' AND body LIKE '%- **Restock requests** —%';
