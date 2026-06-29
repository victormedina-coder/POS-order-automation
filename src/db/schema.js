import db from './client.js'

export function runMigrations() {
  // ── CREATE TABLE IF NOT EXISTS ───────────────────────────────────────────────
  // Para instalaciones NUEVAS: las tablas se crean ya con la columna `brand`
  // y las PKs compuestas correctas.
  // Para la DB existente estas sentencias son no-ops (las tablas ya existen).
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_items (
      brand       TEXT NOT NULL DEFAULT 'ariat',
      sku         TEXT NOT NULL,
      internal_id TEXT NOT NULL,
      PRIMARY KEY (brand, sku)
    );

    CREATE TABLE IF NOT EXISTS catalog_locations (
      brand            TEXT NOT NULL DEFAULT 'ariat',
      store_name       TEXT NOT NULL,
      oracle_location  TEXT NOT NULL,
      rep_id           TEXT NOT NULL,
      shopify_location TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_payment_methods (
      brand        TEXT NOT NULL DEFAULT 'ariat',
      clave        TEXT NOT NULL,
      payment_type TEXT NOT NULL,
      PRIMARY KEY (brand, clave)
    );
  `)

  // ── MIGRACIÓN MULTI-BRAND — ETAPA 4 ─────────────────────────────────────────
  // Detecta con PRAGMA si la columna `brand` ya existe en cada tabla.
  // Si NO existe, aplica la migración UNA vez y no vuelve a tocarla (idempotente).
  //
  // catalog_items y catalog_payment_methods tienen PK simple → SQLite no permite
  // cambiar PKs con ALTER TABLE, así que se hace vía tabla temporal:
  //   1. Crear ..._new con la PK compuesta (brand, sku / brand, clave).
  //   2. Copiar datos asignando brand='ariat'.
  //   3. DROP tabla vieja.
  //   4. RENAME ..._new → nombre original.
  //
  // catalog_locations no tiene PK → basta un ALTER TABLE ADD COLUMN.
  // El DEFAULT 'ariat' rellena automáticamente las filas existentes.

  const hasBrandColumn = (tableName) => {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all()
    return cols.some(c => c.name === 'brand')
  }

  // — catalog_items ─────────────────────────────────────────────────────────────
  if (!hasBrandColumn('catalog_items')) {
    db.exec('BEGIN')
    try {
      db.exec(`
        CREATE TABLE catalog_items_new (
          brand       TEXT NOT NULL DEFAULT 'ariat',
          sku         TEXT NOT NULL,
          internal_id TEXT NOT NULL,
          PRIMARY KEY (brand, sku)
        )
      `)
      db.exec(`
        INSERT OR IGNORE INTO catalog_items_new (brand, sku, internal_id)
        SELECT 'ariat', sku, internal_id FROM catalog_items
      `)
      db.exec('DROP TABLE catalog_items')
      db.exec('ALTER TABLE catalog_items_new RENAME TO catalog_items')
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`[schema] Migración multi-brand catalog_items falló: ${e.message}`)
    }
  }

  // — catalog_payment_methods ───────────────────────────────────────────────────
  if (!hasBrandColumn('catalog_payment_methods')) {
    db.exec('BEGIN')
    try {
      db.exec(`
        CREATE TABLE catalog_payment_methods_new (
          brand        TEXT NOT NULL DEFAULT 'ariat',
          clave        TEXT NOT NULL,
          payment_type TEXT NOT NULL,
          PRIMARY KEY (brand, clave)
        )
      `)
      db.exec(`
        INSERT OR IGNORE INTO catalog_payment_methods_new (brand, clave, payment_type)
        SELECT 'ariat', clave, payment_type FROM catalog_payment_methods
      `)
      db.exec('DROP TABLE catalog_payment_methods')
      db.exec('ALTER TABLE catalog_payment_methods_new RENAME TO catalog_payment_methods')
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`[schema] Migración multi-brand catalog_payment_methods falló: ${e.message}`)
    }
  }

  // — catalog_locations ─────────────────────────────────────────────────────────
  // Sin PK → ALTER TABLE ADD COLUMN es suficiente.
  // SQLite rellena las filas existentes con el DEFAULT 'ariat' automáticamente.
  if (!hasBrandColumn('catalog_locations')) {
    db.exec(`ALTER TABLE catalog_locations ADD COLUMN brand TEXT NOT NULL DEFAULT 'ariat'`)
  }
}
