import nodemailer from 'nodemailer';
import { logger } from './logger.js';

let transporter = null;

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
  const t = getTransporter();
  if (!t) {
    logger.info({ to, subject, text }, '[email] dev-mode log');
    return;
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || 'UrbanPulse <noreply@urbanpulse.com>',
    to, subject, html, text,
  });
}

export const emailTemplates = {
  loginAlert: ({ name, device, ip, time }) => {
    const first = name?.split(' ')[0] ?? 'there';
    return {
      subject: 'New sign-in to your UrbanPulse account',
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#111">
               <p style="font-size:15px">Hi ${first},</p>
               <p style="font-size:15px">Your account was just signed in from a new device.</p>
               <table style="margin:16px 0;border-collapse:collapse;width:100%">
                 <tr><td style="padding:6px 12px 6px 0;color:#888;font-size:13px">Device</td><td style="font-size:13px">${device}</td></tr>
                 <tr><td style="padding:6px 12px 6px 0;color:#888;font-size:13px">IP address</td><td style="font-size:13px">${ip}</td></tr>
                 <tr><td style="padding:6px 12px 6px 0;color:#888;font-size:13px">Time</td><td style="font-size:13px">${new Date(time).toUTCString()}</td></tr>
               </table>
               <p style="font-size:14px">If this was you, no action is needed. If not, please change your password immediately and enable two-factor authentication.</p>
             </div>`,
      text: `Hi ${first},\n\nYour UrbanPulse account was signed in from:\nDevice: ${device}\nIP: ${ip}\nTime: ${new Date(time).toUTCString()}\n\nNot you? Change your password now.`,
    };
  },
  orderConfirmation: (order) => ({
    subject: `Order ${order.order_number} confirmed`,
    html: `<h1>Thanks for your order</h1><p>Your order <strong>${order.order_number}</strong> has been received. Total: GH₵ ${order.total}.</p>`,
    text: `Thanks for your order ${order.order_number}. Total: GH₵ ${order.total}.`,
  }),
  processing: (o) => ({
    subject: `Order ${o.order_number} is being prepared`,
    html: `<p>Good news! Your order <strong>${o.order_number}</strong> is now being prepared.</p>`,
    text: `Good news! Your order ${o.order_number} is now being prepared.`,
  }),
  shipped: (o) => ({
    subject: `Order ${o.order_number} has shipped`,
    html: `<p>Your order <strong>${o.order_number}</strong> is on its way!</p>`,
    text: `Your order ${o.order_number} is on its way!`,
  }),
  delivered: (o) => ({
    subject: `Order ${o.order_number} delivered`,
    html: `<p>Your order <strong>${o.order_number}</strong> has been delivered. Enjoy your purchase!</p>`,
    text: `Your order ${o.order_number} has been delivered. Enjoy!`,
  }),
  passwordReset: (link) => ({
    subject: 'Reset your UrbanPulse password',
    html: `<p>Click to reset: <a href="${link}">${link}</a> — expires in 1 hour.</p>`,
    text: `Reset link: ${link}`,
  }),
  refunded: (o) => ({
    subject: `Refund processed for order ${o.order_number}`,
    html: `<p>Your refund for order <strong>${o.order_number}</strong> has been processed. GH₵ ${o.total} will be returned to your original payment method within 5–10 business days.</p>`,
    text: `Your refund for order ${o.order_number} has been processed. GH₵ ${o.total} will be returned within 5–10 business days.`,
  }),
  returnRequested: (ret, customerName) => ({
    subject: `New return request — ${ret.rma_number}`,
    html: `<p>A new return has been requested by <strong>${customerName}</strong>.</p>
           <p>RMA: <strong>${ret.rma_number}</strong> &nbsp;|&nbsp; Resolution: ${ret.resolution}</p>
           ${ret.customer_note ? `<p>Note: ${ret.customer_note}</p>` : ''}
           <p>Please review it in the admin console.</p>`,
    text: `New return request from ${customerName}.\nRMA: ${ret.rma_number}\nResolution: ${ret.resolution}${ret.customer_note ? `\nNote: ${ret.customer_note}` : ''}\nReview in the admin console.`,
  }),
  returnApproved: (ret) => ({
    subject: `Return ${ret.rma_number} approved — please ship your items`,
    html: `<p>Your return request <strong>${ret.rma_number}</strong> has been approved.</p>
           <p>Please ship your items to us at the address below and include your RMA number on the parcel:</p>
           <p><strong>${process.env.RETURN_ADDRESS || 'Contact us for the return address.'}</strong></p>
           <p>Once we receive your items we will process your ${ret.resolution === 'store_credit' ? 'store credit' : ret.resolution}.</p>`,
    text: `Your return ${ret.rma_number} has been approved.\nShip your items to: ${process.env.RETURN_ADDRESS || 'Contact us for the return address.'}\nInclude your RMA number on the parcel.`,
  }),
  returnRejected: (ret) => ({
    subject: `Update on your return request ${ret.rma_number}`,
    html: `<p>Unfortunately your return request <strong>${ret.rma_number}</strong> could not be approved.</p>
           ${ret.admin_note ? `<p>Reason: ${ret.admin_note}</p>` : ''}
           <p>If you have questions, please reach out to our support team.</p>`,
    text: `Your return request ${ret.rma_number} was not approved.${ret.admin_note ? `\nReason: ${ret.admin_note}` : ''}\nContact support if you have questions.`,
  }),
  returnRefunded: (ret, amount) => ({
    subject: `Your refund of GH₵ ${Number(amount).toFixed(2)} has been issued`,
    html: `<p>Good news — your return <strong>${ret.rma_number}</strong> has been processed.</p>
           <p>A ${ret.resolution === 'store_credit' ? 'store credit' : 'refund'} of <strong>GH₵ ${Number(amount).toFixed(2)}</strong> has been issued to your account.</p>
           ${ret.resolution === 'store_credit' ? '<p>Your store credit is available immediately for your next order.</p>' : '<p>Please allow 5–10 business days for the refund to appear.</p>'}`,
    text: `Your return ${ret.rma_number} has been processed. A ${ret.resolution === 'store_credit' ? 'store credit' : 'refund'} of GH₵ ${Number(amount).toFixed(2)} has been issued.`,
  }),
  referralReward: ({ name }) => {
    const first = name.split(' ')[0];
    return {
      subject: 'You both earned GH₵ 50 in store credit',
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#111">
               <p style="font-size:15px">Hi ${first},</p>
               <p style="font-size:15px">Your friend just completed their first order on UrbanPulse — and you both earned <strong>GH₵ 50 in store credit</strong>.</p>
               <p style="font-size:15px">It's waiting in your account, ready for your next order.</p>
             </div>`,
      text: `Hi ${first},\n\nYour friend completed their first UrbanPulse order. You've both earned GH₵ 50 in store credit — it's in your account now.`,
    };
  },
  abandonedCart: ({ user, items, coupon, cartUrl }) => {
    const itemRows = items.map((it) =>
      `<tr>
         <td style="padding:8px 8px 8px 0;vertical-align:top"><img src="${it.images?.[0] ?? ''}" width="60" height="72" style="border-radius:6px;object-fit:cover;display:block"/></td>
         <td style="padding:8px 12px;vertical-align:top">
           <strong style="font-size:14px">${it.name}</strong><br/>
           <span style="color:#888;font-size:12px">${[it.size, it.color].filter(Boolean).join(' · ')}</span>
         </td>
         <td style="padding:8px 0;vertical-align:top;white-space:nowrap;font-size:14px">GH₵ ${Number(it.price).toFixed(2)} × ${it.quantity}</td>
       </tr>`
    ).join('');
    const couponLine = coupon
      ? `<p style="margin:16px 0;font-size:14px">Use code <strong>${coupon}</strong> at checkout for a little extra off.</p>`
      : '';
    const couponText = coupon ? `Use code ${coupon} at checkout.\n\n` : '';
    const firstName = user.name?.split(' ')[0] ?? 'there';
    return {
      subject: `${firstName}, you left something behind`,
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#111">
               <p style="font-size:15px">Hi ${user.name ?? 'there'},</p>
               <p style="font-size:15px">You left a few things in your bag. They're still waiting.</p>
               <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0;width:100%">${itemRows}</table>
               ${couponLine}
               <a href="${cartUrl}" style="display:inline-block;margin-top:8px;padding:12px 28px;background:#000;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Return to bag</a>
             </div>`,
      text: `Hi ${user.name ?? 'there'},\n\nYou left a few things in your bag.\n\n${items.map((it) => `${it.name} × ${it.quantity}`).join('\n')}\n\n${couponText}Return to your bag: ${cartUrl}`,
    };
  },
};
