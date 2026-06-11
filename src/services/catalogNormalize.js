/**
 * Lógica de normalización de columnas compartida entre la ruta HTTP de importación
 * (`src/routes/catalogImport.js`) y el script CLI (`scripts/importCatalog.js`).
 *
 * Exporta: EXPECTED_COLUMNS, COLUMN_ALIASES, normalizeKey, normalizeRecords
 */

export const EXPECTED_COLUMNS = {
  items:           ['sku', 'internal_id'],
  locations:       ['store_name', 'oracle_location', 'rep_id', 'shopify_location'],
  payment_methods: ['clave', 'payment_type'],
}

// Aliases: nombre normalizado del CSV (tras trim+lower+espacios→_) → nombre esperado.
// IMPORTANTE: las claves deben estar ya en forma normalizada (con _) porque
// normalizeKey aplica la conversión ANTES de buscar en este mapa.
export const COLUMN_ALIASES = {
  items: {
    'upc_code': 'sku',  // "UPC Code" → normaliza a "upc_code"
    'upc':      'sku',
  },
  locations: {
    'stores':           'store_name',
    'store':            'store_name',
    'oracle_location':  'oracle_location',  // "Oracle Location" → "oracle_location"
    'rep_id':           'rep_id',           // "Rep ID" → "rep_id"
    'shopify_location': 'shopify_location', // "Shopify Location" → "shopify_location"
  },
  payment_methods: {
    'payment_type': 'payment_type',  // "Payment Type" → "payment_type"
    'clave':        'clave',
  },
}

/**
 * Normaliza el nombre de una columna:
 * - Trim + lowercase + espacios a guiones bajos
 * - Aplica aliases específicos por tabla
 */
export function normalizeKey(key, table) {
  const normalized = key.trim().toLowerCase().replace(/\s+/g, '_')
  return COLUMN_ALIASES[table]?.[normalized] ?? normalized
}

/**
 * Normaliza las claves de todos los registros y filtra:
 * - Columnas con clave vacía (artefactos de Excel/Sheets)
 * - Filas donde todos los valores requeridos están vacíos
 */
export function normalizeRecords(records, table) {
  const required = EXPECTED_COLUMNS[table]

  return records
    .map(row => {
      const normalized = {}
      for (const [k, v] of Object.entries(row)) {
        const key = normalizeKey(k, table)
        if (key) normalized[key] = v
      }
      return normalized
    })
    .filter(row => required.some(col => row[col] && String(row[col]).trim() !== ''))
}
