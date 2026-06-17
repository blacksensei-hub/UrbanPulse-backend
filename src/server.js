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
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', async (_req, res) => {
  const base = process.env.FRONTEND_URL || 'https://urbanpulse.com';
  try {
    const { rows } = await query(
      `SELECT slug, updated_at FROM products WHERE is_active = true ORDER BY updated_at DESC`
    );
    const staticPages = ['', '/shop', '/faq'];
    const urls = [
      ...staticPages.map((p) => `  <url><loc>${base}${p}</loc></url>`),
      ...rows.map(
        (r) =>
          `  <url><loc>${base}/products/${r.slug}</loc>` +
          `<lastmod>${new Date(r.updated_at).toISOString().split('T')[0]}</lastmod></url>`
      ),
    ];
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.join('\n') +
      `\n</urlset>`
    );
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

if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

const port = process.env.PORT || 5000;
app.listen(port, () => logger.info(`UrbanPulse API listening on :${port}`));
