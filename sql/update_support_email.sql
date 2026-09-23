-- Point every customer-facing support address at the inbox that is
-- actually read. The old support@urbanpulse.com.gh (and the FAQ's
-- support@urbanpulse.com) were placeholders. Safe to run more than once.
-- site_settings.value is jsonb, so the address goes in as a JSON string.
UPDATE site_settings SET value = to_jsonb('noreply.urbanpulse0@gmail.com'::text)
WHERE key = 'support_email';

UPDATE content_pages
SET body = replace(replace(body, 'support@urbanpulse.com.gh', 'noreply.urbanpulse0@gmail.com'),
                   'support@urbanpulse.com', 'noreply.urbanpulse0@gmail.com'),
    updated_at = NOW()
WHERE body LIKE '%support@urbanpulse.com%';

-- The Returns and Terms pages also named urbanpulse.com.gh as the site's
-- address. That domain was never set up, so word them to stay true
-- whatever domain the store ends up on.
UPDATE content_pages
SET body = replace(replace(body,
             'Log in to your account at urbanpulse.com.gh', 'Log in to your account on this website'),
             'using urbanpulse.com.gh (the "Site")', 'using this website (the "Site")'),
    updated_at = NOW()
WHERE body LIKE '%urbanpulse.com.gh%';
