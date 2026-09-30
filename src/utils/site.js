// The storefront's public address, for links in receipts, messages, the
// sitemap and robots.txt. FRONTEND_URL (set on Vercel) wins; the fallback is
// the live site, never a placeholder domain the store doesn't own.
export const siteUrl = () => (process.env.FRONTEND_URL || 'https://urbanpulsee.vercel.app').replace(/\/$/, '');

// The same, without the scheme, for printed text ("urbanpulsee.vercel.app/…").
export const siteHost = () => siteUrl().replace(/^https?:\/\//, '');
