-- One spelling per product category: trimmed, single-spaced, Title Case.
-- Matches normalizeCategory() in src/utils/category.js, which every admin
-- write now goes through. Safe to run more than once.
UPDATE products
SET category = NULLIF(initcap(regexp_replace(btrim(category), '\s+', ' ', 'g')), ''),
    updated_at = NOW()
WHERE category IS DISTINCT FROM NULLIF(initcap(regexp_replace(btrim(category), '\s+', ' ', 'g')), '');
