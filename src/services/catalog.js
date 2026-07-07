import db from '../db/client.js'
import { getDefaultBrand } from '../config/brands.js'

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
 * Resuelve la marca efectiva: si brand viene null/undefined usa el default (Ariat).
 * Garantiza compatibilidad hacia atrás con código que aún no pasa marca.
 */
function resolveBrand(brand) {
  return brand ?? getDefaultBrand()
}

/**
 * Busca el Internal ID de NetSuite por SKU/UPC. Retorna null si no existe.
 */
export function getInternalId(sku, brand) {
  const b = resolveBrand(brand)
  const normalized = normalizeSku(sku)
  const row = db
    .prepare('SELECT internal_id FROM catalog_items WHERE brand = ? AND sku = ?')
    .get(b, normalized)
  return row?.internal_id ?? null
}

/**
 * Retorna la config de sucursal por shopify_location name (case-insensitive).
 * Retorna null si no existe.
 */
export function getLocationConfig(shopifyLocation, brand) {
  const b = resolveBrand(brand)
  const target = String(shopifyLocation).toLowerCase().trim()
  const row = db
    .prepare('SELECT * FROM catalog_locations WHERE brand = ? AND LOWER(shopify_location) = ?')
    .get(b, target)
  return row ?? null
}

/**
 * Construye el mapa de métodos de pago desde catalog_payment_methods.
 * Ej: { '1': '01 - Efectivo', '4': '04 - Tarjeta de Crédito', '28': '28 - Débito' }
 */
export function getPaymentMethods(brand) {
  const b = resolveBrand(brand)
  const rows = db
    .prepare('SELECT clave, payment_type FROM catalog_payment_methods WHERE brand = ?')
    .all(b)
  const map = {}
  for (const row of rows) {
    map[String(row.clave)] = String(row.payment_type).trim()
  }
  return map
}

/**
 * Lista todos los store_name registrados para la marca (para el <select> de la UI).
 */
export function listLocations(brand) {
  const b = resolveBrand(brand)
  return db
    .prepare(
      'SELECT DISTINCT store_name FROM catalog_locations WHERE brand = ? AND store_name IS NOT NULL'
    )
    .all(b)
    .map(r => String(r.store_name).trim())
    .filter(Boolean)
}

export function listAllItems(brand) {
  const b = resolveBrand(brand)
  return db
    .prepare('SELECT brand, sku, internal_id FROM catalog_items WHERE brand = ? ORDER BY sku')
    .all(b)
}

export function listAllLocations(brand) {
  const b = resolveBrand(brand)
  return db
    .prepare(
      'SELECT brand, store_name, oracle_location, rep_id, shopify_location FROM catalog_locations WHERE brand = ? ORDER BY store_name'
    )
    .all(b)
}

export function listAllPaymentMethods(brand) {
  const b = resolveBrand(brand)
  return db
    .prepare(
      'SELECT brand, clave, payment_type FROM catalog_payment_methods WHERE brand = ? ORDER BY clave'
    )
    .all(b)
}

const TABLE_MAP = {
  items:           'catalog_items',
  locations:       'catalog_locations',
  payment_methods: 'catalog_payment_methods',
}

/**
 * Borra todas las filas de la tabla para la marca indicada.
 * NO borra filas de otras marcas.
 */
export function clearTable(table, brand) {
  const b = resolveBrand(brand)
  const sqlTable = TABLE_MAP[table]
  if (!sqlTable) throw new Error(`Unknown table: ${table}`)
  db.exec(`DELETE FROM ${sqlTable} WHERE brand = '${b.replace(/'/g, "''")}'`)
}

