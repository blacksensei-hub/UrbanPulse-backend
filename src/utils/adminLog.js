import { query } from '../db/index.js';

export async function logAdminAction(adminId, action, details, ip) {
  try {
    await query(
      'INSERT INTO admin_logs (admin_id, action, details, ip_address) VALUES ($1,$2,$3,$4)',
      [adminId, action, details ? JSON.stringify(details) : null, ip || null]
    );
  } catch {
    // never let logging break a write path
  }
}
