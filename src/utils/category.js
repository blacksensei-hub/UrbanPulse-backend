// One spelling per category. Filters already compare case-insensitively, but
// stored values drifted ("bottoms" next to "Outerwear"), which split admin
// grouping, CSV exports and anything that displays the raw value. Every write
// goes through this: trimmed, inner whitespace collapsed, Title Case.
// Returns null for empty input so "no category" stays a real NULL.
export function normalizeCategory(value) {
  if (value == null) return null;
  const s = String(value).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.toLowerCase().replace(/(^|[\s\-/&])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}
