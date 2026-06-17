import crypto from 'crypto';

const PAYSTACK_API = 'https://api.paystack.co';

function secret() {
  if (!process.env.PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY missing');
  return process.env.PAYSTACK_SECRET_KEY;
}

/**
 * Initialize a Paystack transaction.
 * Amount must be in pesewas (1 GHS = 100 pesewas).
 * Docs: https://paystack.com/docs/api/transaction/#initialize
 */
export async function initializeTransaction({
  email, amount, reference, callback_url, metadata,
  channels = ['mobile_money', 'card', 'bank'],
}) {
  const res = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: Math.round(Number(amount) * 100), // GHS → pesewas
      currency: 'GHS',
      reference,
      callback_url,
      metadata,
      channels,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data?.message || `Paystack init failed (${res.status})`);
  }
  return data.data; // { authorization_url, access_code, reference }
}

/**
 * Verify a transaction by reference (fallback when webhook hasn't fired yet).
 * Docs: https://paystack.com/docs/api/transaction/#verify
 */
export async function verifyTransaction(reference) {
  const res = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret()}` },
  });
  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data?.message || `Paystack verify failed (${res.status})`);
  }
  return data.data;
}

/**
 * Verify the Paystack webhook signature.
 * Paystack sends an HMAC-SHA512 of the raw request body in the `x-paystack-signature` header.
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;
  const hash = crypto
    .createHmac('sha512', secret())
    .update(rawBody)
    .digest('hex');
  // Use timingSafeEqual to avoid timing attacks
  const a = Buffer.from(hash, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Refund a Paystack transaction by reference.
 * Amount is optional — omit for a full refund.
 * Docs: https://paystack.com/docs/api/refund/#create
 */
export async function refundTransaction(reference, amount = null) {
  const body = { transaction: reference };
  if (amount != null) body.amount = Math.round(Number(amount) * 100); // GHS → pesewas
  const res = await fetch(`${PAYSTACK_API}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(data?.message || `Paystack refund failed (${res.status})`);
  }
  return data.data;
}
