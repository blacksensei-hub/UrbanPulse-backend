# UrbanPulse API

The backend for [UrbanPulse](https://urbanpulsee.vercel.app), a storefront for a Ghanaian streetwear brand. It handles accounts, products, carts, checkout in cedis through Paystack, orders and returns, the drop list, loyalty and referrals, and the admin that runs the shop.

The storefront lives in [UrbanPulse-frontend](https://github.com/blacksensei-hub/UrbanPulse-frontend). The [case study](https://jeffrey-ankrah.pages.dev/projects/urbanpulse/) explains the decisions behind both.

## What it does

- **Checkout:** mobile money and card through Paystack, plus cash on delivery. A payment webhook marks an order paid only after its signature checks out. Delivery can be priced per region, and bundle discounts are worked out on the server.
- **Keeping the sale:** back-in-stock alerts by email or SMS, a drop list with batched announcements and unsubscribe links, and order tracking with just an order number and an email or phone number.
- **Customer accounts:**
  - order history, returns, saved addresses and a wishlist
  - PDF receipts
  - optional two-factor sign-in, and Google sign-in
  - loyalty tiers and referral credit
  - exporting your data, or deleting your account
- **Admin:**
  - orders, products, customers, coupons and returns
  - the drop list, content pages and email templates
  - analytics and activity logs
  - settings for delivery rates, bundles and loyalty
- **Housekeeping:**
  - visit counts kept as daily totals, with no IP addresses or cookies
  - a sitemap
  - scheduled jobs for abandoned carts and loyalty expiry, each switched on by its own setting

## Stack

Node.js and Express on PostgreSQL (`pg`). The API also uses:
- Paystack for payments, Cloudinary for images
- Nodemailer for email, Arkesel for SMS
- PDFKit for receipts, otplib for two-factor sign-in
- node-cron for scheduled jobs
- Sentry for errors, Winston for logs

## Running it locally

You need Node.js 18 or later and PostgreSQL.

```bash
npm install
npm run dev        # http://localhost:5000
```

### Settings

Put these in `.env`. Only the first group is needed to start; the rest switch features on.

| Variable | What it's for |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. SSL is used only when `NODE_ENV=production` |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Sign the sign-in and refresh tokens. Long random strings |
| `FRONTEND_URL` | Where the storefront runs, for example `http://localhost:5173`. Used for CORS and for links in emails |
| `PORT` | Defaults to `5000` |
| `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | Token lifetimes. Default `15m` and `7d` |
| `PAYSTACK_SECRET_KEY` | Paystack payments and webhooks. Use a test key locally |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Product image uploads from the admin |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Sending email. Without `SMTP_HOST`, emails are logged instead of sent |
| `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_BASE_URL` | Sending SMS through Arkesel. Without a key, SMS is off |
| `GOOGLE_CLIENT_ID` | Google sign-in |
| `BACKEND_URL` | The API's public address, used in unsubscribe links |
| `ADMIN_EMAIL` | Where return requests and refunds Paystack refused are sent. Defaults to `SMTP_FROM` |
| `RETURN_ADDRESS` | The return address printed in return emails |
| `ENABLE_CART_RECOVERY`, `ENABLE_LOYALTY_EXPIRY` | Set to `true` to run those scheduled jobs |
| `SENTRY_DSN`, `LOG_LEVEL` | Error reporting, and log detail (default `info`). Passwords, codes, tokens and session cookies are blanked before a report leaves (`src/utils/sentryScrub.js`) |

### Database

`sql/schema.sql` creates every table, index and constraint, with no data. It also creates the `pg_trgm` extension, which ships with PostgreSQL. Load it into an empty database:

```bash
createdb urbanpulse
psql urbanpulse -v ON_ERROR_STOP=1 -f sql/schema.sql
psql urbanpulse -f sql/seed_content_pages.sql
```

The other files in `sql/` are changes for databases made before them:

- `2026-10_features.sql` and `2026-10_drops.sql` add the tables and columns for restock alerts, bundles, visit stats, size charts and the drop list. `schema.sql` already includes them, and running them again changes nothing.
- `seed_content_pages.sql` and the `update_*` files set the About, FAQ and policy page copy and the support address.
- `normalize_category.sql` tidies category names.

Each file says at the top whether it is safe to run more than once.

### Seeding

`npm run seed` **empties every store table** (products, orders, customers, everything) and creates one admin account, so only use it on a database you can wipe. It needs:

```bash
SEED_WIPE=yes SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='at least 12 characters' npm run seed
```

`node scripts-seed-dev.mjs` adds three sample products (their slugs start with `dev-`) for trying the store locally.

## Finding payments that went astray

`node scripts-find-unpaid-payments.mjs` lists two kinds of Paystack order from before the October 2026 checkout fixes:
- orders Paystack was paid for that still show unpaid;
- paid orders that were never confirmed, which likely got no email or SMS.

It reads `DATABASE_URL` and `PAYSTACK_SECRET_KEY` from `.env` and changes nothing. The database is opened read-only, and Paystack is only asked to list payments. `--days 365` looks further back than the default 120 days.

## Checks

```bash
npm run lint       # ESLint's recommended rules (eslint.config.js)
npm test           # pricing checks, then the checkout tests in test/
```

The checkout tests (`test/checkout.test.js`) go through the real order, checkout and webhook routes:
- order totals, coupons and store credit
- stock, including two customers buying the last unit at once
- starting a Paystack payment
- the webhook and the return check that mark an order paid

Each run builds a throwaway database from `sql/schema.sql` and drops it afterwards. Paystack is replaced by a stand-in, and email and SMS are off. The tests run only when `TEST_DATABASE_URL` points at a PostgreSQL server on this machine; they refuse any other host, so they can't reach the live database:

```bash
TEST_DATABASE_URL=postgres://postgres:yourpassword@localhost:5432/postgres npm test
```

GitHub Actions runs all of it on every pull request, with PostgreSQL in a container, along with a syntax check of every source file (`.github/workflows/ci.yml`).
