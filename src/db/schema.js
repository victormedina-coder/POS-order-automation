import db from './client.js'

export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_items (
      sku         TEXT PRIMARY KEY,
      internal_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_locations (
      store_name       TEXT NOT NULL,
      oracle_location  TEXT NOT NULL,
      rep_id           TEXT NOT NULL,
      shopify_location TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_payment_methods (
      clave        TEXT PRIMARY KEY,
      payment_type TEXT NOT NULL
    );
  `)
}
