import nodemailer from 'nodemailer';
import { logger } from './logger.js';
import { getSettings } from './settingsCache.js';

let transporter = null;

const frontendUrl = () => process.env.FRONTEND_URL || 'http://localhost:5173';
const formatGHS = (amount) => {
  const [int, dec] = Number(amount || 0).toFixed(2).split('.');
  return `GH₵ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
};

// ─── Brand system (hex literals — email HTML can't use CSS variables) ───────
const COLOR = {
  bg: '#F8F6F2', surface: '#FFFFFF', text: '#1A1A1A', muted: '#6B6B66',
  accent: '#D85A30', border: '#E5E5E0',
};
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Capitalizes each word (jeffrey -> Jeffrey, MARY -> Mary) — display only,
// never mutates stored data. Used everywhere a name is shown in an email.
function titleCase(str) {
  return String(str ?? '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function firstName(name) {
  const first = name?.split(' ')[0];
  return first ? titleCase(first) : 'there';
}

// Ghana phone formatting — mirrors frontend/src/utils/format.js's formatPhone
// exactly, so emails and the site never disagree on how a number reads.
function formatPhoneGh(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('233')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length !== 9) return raw;
  return `+233 ${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
}

// Standard/Express windows mirror the copy already shown at checkout and on
// the shipping-info page, so the email never contradicts the site.
function shippingLabel(shippingCost, expressRateGhs) {
  const cost = Number(shippingCost);
  const isExpress = expressRateGhs != null && Math.abs(cost - Number(expressRateGhs)) < 0.01;
  return isExpress ? 'Express delivery: 2–3 business days' : 'Standard delivery: 5–7 business days';
}

function parseAddress(raw) {
  if (!raw) return {};
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ─── Shared CTA button — <a> styled as a block, not a <button> ──────────────
function ctaButton(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
    <tr>
      <td style="background-color:${COLOR.accent};border-radius:999px;">
        <a href="${href}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

// Secondary CTA — outline style, for a lower-emphasis action alongside the
// primary accent button (e.g. "Track with {carrier}" next to "View your order").
function ctaButtonOutline(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;">
    <tr>
      <td style="background-color:transparent;border:1px solid ${COLOR.text};border-radius:999px;">
        <a href="${href}" style="display:inline-block;padding:13px 27px;font-family:${FONT};font-size:14px;font-weight:600;color:${COLOR.text};text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

function eyebrow(text) {
  return `<p style="margin:0 0 12px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${COLOR.muted};">${escapeHtml(text)}</p>`;
}

function h1(text) {
  return `<h1 style="margin:0 0 20px;font-family:${FONT};font-size:28px;font-weight:700;color:${COLOR.text};line-height:1.3;">${text}</h1>`;
}

// ─── The shared wrapper every template renders through ──────────────────────
// Preheader padding trick: zero-width joiners + nbsp repeated so Gmail/Apple
// Mail don't pull trailing body text into the inbox preview snippet.
const PREHEADER_PAD = '&nbsp;&zwnj;'.repeat(60);

function renderLayout({ preheader, bodyHtml, transactional = true }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title></title>
</head>
<body style="margin:0;padding:0;background-color:${COLOR.bg};">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLOR.bg};">${escapeHtml(preheader)}${PREHEADER_PAD}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.bg}" style="background-color:${COLOR.bg};">
    <tr>
      <td align="center" style="padding:24px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.surface}" style="width:600px;max-width:600px;background-color:${COLOR.surface};">
          <tr>
            <td bgcolor="${COLOR.surface}" style="background-color:${COLOR.surface};border-bottom:1px solid ${COLOR.border};padding:24px 32px;">
              <span style="font-family:${FONT};font-size:22px;font-weight:700;letter-spacing:-0.5px;color:${COLOR.text};">urban<span style="color:${COLOR.accent};">pulse</span></span>
            </td>
          </tr>
          <tr>
            <td bgcolor="${COLOR.surface}" style="background-color:${COLOR.surface};padding:32px;font-family:${FONT};color:${COLOR.text};">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td bgcolor="${COLOR.bg}" style="background-color:${COLOR.bg};padding:24px 32px;font-family:${FONT};font-size:12px;line-height:1.7;color:${COLOR.muted};">
              Support: {{SUPPORT_EMAIL_HTML}}{{SUPPORT_WHATSAPP_HTML}}<br/>
              Made in Ghana<br/>
              <a href="${frontendUrl()}/returns-policy" style="color:${COLOR.muted};text-decoration:underline;">Returns policy</a>
              &nbsp;·&nbsp;
              <a href="${frontendUrl()}/privacy" style="color:${COLOR.muted};text-decoration:underline;">Privacy</a>
              ${transactional ? '' : '<br/><br/>You are receiving this because you have an UrbanPulse account. This is a one-off notice, not a recurring newsletter.'}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderTextFooter({ transactional = true } = {}) {
  return `\n\n—\nSupport: {{SUPPORT_EMAIL_TEXT}}{{SUPPORT_WHATSAPP_TEXT}}\nMade in Ghana\nReturns policy: ${frontendUrl()}/returns-policy\nPrivacy: ${frontendUrl()}/privacy${transactional ? '' : '\n\nYou are receiving this because you have an UrbanPulse account. This is a one-off notice, not a recurring newsletter.'}`;
}

// ─── Settings-token substitution, resolved once at send time ────────────────
// Templates stay synchronous (every call site spreads their return value
// un-awaited) — only sendEmail(), which is already async and already awaited/
// .catch()'d everywhere, is a safe place to pull live settings.
export function injectTokens(str, {
  supportEmailHtml = '', supportEmailText = '', supportWhatsappHtml = '', supportWhatsappText = '',
} = {}) {
  if (!str) return str;
  return str
    .replaceAll('{{SUPPORT_EMAIL_HTML}}', supportEmailHtml)
    .replaceAll('{{SUPPORT_EMAIL_TEXT}}', supportEmailText)
    .replaceAll('{{SUPPORT_WHATSAPP_HTML}}', supportWhatsappHtml)
    .replaceAll('{{SUPPORT_WHATSAPP_TEXT}}', supportWhatsappText);
}

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) {
    logger.warn('SMTP not configured — emails will be logged only.');
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

export async function sendEmail({ to, subject, html, text }) {
  const settings = await getSettings().catch((err) => {
    logger.error('sendEmail: getSettings failed, falling back to default contact info', { err: err.message });
    return {};
  });
  const supportEmail = settings.support_email || 'support@urbanpulse.com.gh';
  const waDigits = (settings.support_whatsapp || '').replace(/\D/g, '');
  const tokens = {
    supportEmailHtml: `<a href="mailto:${supportEmail}" style="color:${COLOR.muted};text-decoration:underline;">${supportEmail}</a>`,
    supportEmailText: supportEmail,
    supportWhatsappHtml: waDigits
      ? ` &nbsp;·&nbsp; <a href="https://wa.me/${waDigits}" style="color:${COLOR.muted};text-decoration:underline;">WhatsApp</a>`
      : '',
    supportWhatsappText: waDigits ? ` · WhatsApp +${waDigits}` : '',
  };
  const resolvedHtml = injectTokens(html, tokens);
  const resolvedText = injectTokens(text, tokens);

  const t = getTransporter();
  if (!t) {
    logger.info({ to, subject, text: resolvedText }, '[email] dev-mode log');
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || 'UrbanPulse <noreply@urbanpulse.com>',
    replyTo: supportEmail,
    to, subject, html: resolvedHtml, text: resolvedText,
  });
}

export const emailTemplates = {
  loginAlert: ({ name, device, ip, time }) => {
    const first = firstName(name);
    const bodyHtml = `
      ${eyebrow('New sign-in')}
      ${h1(`Hi ${escapeHtml(first)}.`)}
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Your account was just signed in from a new device.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 20px;">
        <tr><td style="padding:6px 0;border-bottom:1px solid ${COLOR.border};font-size:13px;color:${COLOR.muted};width:110px;">Device</td><td style="padding:6px 0;border-bottom:1px solid ${COLOR.border};font-size:13px;color:${COLOR.text};">${escapeHtml(device)}</td></tr>
        <tr><td style="padding:6px 0;border-bottom:1px solid ${COLOR.border};font-size:13px;color:${COLOR.muted};">IP address</td><td style="padding:6px 0;border-bottom:1px solid ${COLOR.border};font-size:13px;color:${COLOR.text};">${escapeHtml(ip)}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:${COLOR.muted};">Time</td><td style="padding:6px 0;font-size:13px;color:${COLOR.text};">${escapeHtml(new Date(time).toUTCString())}</td></tr>
      </table>
      <p style="margin:0;font-size:14px;line-height:1.6;color:${COLOR.muted};">If this was you, no action is needed. If not, change your password and enable two-factor authentication right away.</p>
    `;
    return {
      subject: 'New sign-in to your UrbanPulse account',
      html: renderLayout({ preheader: `New sign-in from ${device}`, bodyHtml }),
      text: `Hi ${first}.\n\nYour UrbanPulse account was signed in from:\nDevice: ${device}\nIP: ${ip}\nTime: ${new Date(time).toUTCString()}\n\nNot you? Change your password now.${renderTextFooter()}`,
    };
  },

  orderConfirmation: (order, items = [], { couponDiscount = 0, expressRateGhs = null } = {}) => {
    const orderUrl = `${frontendUrl()}/account/orders/${order.id}`;
    const address = parseAddress(order.shipping_address);
    const first = firstName(address.name);

    const subtotal = Number(order.subtotal);
    const shipping = Number(order.shipping_cost);
    const tax = Number(order.tax);
    const total = Number(order.total);
    const discount = Number(couponDiscount) || 0;
    // Store credit isn't a column — derived the same way receipt.js does.
    const credit = Math.max(0, +(subtotal + shipping + tax - discount - total).toFixed(2));

    // Explicit HTML width= attributes (not just inline style) on every cell —
    // Outlook's Word rendering engine and some Gmail mobile paths don't
    // reliably size table cells from CSS width alone, which is what let the
    // qty/price column collide against the product name at narrow widths.
    const itemRows = items.map((it) => `
      <tr>
        <td width="64" style="padding:12px 0;border-bottom:1px solid ${COLOR.border};vertical-align:top;width:64px;">
          <img src="${it.product_image ?? ''}" width="64" alt="${escapeHtml(it.product_name)}" style="width:64px;height:auto;border-radius:6px;display:block;" />
        </td>
        <td width="100%" style="padding:12px 0 12px 12px;border-bottom:1px solid ${COLOR.border};vertical-align:top;width:100%;">
          <strong style="font-size:15px;font-weight:600;color:${COLOR.text};">${escapeHtml(it.product_name)}</strong><br/>
          <span style="color:${COLOR.muted};font-size:13px;">${escapeHtml(it.variant_description ?? '')}</span>
        </td>
        <td style="padding:12px 0 12px 16px;border-bottom:1px solid ${COLOR.border};vertical-align:top;white-space:nowrap;font-size:14px;color:${COLOR.muted};text-align:right;">${it.quantity} × ${formatGHS(it.unit_price)}</td>
      </tr>`).join('');

    function totalsRow(label, value, { bold = false, hairline = false } = {}) {
      return `<tr>
        <td style="padding:${bold ? '10px' : '4px'} 0 4px;${hairline ? `border-top:1px solid ${COLOR.text};` : ''}font-size:${bold ? '18px' : '14px'};font-weight:${bold ? '700' : '400'};color:${bold ? COLOR.text : COLOR.muted};">${label}</td>
        <td style="padding:${bold ? '10px' : '4px'} 0 4px;${hairline ? `border-top:1px solid ${COLOR.text};` : ''}font-size:${bold ? '18px' : '14px'};font-weight:${bold ? '700' : '400'};color:${bold ? COLOR.text : COLOR.text};text-align:right;font-family:${MONO};">${value}</td>
      </tr>`;
    }

    const totalsHtml = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:8px 0 20px;">
      ${totalsRow('Subtotal', formatGHS(subtotal))}
      ${totalsRow('Shipping', shipping === 0 ? 'Free' : formatGHS(shipping))}
      ${totalsRow('VAT (12.5%)', formatGHS(tax))}
      ${discount > 0 ? totalsRow('Discount', `− ${formatGHS(discount)}`) : ''}
      ${credit > 0 ? totalsRow('Store credit', `− ${formatGHS(credit)}`) : ''}
      ${totalsRow('Total', formatGHS(total), { bold: true, hairline: true })}
    </table>`;

    // Structured address block: name gets its own emphasized line, everything
    // else is 14px muted — empty fields (line2 in particular) are skipped
    // entirely rather than leaving a blank line.
    const addressLine = `<p style="margin:0 0 4px;font-size:14px;color:${COLOR.muted};line-height:1.6;">`;
    const cityRegion = [address.city, address.state].filter(Boolean).join(', ');
    const addressBodyLines = [
      address.line1,
      address.line2,
      cityRegion,
      address.country,
      address.phone ? `Tel: ${formatPhoneGh(address.phone)}` : null,
    ].filter(Boolean).map((line) => `${addressLine}${escapeHtml(line)}</p>`).join('');

    const addressBlock = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:16px 0 20px;">
      <tr>
        <td style="background-color:${COLOR.bg};border:1px solid ${COLOR.border};border-radius:8px;padding:16px;">
          <p style="margin:0 0 8px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${COLOR.muted};">Shipping to</p>
          ${address.name ? `<p style="margin:0 0 4px;font-size:15px;font-weight:500;color:${COLOR.text};">${escapeHtml(titleCase(address.name))}</p>` : ''}
          ${addressBodyLines}
        </td>
      </tr>
    </table>`;

    const deliveryLine = shippingLabel(shipping, expressRateGhs);

    const bodyHtml = `
      ${eyebrow('Order confirmed')}
      ${h1(`Thanks, ${escapeHtml(first)}.`)}
      <p style="margin:0 0 4px;font-family:${MONO};font-size:13px;color:${COLOR.muted};">${escapeHtml(order.order_number)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:20px 0 4px;">
        ${itemRows}
      </table>
      ${totalsHtml}
      ${addressBlock}
      ${ctaButton('View your order', orderUrl)}
      <p style="margin:20px 0 0;font-size:13px;color:${COLOR.muted};">${deliveryLine}</p>
      <p style="margin:16px 0 0;font-size:13px;color:${COLOR.muted};">Questions? Reply to this email{{SUPPORT_WHATSAPP_HTML}}.</p>
    `;

    const itemsText = items.map((it) => `${it.product_name} × ${it.quantity} — ${formatGHS(it.unit_price)}`).join('\n');
    const totalsText = [
      `Subtotal: ${formatGHS(subtotal)}`,
      `Shipping: ${shipping === 0 ? 'Free' : formatGHS(shipping)}`,
      `VAT (12.5%): ${formatGHS(tax)}`,
      discount > 0 ? `Discount: − ${formatGHS(discount)}` : null,
      credit > 0 ? `Store credit: − ${formatGHS(credit)}` : null,
      `Total: ${formatGHS(total)}`,
    ].filter(Boolean).join('\n');

    return {
      subject: `Your UrbanPulse order ${order.order_number}`,
      html: renderLayout({ preheader: `Order ${order.order_number} confirmed · ${formatGHS(total)}`, bodyHtml }),
      text: `Thanks, ${first}.\n\nOrder ${order.order_number}\n\n${itemsText}\n\n${totalsText}\n\n${deliveryLine}\n\nView your order: ${orderUrl}${renderTextFooter()}`,
    };
  },

  // Fires from POST /admin/orders/:id/confirm-cod — the moment an admin
  // confirms a COD order by phone/WhatsApp. This is the "COD confirmation"
  // notice in practice, and also the generic post-payment "preparing" notice
  // for any order manually moved to 'processing'.
  processing: (o) => {
    const bodyHtml = `
      ${eyebrow('Order confirmed')}
      ${h1('Your order is confirmed.')}
      <p style="margin:0 0 4px;font-family:${MONO};font-size:13px;color:${COLOR.muted};">${escapeHtml(o.order_number)}</p>
      <p style="margin:16px 0 0;font-size:15px;line-height:1.6;">We are preparing your order now. Cash will be collected on delivery.</p>
      ${ctaButton('View your order', `${frontendUrl()}/account/orders/${o.id}`)}
    `;
    return {
      subject: `Your UrbanPulse order ${o.order_number} is confirmed`,
      html: renderLayout({ preheader: `Order ${o.order_number} confirmed and being prepared`, bodyHtml }),
      text: `Order ${o.order_number} is confirmed.\n\nWe are preparing your order now. Cash will be collected on delivery.\n\nView your order: ${frontendUrl()}/account/orders/${o.id}${renderTextFooter()}`,
    };
  },

  shipped: (o, trackingNumber = null, { carrier = null, trackingUrl = null, expressRateGhs = null } = {}) => {
    const orderUrl = `${frontendUrl()}/account/orders/${o.id}`;
    const deliveryLine = shippingLabel(o.shipping_cost, expressRateGhs);

    // Graceful degradation: with no tracking number, render exactly today's
    // plain copy — no empty box, no "Tracking: N/A", no layout change at all.
    const trackingBlock = trackingNumber ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:16px 0 0;">
        <tr>
          <td style="background-color:${COLOR.bg};border:1px solid ${COLOR.border};border-radius:8px;padding:16px;">
            <p style="margin:0 0 6px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${COLOR.muted};">Tracking number</p>
            <p style="margin:0;font-family:${FONT};font-size:18px;font-weight:700;letter-spacing:0.5px;color:${COLOR.text};">${escapeHtml(trackingNumber)}</p>
            ${carrier ? `<p style="margin:6px 0 0;font-size:13px;color:${COLOR.muted};">${escapeHtml(carrier)}</p>` : ''}
          </td>
        </tr>
      </table>` : '';

    const secondaryCta = (trackingUrl && carrier) ? ctaButtonOutline(`Track with ${carrier}`, trackingUrl) : '';

    const bodyHtml = `
      ${eyebrow('Order shipped')}
      ${h1('Your order is on its way.')}
      <p style="margin:0 0 4px;font-family:${MONO};font-size:13px;color:${COLOR.muted};">${escapeHtml(o.order_number)}</p>
      ${trackingBlock}
      <p style="margin:16px 0 0;font-size:13px;color:${COLOR.muted};">${deliveryLine}</p>
      ${ctaButton('View your order', orderUrl)}
      ${secondaryCta}
    `;

    const preheader = trackingNumber
      ? `Order ${o.order_number} shipped · Tracking ${trackingNumber}`
      : `Order ${o.order_number} is on its way`;

    const trackingText = trackingNumber
      ? `\nTracking number: ${trackingNumber}${carrier ? ` (${carrier})` : ''}${trackingUrl ? `\nTrack: ${trackingUrl}` : ''}`
      : '';

    return {
      subject: `Order ${o.order_number} has shipped`,
      html: renderLayout({ preheader, bodyHtml }),
      text: `Order ${o.order_number} has shipped.${trackingText}\n\n${deliveryLine}\n\nView your order: ${orderUrl}${renderTextFooter()}`,
    };
  },

  delivered: (o) => {
    const bodyHtml = `
      ${eyebrow('Order delivered')}
      ${h1('Your order has arrived.')}
      <p style="margin:0 0 4px;font-family:${MONO};font-size:13px;color:${COLOR.muted};">${escapeHtml(o.order_number)}</p>
      <p style="margin:16px 0 0;font-size:15px;line-height:1.6;">Enjoy your purchase. If anything isn't right, our returns policy covers you for 30 days.</p>
      ${ctaButton('View your order', `${frontendUrl()}/account/orders/${o.id}`)}
    `;
    return {
      subject: `Order ${o.order_number} delivered`,
      html: renderLayout({ preheader: `Order ${o.order_number} has been delivered`, bodyHtml }),
      text: `Order ${o.order_number} has been delivered. Enjoy your purchase.\n\nView your order: ${frontendUrl()}/account/orders/${o.id}${renderTextFooter()}`,
    };
  },

  // Deliberately the plainest template — security mail shouldn't look like
  // marketing. No eyebrow, minimal body, short expiry notice.
  passwordReset: (link) => {
    const bodyHtml = `
      ${h1('Reset your password.')}
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">We received a request to reset your UrbanPulse password. This link expires in 1 hour.</p>
      ${ctaButton('Reset password', link)}
      <p style="margin:20px 0 0;font-size:13px;color:${COLOR.muted};">If you didn't request this, you can ignore this email — your password will not change.</p>
    `;
    return {
      subject: 'Reset your UrbanPulse password',
      html: renderLayout({ preheader: 'Reset your UrbanPulse password — link expires in 1 hour', bodyHtml }),
      text: `Reset your UrbanPulse password: ${link}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.${renderTextFooter()}`,
    };
  },

  accountDeleted: (name) => {
    const first = firstName(name);
    const bodyHtml = `
      ${eyebrow('Account deleted')}
      ${h1(`Hi ${escapeHtml(first)}.`)}
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">This confirms your UrbanPulse account and personal profile data have been deleted, as you requested.</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:${COLOR.muted};">Order and return records are retained for accounting and legal purposes but are no longer linked to your personal profile.</p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:${COLOR.muted};">If you did not request this, please contact support immediately.</p>
    `;
    return {
      subject: 'Your UrbanPulse account has been deleted',
      html: renderLayout({ preheader: 'Your account and personal data have been deleted', bodyHtml }),
      text: `Hi ${first}.\n\nThis confirms your UrbanPulse account and personal profile data have been deleted, as you requested.\n\nOrder and return records are retained for accounting and legal purposes but are no longer linked to your personal profile.\n\nIf you did not request this, please contact support immediately.${renderTextFooter()}`,
    };
  },

  refunded: (o) => {
    const bodyHtml = `
      ${eyebrow('Refund processed')}
      ${h1('Your refund has been processed.')}
      <p style="margin:0 0 4px;font-family:${MONO};font-size:13px;color:${COLOR.muted};">${escapeHtml(o.order_number)}</p>
      <p style="margin:16px 0 0;font-size:15px;line-height:1.6;"><strong>${formatGHS(o.total)}</strong> will be returned to your original payment method within 5–10 business days.</p>
    `;
    return {
      subject: `Refund processed for order ${o.order_number}`,
      html: renderLayout({ preheader: `${formatGHS(o.total)} refund processed for order ${o.order_number}`, bodyHtml }),
      text: `Your refund for order ${o.order_number} has been processed. ${formatGHS(o.total)} will be returned within 5–10 business days.${renderTextFooter()}`,
    };
  },

  // Admin-facing: fires to notify staff a customer has requested a return.
  returnRequested: (ret, customerName) => {
    const name = titleCase(customerName);
    const bodyHtml = `
      ${eyebrow('New return request')}
      ${h1('A return has been requested.')}
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(name)} has requested a return.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 16px;">
        <tr><td style="padding:6px 0;border-bottom:1px solid ${COLOR.border};font-size:13px;color:${COLOR.muted};width:110px;">RMA</td><td style="padding:6px 0;border-bottom:1px solid ${COLOR.border};font-size:13px;font-family:${MONO};color:${COLOR.text};">${escapeHtml(ret.rma_number)}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:${COLOR.muted};">Resolution</td><td style="padding:6px 0;font-size:13px;color:${COLOR.text};">${escapeHtml(ret.resolution)}</td></tr>
      </table>
      ${ret.customer_note ? `<p style="margin:0 0 16px;font-size:14px;color:${COLOR.muted};">Note: ${escapeHtml(ret.customer_note)}</p>` : ''}
      ${ctaButton('Review in admin console', `${frontendUrl()}/admin/returns`)}
    `;
    return {
      subject: `New return request — ${ret.rma_number}`,
      html: renderLayout({ preheader: `New return request from ${name}`, bodyHtml }),
      text: `New return request from ${name}.\nRMA: ${ret.rma_number}\nResolution: ${ret.resolution}${ret.customer_note ? `\nNote: ${ret.customer_note}` : ''}\n\nReview in admin console: ${frontendUrl()}/admin/returns${renderTextFooter()}`,
    };
  },

  returnApproved: (ret) => {
    const returnAddress = process.env.RETURN_ADDRESS || 'Contact us for the return address.';
    const bodyHtml = `
      ${eyebrow('Return approved')}
      ${h1('Please ship your items back to us.')}
      <p style="margin:0 0 4px;font-family:${MONO};font-size:13px;color:${COLOR.muted};">${escapeHtml(ret.rma_number)}</p>
      <p style="margin:16px 0 12px;font-size:15px;line-height:1.6;">Your return request has been approved. Please ship your items to us and include your RMA number on the parcel.</p>
      <p style="margin:0 0 16px;font-size:14px;font-weight:700;color:${COLOR.text};">${escapeHtml(returnAddress)}</p>
      <p style="margin:0;font-size:14px;color:${COLOR.muted};">Once we receive your items we will process your ${ret.resolution === 'store_credit' ? 'store credit' : ret.resolution}.</p>
    `;
    return {
      subject: `Return ${ret.rma_number} approved — please ship your items`,
      html: renderLayout({ preheader: `Return ${ret.rma_number} approved — ship your items back to us`, bodyHtml }),
      text: `Your return ${ret.rma_number} has been approved.\nShip your items to: ${returnAddress}\nInclude your RMA number on the parcel.${renderTextFooter()}`,
    };
  },

  returnRejected: (ret) => {
    const bodyHtml = `
      ${eyebrow('Return update')}
      ${h1('Your return request was not approved.')}
      <p style="margin:0 0 4px;font-family:${MONO};font-size:13px;color:${COLOR.muted};">${escapeHtml(ret.rma_number)}</p>
      ${ret.admin_note ? `<p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:${COLOR.muted};">Reason: ${escapeHtml(ret.admin_note)}</p>` : ''}
    `;
    return {
      subject: `Update on your return request ${ret.rma_number}`,
      html: renderLayout({ preheader: `An update on your return request ${ret.rma_number}`, bodyHtml }),
      text: `Your return request ${ret.rma_number} was not approved.${ret.admin_note ? `\nReason: ${ret.admin_note}` : ''}\nContact support if you have questions.${renderTextFooter()}`,
    };
  },

  returnRefunded: (ret, amount) => {
    const isCredit = ret.resolution === 'store_credit';
    const bodyHtml = `
      ${eyebrow('Return processed')}
      ${h1(isCredit ? 'Store credit issued.' : 'Refund issued.')}
      <p style="margin:0 0 4px;font-family:${MONO};font-size:13px;color:${COLOR.muted};">${escapeHtml(ret.rma_number)}</p>
      <p style="margin:16px 0 0;font-size:15px;line-height:1.6;">A ${isCredit ? 'store credit' : 'refund'} of <strong>${formatGHS(amount)}</strong> has been issued.</p>
      <p style="margin:16px 0 0;font-size:14px;color:${COLOR.muted};">${isCredit ? 'Your store credit is available immediately for your next order.' : 'Please allow 5–10 business days for the refund to appear.'}</p>
    `;
    return {
      subject: `Your refund of ${formatGHS(amount)} has been issued`,
      html: renderLayout({ preheader: `${formatGHS(amount)} ${isCredit ? 'store credit' : 'refund'} issued for return ${ret.rma_number}`, bodyHtml }),
      text: `Your return ${ret.rma_number} has been processed. A ${isCredit ? 'store credit' : 'refund'} of ${formatGHS(amount)} has been issued.${renderTextFooter()}`,
    };
  },

  referralReward: ({ name }) => {
    const first = firstName(name);
    const bodyHtml = `
      ${eyebrow('Referral reward')}
      ${h1(`Hi ${escapeHtml(first)}.`)}
      <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Your friend just completed their first order on UrbanPulse — you both earned <strong>GH₵ 50 in store credit</strong>.</p>
      <p style="margin:0;font-size:15px;line-height:1.6;color:${COLOR.muted};">It's in your account now, ready for your next order.</p>
      ${ctaButton('View your account', `${frontendUrl()}/account`)}
    `;
    return {
      subject: 'You both earned GH₵ 50 in store credit',
      html: renderLayout({ preheader: 'You and your friend both earned GH₵ 50 in store credit', bodyHtml, transactional: false }),
      text: `Hi ${first}.\n\nYour friend completed their first UrbanPulse order. You've both earned GH₵ 50 in store credit — it's in your account now.${renderTextFooter({ transactional: false })}`,
    };
  },

  abandonedCart: ({ user, items, coupon, cartUrl }) => {
    const first = firstName(user?.name);
    const itemRows = items.map((it) => `
      <tr>
        <td width="64" style="padding:12px 0;border-bottom:1px solid ${COLOR.border};vertical-align:top;width:64px;">
          <img src="${it.images?.[0] ?? ''}" width="64" alt="${escapeHtml(it.name)}" style="width:64px;height:auto;border-radius:6px;display:block;" />
        </td>
        <td width="100%" style="padding:12px 0 12px 12px;border-bottom:1px solid ${COLOR.border};vertical-align:top;width:100%;">
          <strong style="font-size:15px;font-weight:600;color:${COLOR.text};">${escapeHtml(it.name)}</strong><br/>
          <span style="color:${COLOR.muted};font-size:13px;">${escapeHtml([it.size, it.color].filter(Boolean).join(' · '))}</span>
        </td>
        <td style="padding:12px 0 12px 16px;border-bottom:1px solid ${COLOR.border};vertical-align:top;white-space:nowrap;font-size:14px;color:${COLOR.muted};text-align:right;">${it.quantity} × ${formatGHS(it.price)}</td>
      </tr>`).join('');
    const couponLine = coupon
      ? `<p style="margin:16px 0 0;font-size:14px;">Use code <strong style="font-family:${MONO};">${escapeHtml(coupon)}</strong> at checkout for a little extra off.</p>`
      : '';
    const couponText = coupon ? `\nUse code ${coupon} at checkout.` : '';

    const bodyHtml = `
      ${eyebrow('Still in your bag')}
      ${h1(`Hi ${escapeHtml(first)}.`)}
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;">You left a few things in your bag. They're still waiting.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 4px;">
        ${itemRows}
      </table>
      ${couponLine}
      ${ctaButton('Return to your bag', cartUrl)}
    `;
    return {
      subject: `${first}, you left something behind`,
      html: renderLayout({ preheader: 'A few things are still waiting in your bag', bodyHtml, transactional: false }),
      text: `Hi ${first}.\n\nYou left a few things in your bag.\n\n${items.map((it) => `${it.name} × ${it.quantity}`).join('\n')}${couponText}\n\nReturn to your bag: ${cartUrl}${renderTextFooter({ transactional: false })}`,
    };
  },
};
