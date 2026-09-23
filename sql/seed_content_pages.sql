-- Seed data for the content_pages CMS table (About, FAQ, and 4 policy pages).
-- The content_pages table already exists in both dev and prod -- this file
-- seeds/updates rows only, it does not create or alter any schema.
--
-- Idempotent: safe to re-run. Re-running after a real admin edit will NOT
-- clobber their title/body/meta_description/is_published changes back to
-- this seed's values... actually it WILL overwrite those columns (that's
-- the point of ON CONFLICT DO UPDATE, for re-seeding), but it deliberately
-- leaves `updated_by` untouched on conflict so attribution isn't reset to
-- the seed's placeholder admin.
--
-- Run manually against each database (this project has no migration
-- tooling -- schema changes are made by hand in pgAdmin, and seeds are run
-- by hand too):
--   psql "$DATABASE_URL" -f backend/sql/seed_content_pages.sql
--
-- IMPORTANT -- verify before running in prod:
--   updated_by is populated via `(SELECT id FROM users WHERE role = 'admin'
--   ORDER BY id LIMIT 1)` rather than NULL, since it's unknown whether that
--   FK column allows NULL in the hand-created schema. Confirm at least one
--   users.role = 'admin' row exists in BOTH databases before running this --
--   if that subquery returns no rows, the INSERT will fail on a NOT NULL
--   (or simply insert NULL if the column is nullable and no admin exists yet).