/**
 * Importa filas al catálogo en batch usando INSERT OR REPLACE / INSERT.
 * SKUs normalizados al insertar en catalog_items.
 * Todas las filas se asocian a la marca `brand` (default Ariat si no se pasa).
 *
 * IMPORTANTE — conteo honesto: catalog_items y catalog_payment_methods tienen
 * PRIMARY KEY compuesta (brand, sku) / (brand, clave). INSERT OR REPLACE colapsa
 * filas con la misma clave normalizada en una sola fila (last-wins). Por eso esta
 * función NO reporta rows.length como "importado": cuenta filas con clave vacía
 * (se omiten, son inmapeables) y filas duplicadas que colapsan, y retorna el
 * conteo REAL de filas distintas escritas en la tabla.
 *
 * @param {'items'|'locations'|'payment_methods'} table
 * @param {object[]} rows
 * @param {string|null|undefined} brand
 * @returns {{received: number, skippedEmptySku: number, duplicatesCollapsed: number, suspiciousSku: number, inserted: number}}
 */
// Detecta SKUs corrompidos a notación científica pura por exportar la columna
// como número en Excel/Sheets (p.ej. "7.5065E+12"). Al igual que un SKU vacío,
// son inmapeables (se perdió la precisión original del número) → se OMITEN,
// pero se cuentan aparte en suspiciousSku para que el usuario sepa que debe
// corregir el export (columna SKU como TEXTO) en vez de asumir que son válidos.
const SCI_NOTATION = /^\d+(\.\d+)?[eE]\+?\d+$/

export function bulkUpsert(table, rows, brand) {
  const received = rows.length
  if (received === 0) {
    return { received: 0, skippedEmptySku: 0, duplicatesCollapsed: 0, suspiciousSku: 0, inserted: 0 }
  }
  const b = resolveBrand(brand)

  if (table === 'items') {
    let skippedEmptySku = 0
    let suspiciousSku = 0
    const byKey = new Map() // normalizedSku -> item (last-wins)
    for (const item of rows) {
      const sku = normalizeSku(item.sku)
      if (sku === '') {
        skippedEmptySku++
        continue
      }
      if (SCI_NOTATION.test(sku)) {
        suspiciousSku++
        continue
      }
      byKey.set(sku, item)
    }
    const duplicatesCollapsed = (received - skippedEmptySku - suspiciousSku) - byKey.size

    const insert = db.prepare(
      'INSERT OR REPLACE INTO catalog_items (brand, sku, internal_id) VALUES (?, ?, ?)'
    )
    withTransaction(() => {
      for (const [sku, item] of byKey) {
        insert.run(b, sku, item.internal_id)
      }
    })
    return { received, skippedEmptySku, duplicatesCollapsed, suspiciousSku, inserted: byKey.size }
  }

  if (table === 'locations') {
    const insert = db.prepare(`
      INSERT INTO catalog_locations (brand, store_name, oracle_location, rep_id, shopify_location)
      VALUES (?, ?, ?, ?, ?)
    `)
    withTransaction(() => {
      // Solo borra las locaciones de esta marca antes de reinsertar (no toca otras marcas)
      db.prepare('DELETE FROM catalog_locations WHERE brand = ?').run(b)
      for (const item of rows) {
        insert.run(b, item.store_name, item.oracle_location, item.rep_id, item.shopify_location)
      }
    })
    return { received, skippedEmptySku: 0, duplicatesCollapsed: 0, suspiciousSku: 0, inserted: rows.length }
  }

  if (table === 'payment_methods') {
    let skippedEmptySku = 0
    const byKey = new Map() // clave -> item (last-wins)
    for (const item of rows) {
      const clave = String(item.clave ?? '').trim()
      if (clave === '') {
        skippedEmptySku++
        continue
      }
      byKey.set(clave, item)
    }
    const duplicatesCollapsed = (received - skippedEmptySku) - byKey.size

    const insert = db.prepare(
      'INSERT OR REPLACE INTO catalog_payment_methods (brand, clave, payment_type) VALUES (?, ?, ?)'
    )
    withTransaction(() => {
      for (const [clave, item] of byKey) {
        insert.run(b, clave, String(item.payment_type).trim())
      }
    })
    return { received, skippedEmptySku, duplicatesCollapsed, suspiciousSku: 0, inserted: byKey.size }
  }
}
