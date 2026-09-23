-- Replace the FAQ's placeholder answers with ones that match what the store
-- actually does. The old text had the wrong support email, a GH₵1,000 free
-- delivery threshold (live is GH₵200), made-up delivery times, and an
-- "audited factories / yearly transparency report" claim with nothing
-- behind it. Touches only the FAQ row. Safe to run more than once.
--
-- The delivery prices and threshold below mirror Admin → Settings today
-- (standard GH₵30, express GH₵80, free over GH₵200). This page is static
-- text: if you change those settings, update this answer too.
UPDATE content_pages
SET title = 'FAQ',
    body = $faq$
Can't find what you're looking for? Email [support@urbanpulse.com.gh](mailto:support@urbanpulse.com.gh).

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
    updated_at = NOW()
WHERE slug = 'faq';
