// TODO: Replace with real business details once registered.
import PDFDocument from 'pdfkit';

const BUSINESS = {
  name:    'UrbanPulse Ltd',
  address: 'Accra, Ghana',
  email:   'support@urbanpulse.com.gh',
  website: 'urbanpulse.com.gh',
};

const ACCENT = '#D85A30';
const TEXT   = '#1A1A1A';
const MUTED  = '#6B6B66';
const BORDER = '#E5E5E0';

function formatGHS(amount) {
  const [int, dec] = Number(amount || 0).toFixed(2).split('.');
  return `GH₵ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

/**
 * Generates an A4 PDF receipt for a paid order.
 *
 * @param {object} order         - Full order row from the orders table
 * @param {object[]} items       - Rows from order_items
 * @param {object|null} user     - { name, email } from users table (or null for guest)
 * @param {{ couponDiscount?: number }} options
 * @returns {Promise<Buffer>}
 */
export async function generateReceiptPDF(order, items, user, { couponDiscount = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c  => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Wordmark ──────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(20).fillColor(TEXT)
       .text('urban', 50, 52, { continued: true });
    doc.fillColor(ACCENT).text('pulse');

    // ── "RECEIPT" eyebrow + order number (right-aligned) ─────────────────────
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text('RECEIPT', 50, 52, { align: 'right', width: 495 });
    doc.font('Courier-Bold').fontSize(11).fillColor(TEXT)
       .text(order.order_number, 50, 63, { align: 'right', width: 495 });

    // ── Header divider ────────────────────────────────────────────────────────
    doc.moveTo(50, 90).lineTo(545, 90).strokeColor(BORDER).lineWidth(1).stroke();

    // ── From / Bill-to blocks ─────────────────────────────────────────────────
    const rawAddr = order.shipping_address;
    const addr    = typeof rawAddr === 'string' ? JSON.parse(rawAddr) : (rawAddr ?? {});

    const customerName  = addr?.name  || user?.name  || order.email || 'Customer';
    const customerEmail = user?.email || order.email || '';
    const addrLines     = [
      addr?.line1,
      addr?.line2,
      [addr?.city, addr?.state].filter(Boolean).join(', '),
      addr?.zip,
      addr?.country,
    ].filter(Boolean);

    const IY = 104;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('FROM', 50, IY);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(BUSINESS.name,    50, IY + 13)
       .text(BUSINESS.address, 50, IY + 25)
       .text(BUSINESS.email,   50, IY + 37);

    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('BILL TO', 310, IY);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(customerName,  310, IY + 13)
       .text(customerEmail, 310, IY + 25);
    let ay = IY + 37;
    for (const line of addrLines) { doc.text(line, 310, ay); ay += 12; }

    // ── Order meta row ────────────────────────────────────────────────────────
    const MY = Math.max(ay, IY + 55) + 12;
    doc.moveTo(50, MY).lineTo(545, MY).strokeColor(BORDER).lineWidth(0.5).stroke();

    const orderDate    = new Date(order.created_at).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    });
    const paymentLabel = order.payment_method === 'cod' ? 'Cash on Delivery' : 'Paystack';
    const statusText   = (order.status || '').replace(/_/g, ' ');

    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
       .text(
         `Order date: ${orderDate}   ·   Payment: ${paymentLabel}   ·   Status: ${statusText}`,
         50, MY + 9, { width: 495 }
       );

    // ── Line items table ──────────────────────────────────────────────────────
    const TY  = MY + 32;
    const COL = { item: 50, qty: 340, unit: 390, total: 470 };

    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
    doc.text('ITEM',  COL.item,  TY);
    doc.text('QTY',   COL.qty,   TY);
    doc.text('UNIT',  COL.unit,  TY);
    doc.text('TOTAL', COL.total, TY);
    doc.moveTo(50, TY + 14).lineTo(545, TY + 14).strokeColor(BORDER).lineWidth(0.5).stroke();

    let ry = TY + 22;
    for (const it of items) {
      const lineTotal   = Number(it.unit_price) * it.quantity;
      const variantRaw  = (it.variant_description || '').trim().replace(/^\/+|\/+$/g, '').trim();
      const hasVariant  = variantRaw.length > 0;

      doc.font('Helvetica').fontSize(9).fillColor(TEXT)
         .text(it.product_name, COL.item, ry, { width: 275 });

      if (hasVariant) {
        doc.font('Helvetica').fontSize(8).fillColor(MUTED)
           .text(variantRaw, COL.item, ry + 12, { width: 275 });
      }

      doc.font('Helvetica').fontSize(9).fillColor(TEXT)
         .text(String(it.quantity),        COL.qty,   ry)
         .text(formatGHS(it.unit_price),   COL.unit,  ry)
         .text(formatGHS(lineTotal),       COL.total, ry);

      ry += hasVariant ? 30 : 20;
    }

    // ── Totals block ──────────────────────────────────────────────────────────
    doc.moveTo(50, ry + 6).lineTo(545, ry + 6).strokeColor(BORDER).lineWidth(0.5).stroke();

    const subtotal = Number(order.subtotal);
    const shipping = Number(order.shipping_cost);
    const tax      = Number(order.tax);
    const total    = Number(order.total);
    // Store credit is not stored directly — derive from the totals equation
    const credit   = Math.max(0, +(subtotal + shipping + tax - couponDiscount - total).toFixed(2));

    const TX = 360, VX = 470;
    let ty = ry + 18;

    function totRow(label, value, bold = false) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(bold ? 10 : 9)
         .fillColor(bold ? TEXT : MUTED)
         .text(label, TX, ty)
         .text(value, VX, ty, { align: 'right', width: 75 });
      ty += bold ? 18 : 14;
    }

    totRow('Subtotal',    formatGHS(subtotal));
    totRow('Shipping',    shipping === 0 ? 'Free' : formatGHS(shipping));
    totRow('VAT (12.5%)', formatGHS(tax));
    if (couponDiscount > 0) totRow('Discount',     `− ${formatGHS(couponDiscount)}`);
    if (credit > 0)         totRow('Store credit', `− ${formatGHS(credit)}`);

    doc.moveTo(TX, ty).lineTo(545, ty).strokeColor(TEXT).lineWidth(0.5).stroke();
    ty += 8;
    totRow('Total', formatGHS(total), true);

    // ── Footer ────────────────────────────────────────────────────────────────
    const FY = doc.page.height - 70;
    doc.moveTo(50, FY).lineTo(545, FY).strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
       .text('Thank you for shopping with UrbanPulse.',
             50, FY + 10, { align: 'center', width: 495 })
       .text('Returns accepted within 30 days — see urbanpulse.com.gh/returns-policy',
             50, FY + 22, { align: 'center', width: 495 })
       .text(BUSINESS.email,
             50, FY + 34, { align: 'center', width: 495 });

    doc.end();
  });
}
