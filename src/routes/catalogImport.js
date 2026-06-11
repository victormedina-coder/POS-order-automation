import { requireAuth, requireXhr } from '../middleware/requireAuth.js'
import { bulkUpsert, clearTable, listAllItems, listAllLocations, listAllPaymentMethods } from '../services/catalog.js'
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

  fastify.delete('/catalog/clear', { preHandler: [requireAuth, requireXhr] }, async (request, reply) => {  // H-6: CSRF defense
    const table = request.query.table
    if (!EXPECTED_COLUMNS[table]) {
      return reply.status(400).send({ error: 'Parámetro table debe ser "items", "locations" o "payment_methods"' })
    }
    clearTable(table)
    return { ok: true, table }
  })

  // mimetypes aceptados para importación CSV. Se acepta también por extensión .csv
  // porque algunos navegadores/SO (p.ej. Windows + Chrome) reportan un CSV legítimo
  // como application/octet-stream o cadena vacía. La validación real es el parseo.
  const ALLOWED_MIME = new Set([
    'text/csv', 'application/vnd.ms-excel', 'text/plain',
    'application/csv', 'application/octet-stream', '',
  ])
  const isAllowedCsv = (data) =>
    ALLOWED_MIME.has(data.mimetype) || /\.csv$/i.test(data.filename ?? '')

  // Límite más estricto en import (10/min) para evitar abuso de carga de archivos
  fastify.post('/catalog/import', {
    preHandler: [requireAuth, requireXhr],  // H-6: CSRF defense
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const table = request.query.table

    if (!EXPECTED_COLUMNS[table]) {
      return reply.status(400).send({ error: 'Parámetro table debe ser "items", "locations" o "payment_methods"' })
    }

    let data
    try {
      data = await request.file()
    } catch (err) {
      // @fastify/multipart lanza un error con código FST_REQ_FILE_TOO_LARGE cuando
      // se supera el límite configurado en app.js.
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(413).send({ error: 'El archivo supera el tamaño máximo permitido (5 MB)' })
      }
      return reply.status(400).send({ error: 'Error procesando el archivo' })
    }

    if (!data) return reply.status(400).send({ error: 'No se recibió archivo' })

    // validar que sea CSV (por mimetype o por extensión) antes de leer el contenido.
    if (!isAllowedCsv(data)) {
      return reply.status(400).send({ error: 'Tipo de archivo no permitido. Se esperaba un archivo .csv' })
    }

    const buffer = await data.toBuffer()
    const content = buffer.toString('utf-8')

    const raw = parse(content, { columns: true, skip_empty_lines: true, trim: true })

    if (raw.length === 0) {
      return reply.status(400).send({ error: 'El archivo CSV no contiene filas de datos' })
    }

    // Validar los encabezados del CSV (ya normalizados) contra las columnas esperadas
    // de la tabla seleccionada. Detecta el caso de elegir la tabla equivocada en el
    // selector (p.ej. importar un CSV de pagos con la tabla "items"), que antes filtraba
    // todas las filas y devolvía "0 importados" silenciosamente.
    const headerKeys = Object.keys(raw[0]).map(k => normalizeKey(k, table))
    const missing = EXPECTED_COLUMNS[table].filter(c => !headerKeys.includes(c))
    if (missing.length > 0) {
      return reply.status(400).send({
        error: `El CSV no coincide con la tabla "${table}". Faltan columnas: ${missing.join(', ')}. `
          + `Encabezados encontrados: ${Object.keys(raw[0]).join(', ')}`,
      })
    }

    const records = normalizeRecords(raw, table)
    bulkUpsert(table, records)
    return { ok: true, imported: records.length, table }
  })
}
