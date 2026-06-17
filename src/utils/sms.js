import { logger } from './logger.js';

function isConfigured() {
  return !!process.env.SMS_API_KEY;
}

/**
 * Send an SMS via a provider-agnostic JSON API.
 * Defaults to Arkesel v2 format. To switch providers set SMS_BASE_URL and
 * adjust headers/body to match your provider (e.g. Hubtel).
 * Docs: https://developers.arkesel.com / https://developers.hubtel.com
 */
export async function sendSMS({ to, message }) {
  if (!isConfigured()) {
    logger.info({ to, message }, '[sms] dev-mode log');
    return;
  }
  const res = await fetch(
    process.env.SMS_BASE_URL || 'https://sms.arkesel.com/api/v2/sms/send',
    {
      method: 'POST',
      headers: {
        'api-key': process.env.SMS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: process.env.SMS_SENDER_ID || 'UrbanPulse',
        message,
        recipients: [to],
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SMS send failed (${res.status}): ${text}`);
  }
  return res.json();
}

export const smsTemplates = {
  paid:       (o) => `UrbanPulse: Payment confirmed for order ${o.order_number}. Total: GH₵ ${Number(o.total).toFixed(2)}. Thank you!`,
  processing: (o) => `UrbanPulse: Order ${o.order_number} is being prepared and will ship soon.`,
  shipped:    (o) => `UrbanPulse: Order ${o.order_number} has shipped! Check your email for tracking info.`,
  delivered:  (o) => `UrbanPulse: Order ${o.order_number} has been delivered. Enjoy your purchase!`,
};
