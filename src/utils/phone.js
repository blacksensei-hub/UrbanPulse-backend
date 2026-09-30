// Ghana numbers to the 233XXXXXXXXX form the SMS gateway and wa.me expect:
// 024 123 4567, +233 24 123 4567 and 233241234567 all become 233241234567.
export function ghanaPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^0\d{9}$/.test(d)) return `233${d.slice(1)}`;
  if (/^233\d{9}$/.test(d)) return d;
  if (/^\d{9}$/.test(d)) return `233${d}`;
  return null;
}

// The digits for a wa.me link. A Ghana number typed the local way ("024…")
// is converted; anything else (a foreign number) is used as typed.
export function whatsappDigits(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return ghanaPhone(d) ?? d;
}
