import { requireAuth } from '../middleware/requireAuth.js'
import { bulkUpsert, listAllItems, listAllLocations, listAllPaymentMethods } from '../services/catalog.js'
import { parse } from 'csv-parse/sync'

const EXPECTED_COLUMNS = {
  items:           ['sku', 'internal_id'],
  locations:       ['store_name', 'oracle_location', 'rep_id', 'shopify_location'],
  payment_methods: ['clave', 'payment_type'],
}

// Aliases: nombre real en el CSV → nombre esperado internamente
const COLUMN_ALIASES = {
  items: {
    'upc code': 'sku',
    'upc_code': 'sku',
    'upc':      'sku',
  },
  locations: {
    'stores':           'store_name',
    'store':            'store_name',
    'oracle location':  'oracle_location',
    'rep id':           'rep_id',
    'shopify location': 'shopify_location',
  },
  payment_methods: {
    'payment type': 'payment_type',
    'clave':        'clave',
  },
}

/**
 * Normaliza el nombre de una columna:
 * - Trim + lowercase + espacios a guiones bajos
 * - Aplica aliases específicos por tabla
 */
function normalizeKey(key, table) {
  const normalized = key.trim().toLowerCase().replace(/\s+/g, '_')
  return COLUMN_ALIASES[table]?.[normalized] ?? normalized
}

/**
 * Normaliza las claves de todos los registros y filtra:
 * - Columnas con clave vacía (artefactos de Excel/Sheets)
 * - Filas donde todos los valores requeridos están vacíos
 */
function normalizeRecords(records, table) {
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

export default async function catalogImportRoutes(fastify) {
  fastify.get('/catalog/items', { preHandler: requireAuth }, async (_req, reply) => {
    return { items: listAllItems() }
  })

  fastify.get('/catalog/locations', { preHandler: requireAuth }, async (_req, reply) => {
    return { locations: listAllLocations() }
  })

  fastify.get('/catalog/payment-methods', { preHandler: requireAuth }, async (_req, reply) => {
    return { paymentMethods: listAllPaymentMethods() }
  })

  fastify.post('/catalog/import', { preHandler: requireAuth }, async (request, reply) => {
    const table = request.query.table

    if (!EXPECTED_COLUMNS[table]) {
      return reply.status(400).send({ error: 'Parámetro table debe ser "items", "locations" o "payment_methods"' })
    }

    const data = await request.file()
    if (!data) return reply.status(400).send({ error: 'No se recibió archivo' })

    const buffer = await data.toBuffer()
    const content = buffer.toString('utf-8')

    const raw = parse(content, { columns: true, skip_empty_lines: true, trim: true })
    const records = normalizeRecords(raw, table)

    if (records.length > 0) {
      const keys = Object.keys(records[0])
      const missing = EXPECTED_COLUMNS[table].filter(c => !keys.includes(c))
      if (missing.length > 0) {
        return reply.status(400).send({ error: `Columnas faltantes: ${missing.join(', ')}` })
      }
    }

    bulkUpsert(table, records)
    return { ok: true, imported: records.length, table }
  })
}
