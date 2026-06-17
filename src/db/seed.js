import bcrypt from 'bcryptjs';
import { pool } from './index.js';

/**
 * Seed: inserts ONLY the super-admin user.
 *
 * Wipes every other table so you start with a clean store — products, orders,
 * coupons, carts, reviews, logs, etc. all go to zero. Schemas and indexes are
 * left intact.
 */
async function seed() {
  console.log('→ Seeding…');

  await pool.query(`
    TRUNCATE
      users,
      products,
      product_variants,
      carts,
      cart_items,
      orders,
      order_items,
      reviews,
      admin_logs,
      coupons,
      order_coupons,
      inventory_alerts,
      refresh_tokens
    RESTART IDENTITY CASCADE
  `);

  const hash = await bcrypt.hash('Admin123!', 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, 'admin')`,
    ['admin@urbanpulse.com', hash, 'Site Admin']
  );

  console.log('✓ Seed complete.');
  console.log('   Admin → admin@urbanpulse.com / Admin123!');
  console.log('   (All other tables are empty — add products via the admin console.)');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
