import db from '../db/client.js'

/**
 * Normaliza SKU/UPC: elimina sufijo .0 que Excel/Sheets añade a números.
 * Ej: "012345678901.0" → "012345678901"
 */
function normalizeSku(raw) {
  return String(raw ?? '').trim().replace(/\.0+$/, '')
}

/**
 * Ejecuta fn(db) dentro de una transacción BEGIN/COMMIT.
 * Si fn lanza, hace ROLLBACK y re-lanza.
 * node:sqlite es síncrono, por lo que fn es síncrona también.
 */
function withTransaction(fn) {
  db.exec('BEGIN')
  try {
    fn(db)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/**
 * Busca el Internal ID de NetSuite por SKU/UPC. Retorna null si no existe.
 */
export function getInternalId(sku) {
  const normalized = normalizeSku(sku)
  const row = db.prepare('SELECT internal_id FROM catalog_items WHERE sku = ?').get(normalized)
  return row?.internal_id ?? null
}

/**
 * Retorna la config de sucursal por shopify_location name (case-insensitive).
 * Retorna null si no existe.
 */
export function getLocationConfig(shopifyLocation) {
  const target = String(shopifyLocation).toLowerCase().trim()
  const row = db
    .prepare('SELECT * FROM catalog_locations WHERE LOWER(shopify_location) = ?')
    .get(target)
  return row ?? null
}

/**
 * Construye el mapa de métodos de pago desde catalog_payment_methods.
 * Ej: { '1': '01 - Efectivo', '4': '04 - Tarjeta de Crédito', '28': '28 - Débito' }
 */
export function getPaymentMethods() {
  const rows = db.prepare('SELECT clave, payment_type FROM catalog_payment_methods').all()
  const map = {}
  for (const row of rows) {
    map[String(row.clave)] = String(row.payment_type).trim()
  }
  return map
}

/**
 * Lista todos los store_name registrados (para el <select> de la UI).
 */
export function listLocations() {
  return db
    .prepare('SELECT DISTINCT store_name FROM catalog_locations WHERE store_name IS NOT NULL')
    .all()
    .map(r => String(r.store_name).trim())
    .filter(Boolean)
}

export function listAllItems() {
  return db.prepare('SELECT sku, internal_id FROM catalog_items ORDER BY sku').all()
}

export function listAllLocations() {
  return db.prepare('SELECT store_name, oracle_location, rep_id, shopify_location FROM catalog_locations ORDER BY store_name').all()
}

export function listAllPaymentMethods() {
  return db.prepare('SELECT clave, payment_type FROM catalog_payment_methods ORDER BY clave').all()
}

const TABLE_MAP = {
  items:           'catalog_items',
  locations:       'catalog_locations',
  payment_methods: 'catalog_payment_methods',
}

export function clearTable(table) {
  const sqlTable = TABLE_MAP[table]
  if (!sqlTable) throw new Error(`Unknown table: ${table}`)
  db.exec(`DELETE FROM ${sqlTable}`)
}

/**
 * Importa filas al catálogo en batch usando INSERT OR REPLACE / INSERT.
 * SKUs normalizados al insertar en catalog_items.
 * @param {'items'|'locations'|'payment_methods'} table
 * @param {object[]} rows
 */
export function bulkUpsert(table, rows) {
  if (rows.length === 0) return

  if (table === 'items') {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO catalog_items (sku, internal_id) VALUES (?, ?)'
    )
    withTransaction(() => {
      for (const item of rows) {
        insert.run(normalizeSku(item.sku), item.internal_id)
      }
    })
    return
  }

  if (table === 'locations') {
    const insert = db.prepare(`
      INSERT INTO catalog_locations (store_name, oracle_location, rep_id, shopify_location)
      VALUES (?, ?, ?, ?)
    `)
    withTransaction(() => {
      db.exec('DELETE FROM catalog_locations')
      for (const item of rows) {
        insert.run(item.store_name, item.oracle_location, item.rep_id, item.shopify_location)
      }
    })
    return
  }

  if (table === 'payment_methods') {
    const insert = db.prepare(
      'INSERT OR REPLACE INTO catalog_payment_methods (clave, payment_type) VALUES (?, ?)'
    )
    withTransaction(() => {
      for (const item of rows) {
        insert.run(String(item.clave), String(item.payment_type).trim())
      }
    })
  }
}
