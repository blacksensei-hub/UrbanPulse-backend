-- Replace the About page's placeholder story (invented co-founders, a 2022
-- launch, "ships within 48 hours") with copy that is true today.
-- Touches only the About row. Safe to run more than once.
UPDATE content_pages
SET title = 'About',
    body = $about$
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
    meta_description = $md$UrbanPulse is a streetwear label from Accra. Shop the Ghana Jersey and Baggy Jeans, and pay with Mobile Money or card.$md$,
    updated_at = NOW()
WHERE slug = 'about';
