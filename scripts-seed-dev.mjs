import 'dotenv/config';
import pg from 'pg';

/**
 * Local dev seed. Three products, chosen to exercise the two things
 * that need verifying:
 *   - 'bottoms' stored lower case, which is what hid products from
 *     their own category before the LOWER() fix.
 *   - 'Tops' stored title case, so both directions are covered.
 *   - one is_featured row, which is the editorial PDP branch.
 * Every slug is prefixed dev- so removing them is one DELETE.
 */
const IMG = (id) => [`https://images.unsplash.com/photo-${id}?w=1200&q=70`];

const PRODUCTS = [
  { slug:'dev-baggy-jeans', name:'Baggy Jeans', category:'bottoms', price:420,
    featured:false, desc:'Heavyweight denim, cut wide through the leg. Stored lower case on purpose.',
    img:IMG('1541099649105-f69ad21f3246'), sizes:['28','30','32','34'], colors:['Indigo','Washed Black'] },
  { slug:'dev-pulse-hoodie', name:'Pulse Hoodie', category:'Tops', price:380, compare:460,
    featured:true, desc:'A 480gsm loopback hoodie, boxed shoulder, no drop. The featured object study.',
    img:IMG('1556821840-3a63f95609a7'), sizes:['S','M','L','XL'], colors:['Bone','Ink'] },
  { slug:'dev-field-jacket', name:'Field Jacket', category:'Outerwear', price:690,
    featured:false, desc:'Waxed cotton shell with a storm placket. Built for the harmattan.',
    img:IMG('1591047139829-d91aecb6caea'), sizes:['S','M','L'], colors:['Olive'] },
];

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query('BEGIN');
  for (const p of PRODUCTS) {
    const { rows:[row] } = await c.query(
      `INSERT INTO products (slug, name, description, price, compare_at_price, images, category, tags, rating, is_active, is_featured)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)
       ON CONFLICT (slug) DO UPDATE SET
         name=EXCLUDED.name, description=EXCLUDED.description, price=EXCLUDED.price,
         compare_at_price=EXCLUDED.compare_at_price, images=EXCLUDED.images,
         category=EXCLUDED.category, is_featured=EXCLUDED.is_featured, is_active=TRUE
       RETURNING id`,
      [p.slug, p.name, p.desc, p.price, p.compare ?? null, p.img, p.category, ['dev-seed'], 4.6, p.featured]
    );
    await c.query('DELETE FROM product_variants WHERE product_id = $1', [row.id]);
    for (const size of p.sizes) for (const color of p.colors) {
      await c.query(
        `INSERT INTO product_variants (product_id, size, color, sku, stock, price_adjustment)
         VALUES ($1,$2,$3,$4,$5,0)`,
        [row.id, size, color, `${p.slug}-${size}-${color}`.toLowerCase().replace(/\s+/g,'-'), 12]
      );
    }
    console.log(`seeded ${p.name}  id=${row.id}  category='${p.category}'  featured=${p.featured}`);
  }
  await c.query('COMMIT');
} catch (e) { await c.query('ROLLBACK'); throw e; }
finally { await c.end(); }
