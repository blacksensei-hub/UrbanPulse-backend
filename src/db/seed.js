import bcrypt from 'bcryptjs';
import { pool } from './index.js';

/**
 * Seed: empties the store and creates one admin.
 *
 * Wipes every table below so you start with a clean store — products, orders,
 * coupons, carts, reviews, logs, etc. all go to zero. Schemas and indexes are
 * left intact. Because it wipes, it only runs with SEED_WIPE=yes.
 *
 * The admin's email and password come from SEED_ADMIN_EMAIL and
 * SEED_ADMIN_PASSWORD. Nothing is written in the code: this repo is public.
 */
async function seed() {
  if (process.env.SEED_WIPE !== 'yes') {
    console.error('Refusing to seed: it empties every table. Set SEED_WIPE=yes to confirm.');
    process.exit(1);
  }
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? '';
  if (!email || password.length < 12) {
    console.error('Set SEED_ADMIN_EMAIL, and SEED_ADMIN_PASSWORD of at least 12 characters, for the admin account.');
    process.exit(1);
  }

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

  const hash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, 'admin')`,
    [email, hash, 'Site Admin']
  );

  console.log('✓ Seed complete.');
  console.log(`   Admin → ${email} (password from SEED_ADMIN_PASSWORD)`);
  console.log('   (All other tables are empty — add products via the admin console.)');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
