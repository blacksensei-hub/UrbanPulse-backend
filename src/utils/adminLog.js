import { query } from '../db/index.js';
import { logger } from './logger.js';

export async function logAdminAction(adminId, action, details, ip) {
  try {
    await query(
      'INSERT INTO admin_logs (admin_id, action, details, ip_address) VALUES ($1,$2,$3,$4)',
      [adminId, action, details ? JSON.stringify(details) : null, ip || null]
    );
  } catch (err) {
    // Never let logging break a write path — but a failure here must still
    // be visible, since it means the admin audit trail has a silent gap.
    logger.error('admin_logs insert failed', { adminId, action, err: err.message });
  }
}
