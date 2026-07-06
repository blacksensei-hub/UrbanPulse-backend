import 'dotenv/config';
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import compression from 'compression';

import { logger } from './utils/logger.js';
import { generalLimiter } from './utils/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import { query } from './db/index.js';

import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import cartRoutes from './routes/cart.js';
import orderRoutes from './routes/orders.js';
import checkoutRoutes from './routes/checkout.js';
import webhookRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';
import wishlistRoutes from './routes/wishlist.js';
import referralRoutes from './routes/referrals.js';
import returnsRoutes from './routes/returns.js';
import settingsRoutes from './routes/settings.js';
import loyaltyRoutes from './routes/loyalty.js';
import './jobs/index.js';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
  });
}

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(morgan('tiny'));
app.use(cookieParser());

const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:5173';
app.use(cors({
  origin: allowedOrigin,
  credentials: true,
}));

// Paystack webhook MUST receive raw body — register BEFORE express.json()
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

app.use(express.json({ limit: '1mb' }));
app.use(generalLimiter);

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/robots.txt', (_req, res) => {
  const base = process.env.FRONTEND_URL || 'https://urbanpulse.com';
  res.setHeader('Content-Type', 'text/plain');
  res.send(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /account\nDisallow: /cart\nDisallow: /checkout\nSitemap: ${base}/sitemap.xml\n`
  );
});

let sitemapCache = { xml: null, generatedAt: 0 };
const SITEMAP_TTL_MS = 3600_000; // 1 hour

// Lookbooks are NOT DB-backed — they live entirely in frontend/src/pages/Lookbook.jsx's
// LOOKBOOKS object. Keep this array in sync with LOOKBOOKS' keys whenever a lookbook is
// added/removed/renamed there.
const LOOKBOOK_SLUGS = ['spring-26', 'field-essentials', 'urban-roots'];

const STATIC_PAGES = [
  { path: '', changefreq: 'daily', priority: '1.0' },
  { path: '/shop', changefreq: 'daily', priority: '0.9' },
  { path: '/lookbook', changefreq: 'weekly', priority: '0.6' },
  { path: '/about', changefreq: 'monthly', priority: '0.5' },
  ...LOOKBOOK_SLUGS.map((slug) => ({ path: `/lookbook/${slug}`, changefreq: 'monthly', priority: '0.5' })),
  { path: '/faq', changefreq: 'monthly', priority: '0.3' },
];

async function generateSitemap() {
  const base = process.env.FRONTEND_URL || 'https://urbanpulse.com';
  const { rows } = await query(
    `SELECT slug, updated_at FROM products WHERE is_active = true ORDER BY updated_at DESC`
  );
  // Static pages have no real "last modified" history — today's date is the pragmatic
  // stand-in, not a fabricated one.
  const today = new Date().toISOString().split('T')[0];

  const staticUrls = STATIC_PAGES.map(
    (p) =>
      `  <url><loc>${base}${p.path}</loc><lastmod>${today}</lastmod>` +
      `<changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`
  );
  const productUrls = rows.map(
    (r) =>
      `  <url><loc>${base}/products/${r.slug}</loc>` +
      `<lastmod>${new Date(r.updated_at).toISOString().split('T')[0]}</lastmod>` +
      `<changefreq>weekly</changefreq><priority>0.8</priority></url>`
  );

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [...staticUrls, ...productUrls].join('\n') +
    `\n</urlset>`
  );
}

app.get('/sitemap.xml', async (_req, res) => {
  try {
    if (!sitemapCache.xml || Date.now() - sitemapCache.generatedAt > SITEMAP_TTL_MS) {
      sitemapCache = { xml: await generateSitemap(), generatedAt: Date.now() };
    }
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(sitemapCache.xml);
  } catch {
    res.status(500).send('');
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/returns', returnsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/loyalty', loyaltyRoutes);

if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const port = process.env.PORT || 5000;
app.listen(port, () => logger.info(`UrbanPulse API listening on :${port}`));