INSERT INTO content_pages (slug, title, body, meta_description, is_published, updated_by)
VALUES
(
  'about',
  'About',
  $about$
**Built from here. For here.**

UrbanPulse is a streetwear label from Accra, started and run by its founder, Jeffrey.

It starts small on purpose. The first pieces are in the shop now, the Ghana Jersey and the Baggy Jeans, and the collection grows one drop at a time.

## What we stand for

### Small drops.
New pieces arrive when they're ready, not to fill a catalogue.

### Made for here.
Built for Accra, and for the way people here shop: on the phone, paying with Mobile Money or card.

### Straight answers.
If something isn't right, you have 30 days to send it back.

## Behind the brand

> UrbanPulse is run by one person. When you message us, you're talking to me.
>
> — Jeffrey, Founder

[Browse the collection](/shop) · [View the lookbook](/lookbook)
$about$,
  $md$UrbanPulse is a streetwear label from Accra. Shop the Ghana Jersey and Baggy Jeans, and pay with Mobile Money or card.$md$,
  true,
  (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
),
(
  'faq',
  'FAQ',
  $faq$
Can't find what you're looking for? Email [noreply.urbanpulse0@gmail.com](mailto:noreply.urbanpulse0@gmail.com).

## Where do you deliver?
Anywhere in Ghana. We don't ship internationally yet.

## How much is delivery?
Standard delivery is GH₵30 and express is GH₵80. Orders over GH₵200 get free delivery. You'll see the exact cost at checkout before you pay.

## How long does delivery take?
It depends on where you are in Ghana. We'll email you as soon as your order ships, with tracking details when the courier provides them.

## How can I pay?
Mobile Money or card, securely through Paystack. You can also choose to pay on delivery at checkout.

## What is your return policy?
You have 30 days from delivery to return an item that's unworn and unwashed. Start a return from your account under Orders, and we'll take it from there.

## How do I know what size to order?
Every product page has a Size guide tab. If you're between sizes, email us and we'll help.

## How do I track my order?
Sign in and open your account's Orders page to see where your order is. When it ships, you'll also get an email with tracking details when available.

## Can I change or cancel my order?
Email us as soon as possible after ordering. If it hasn't shipped yet, we'll do our best to change or cancel it.
$faq$,
  $md$Answers to common questions about shipping, returns, sizing, and order tracking at UrbanPulse.$md$,
  true,
  (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
),
(
  'returns-policy',
  'Returns Policy',
  $returns$
## 1. Return eligibility
We accept returns on items that meet all of the following conditions:
- Unworn and unwashed — in the same condition as received
- Original hang tags still attached
- Original packaging included where possible
- Return requested within 30 days of the delivery date

## 2. Non-returnable items
The following items cannot be returned under any circumstances:
- Items marked as Final Sale at the time of purchase
- Undergarments and swimwear (for hygiene reasons)
- Customised or personalised pieces
- Items that have been worn, washed, or altered

## 3. How to request a return
Returns are initiated through your account — there is no need to contact support first for standard returns:
1. Log in to your account on this website
2. Go to **Orders** and find the relevant delivered order
3. Click **Request return**
4. Select the items you wish to return, the reason, and your preferred resolution (refund or exchange)
5. Submit — you will receive a confirmation email

Returns can only be requested within 30 days of the delivery date.

## 4. What happens next
Our team reviews all return requests within 2 business days. If approved, you will receive an email with return shipping instructions and the address to send your item to.

Unless the item is defective or we sent the wrong item (see section 7), the cost of return postage is the customer's responsibility. We recommend using a tracked service — we cannot process refunds for items that do not arrive.

## 5. Inspection and refunds
Once we receive your return, we inspect it within 2 business days. Refunds are processed within 5 business days of a successful inspection.

Refund options:
- **Original payment method** (card or mobile money via Paystack) — refund typically appears in your account within 5–10 business days after processing
- **Store credit** — issued instantly to your UrbanPulse account balance; no transaction fee deducted; can be used on any future order

## 6. Exchanges
Exchanges follow the same return process — simply select "Exchange" as your resolution type when submitting the request. Exchanges are subject to the availability of the requested item at the time your return is processed.

If the requested exchange item is unavailable, we will issue a refund instead.

## 7. Defective or incorrect items
If you received a defective item or we sent you the wrong item, please contact our support team immediately with photos of the issue. In these cases:
- We will cover the full cost of return shipping
- Your return will be prioritised
- You may request a full refund, exchange, or store credit

Contact: [noreply.urbanpulse0@gmail.com](mailto:noreply.urbanpulse0@gmail.com) or via our [contact page](/contact).

## 8. Refund timing
Paystack refunds to the original card or mobile money account typically appear within 5–10 business days after we initiate them, depending on your bank or mobile money provider.

Store credit is added to your account balance instantly once the return is approved.

## 9. Order cancellations
Orders can be cancelled before they are dispatched. Contact us as soon as possible at [noreply.urbanpulse0@gmail.com](mailto:noreply.urbanpulse0@gmail.com) or via [our contact page](/contact). Once an order has been dispatched, it cannot be cancelled — please use the returns process instead.
$returns$,
  $md$How to return an UrbanPulse order, what's eligible, and how refunds are processed.$md$,
  true,
  (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
),
(
  'privacy',
  'Privacy Policy',
  $privacy$
## 1. Introduction
UrbanPulse is an online streetwear and accessories retailer based in Accra, Ghana. This Privacy Policy explains what personal data we collect when you use our website and services, why we collect it, how we use and protect it, and what rights you have over it.

By creating an account or placing an order, you acknowledge that you have read this policy. If you do not agree with how we handle personal data, please do not use our services.

## 2. Data we collect
We collect the following categories of personal data:
- **Account data** — your name, email address, phone number, and hashed password when you register.
- **Order data** — shipping address, items purchased, order history, and payment status.
- **Payment data** — all payment processing is handled by Paystack. We never see or store your card details, mobile money PIN, or bank credentials. Paystack is PCI-DSS certified.
- **Browsing data** — pages you view, items added to your cart or wishlist, and session information for authentication.
- **Communications** — emails, SMS messages, and WhatsApp messages you exchange with our support team.

## 3. How we use your data
We use personal data only for the purposes described below:
- Fulfilling and delivering your orders
- Sending order confirmations, shipping updates, and delivery notifications
- Responding to support requests and returns
- Detecting and preventing fraud or abuse
- Improving the website and shopping experience
- Sending marketing communications — only if you have opted in; you can unsubscribe at any time

We do not use automated decision-making that has legal effects on you.

## 4. Who we share data with
We share personal data only with the third parties necessary to operate our service:
- **Paystack** — payment processing (card, mobile money, bank transfer)
- **Shipping partners** — your name and delivery address are shared with the courier handling your order
- **Email and SMS providers** — for order notifications and transactional messages

We do not sell, rent, or trade your personal data to advertisers or any other third parties for their own marketing purposes.

## 5. Cookies and tracking
We use session cookies to keep you logged in during your visit. These are strictly necessary and cannot be turned off without breaking authentication.

We do not currently use any third-party analytics trackers or advertising pixels. If this changes, we will update this policy and notify registered users.

## 6. Your rights under Ghana's Data Protection Act
Under the Data Protection Act, 2012 (Act 843), you have the following rights regarding the personal data we hold about you:
- **Access** — request a copy of the personal data we hold about you
- **Correction** — ask us to correct inaccurate or incomplete data
- **Deletion** — request that we delete your account and associated data, subject to legal retention obligations
- **Objection** — object to processing of your data for marketing purposes at any time
- **Complaint** — lodge a complaint with Ghana's [Data Protection Commission](https://dataprotection.org.gh)

To exercise any of these rights, contact us at [noreply.urbanpulse0@gmail.com](mailto:noreply.urbanpulse0@gmail.com). We will respond within 30 days.

## 7. Data retention
We retain order records for 7 years to comply with Ghanaian tax and commercial law. If you request deletion of your account, we will delete or anonymise all personal data not subject to legal retention obligations within 30 days.

Session data and cart contents are cleared when you log out or after a period of inactivity.

## 8. Security
We take reasonable technical and organisational measures to protect your personal data:
- Passwords are hashed using industry-standard algorithms; we cannot retrieve them
- All data transmitted to and from our website uses HTTPS encryption
- Two-factor authentication (2FA) is available for your account
- No payment card data is ever stored on our servers (handled by Paystack)

No system is completely secure. If you believe your account has been compromised, contact us immediately.

## 9. Children
Our services are not directed at persons under 18 years of age. We do not knowingly collect personal data from minors. If you believe a child has provided us with personal data, please contact us so we can delete it.

## 10. International data transfers
Paystack and our email and SMS service providers may process your data on servers located outside Ghana. Where this occurs, we take steps to ensure your data is handled with an equivalent level of protection, including reviewing the data protection practices of our providers.

## 11. Changes to this policy
If we make material changes to this policy, we will notify registered users by email at least 14 days before the changes take effect. We will also update the "Last updated" date at the top of this page. Continued use of the service after changes take effect constitutes acceptance of the revised policy.

## 12. Contact
Questions about this policy or your personal data? Reach us at [noreply.urbanpulse0@gmail.com](mailto:noreply.urbanpulse0@gmail.com) or through our [contact page](/contact).
$privacy$,
  $md$How UrbanPulse collects, uses, and protects your personal data under Ghana's Data Protection Act.$md$,
  true,
  (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
),
(
  'terms',
  'Terms of Service',
  $terms$
## 1. Acceptance of terms
By accessing or using this website (the "Site"), creating an account, or placing an order, you agree to be bound by these Terms of Service. If you do not agree, please do not use our services.

## 2. About us
UrbanPulse is an online streetwear and accessories retailer operating in Ghana.

Business registration number: [TODO — insert on registration]
Contact: [noreply.urbanpulse0@gmail.com](mailto:noreply.urbanpulse0@gmail.com)

## 3. Your account
When you create an account, you agree to:
- Provide accurate, current, and complete registration information
- Maintain one account per person — multiple accounts are not permitted
- Keep your password secure and not share it with others
- Notify us immediately at [noreply.urbanpulse0@gmail.com](mailto:noreply.urbanpulse0@gmail.com) if you believe your account has been accessed without authorisation

You are responsible for all activity that occurs under your account.

## 4. Orders and pricing
All prices are in Ghana Cedis (GH₵) and include 12.5% VAT unless otherwise stated. We reserve the right to correct pricing errors before an order is fulfilled — in that case, we will contact you before proceeding.

We reserve the right to refuse or cancel any order at our discretion, including where items are out of stock, where we suspect fraud, or where an order contains an error. Stock availability is not guaranteed until checkout is complete and payment is confirmed.

## 5. Payment
We accept payment via Paystack (card, mobile money, and bank transfer) and Cash on Delivery (COD). All Paystack transactions are subject to Paystack's terms and security requirements. COD orders require phone confirmation before dispatch.

By placing an order, you authorise us to charge the total amount to your chosen payment method.

## 6. Shipping and delivery
Delivery methods, costs, and timelines are described in our [Shipping Info](/shipping) page, which forms part of these terms.

## 7. Returns and refunds
Our returns and refund process is described in our [Returns Policy](/returns-policy), which forms part of these terms.

## 8. Intellectual property
All content on the Site — including text, product images, graphics, logos, and the UrbanPulse brand — is owned by or licensed to UrbanPulse. Purchasing a product does not transfer any intellectual property rights to you. You may not reproduce, distribute, or create derivative works from our content without prior written consent.

## 9. User-generated content
By submitting a product review or other content on the Site, you grant UrbanPulse a non-exclusive, royalty-free, perpetual licence to display, reproduce, and distribute that content in connection with our products and services. You confirm that you own the rights to any content you submit and that it does not infringe any third-party rights.

We reserve the right to remove any user-submitted content that violates these terms, is abusive, false, or otherwise inappropriate.

## 10. Prohibited uses
You agree not to:
- Use the Site for any unlawful purpose
- Commit or facilitate fraud, including chargeback fraud
- Use automated tools to scrape, crawl, or harvest data from the Site
- Attempt to reverse-engineer, decompile, or interfere with any part of the Site
- Harass, impersonate, or threaten other users or our staff
- Submit false reviews or ratings

## 11. Limitation of liability
To the maximum extent permitted by Ghanaian law, UrbanPulse is not liable for any indirect, incidental, special, or consequential damages arising from your use of the Site or our products. Our total liability for any claim arising out of these terms shall not exceed the amount you paid for the relevant order.

Nothing in these terms limits our liability for death or personal injury caused by our negligence, or for fraudulent misrepresentation, as required by Ghanaian law.

## 12. Account suspension and termination
We may suspend or terminate your account at any time, without prior notice, if we believe you have violated these terms or if required by law. On termination, your right to use the Site ceases immediately. Provisions of these terms that by their nature should survive termination will do so.

## 13. Governing law
These terms are governed by and construed in accordance with the laws of Ghana. Any dispute arising out of or in connection with these terms shall be subject to the exclusive jurisdiction of the courts of Accra, Ghana.

## 14. Changes to these terms
We may update these terms from time to time. If we make material changes, we will notify registered users by email at least 14 days before the changes take effect and update the "Last updated" date above. Continued use of the Site after changes take effect constitutes acceptance of the revised terms.
$terms$,
  $md$Terms and conditions governing use of UrbanPulse, a Ghanaian online streetwear retailer.$md$,
  true,
  (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
),
(
  'shipping',
  'Shipping Info',
  $shipping$
## 1. Where we ship
We currently ship to addresses within Ghana only. International shipping is planned — sign up to our newsletter to be notified when it launches.

## 2. Methods and costs
We offer two shipping methods at checkout:

| Method | Cost | Estimated delivery |
| --- | --- | --- |
| Standard | GH₵ 30 | 5–7 business days |
| Express | GH₵ 80 | 2–3 business days |
| Free standard shipping | Free | On orders over GH₵ 1,000 |

Delivery estimates are from the dispatch date, not the order date. Estimates are not guarantees — delays can occur during public holidays or high-demand periods.

## 3. Processing time
All orders are processed within 1–2 business days of confirmed payment. Orders placed on weekends or public holidays are processed on the next business day. You will receive a dispatch confirmation with tracking details once your order leaves our warehouse.

## 4. Order tracking
Once your order is dispatched, you will receive a tracking number by email and SMS. You can also check the status of your order at any time by logging in to your account and going to **Orders**.

## 5. Pickup option
In-store pickup at our Accra location is coming soon. We will update this page and notify newsletter subscribers when it is available.

## 6. Delivery address
We ship to the exact address provided at checkout. Please double-check your address before placing your order — we cannot redirect shipments once they are dispatched.

We recommend using a **GhanaPostGPS digital address** (format: GA-123-4567) for the most accurate delivery, especially in areas where street addresses can be ambiguous.

## 7. Failed deliveries
If you are not available to receive your order, the courier will attempt delivery a second time. After two failed attempts, the package is returned to us and we will contact you to arrange redelivery. A redelivery fee may apply.

## 8. Cash on Delivery
Cash on Delivery (COD) is available across Ghana. After placing a COD order, a member of our team will call or WhatsApp you to confirm the order and delivery details before dispatching.

Payment is made directly to the courier at the time of delivery. Please have the exact amount ready. COD orders that cannot be confirmed by phone within 24 hours may be cancelled.

## 9. International shipping (coming soon)
We plan to ship internationally in the future. When international shipping launches, import duties, taxes, and customs fees for the destination country will be the recipient's responsibility. These are not included in the shipping fee charged at checkout.
$shipping$,
  $md$Shipping methods, costs, and delivery timelines for UrbanPulse orders in Ghana.$md$,
  true,
  (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
)
ON CONFLICT (slug) DO UPDATE SET
  title            = EXCLUDED.title,
  body             = EXCLUDED.body,
  meta_description = EXCLUDED.meta_description,
  is_published     = EXCLUDED.is_published,
  updated_at       = NOW();
