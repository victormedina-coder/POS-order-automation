import { requireAuth, requireXhr } from '../middleware/requireAuth.js'
import { bulkUpsert, clearTable, listAllItems, listAllLocations, listAllPaymentMethods } from '../services/catalog.js'
import { parse } from 'csv-parse/sync'
import {
  EXPECTED_COLUMNS,
  COLUMN_ALIASES,  // re-exportado por si algún consumidor lo necesita
  normalizeKey,
  normalizeRecords,
} from '../services/catalogNormalize.js'

export default async function catalogImportRoutes(fastify) {
  fastify.get('/catalog/items', { preHandler: requireAuth }, async (request, reply) => {
    const brand = request.query.brand ?? undefined
    return { items: listAllItems(brand) }
  })

  fastify.get('/catalog/locations', { preHandler: requireAuth }, async (request, reply) => {
    const brand = request.query.brand ?? undefined
    return { locations: listAllLocations(brand) }
  })

  fastify.get('/catalog/payment-methods', { preHandler: requireAuth }, async (request, reply) => {
    const brand = request.query.brand ?? undefined
    return { paymentMethods: listAllPaymentMethods(brand) }
  })

  fastify.delete('/catalog/clear', { preHandler: [requireAuth, requireXhr] }, async (request, reply) => {  // H-6: CSRF defense
    const table = request.query.table
    const brand = request.query.brand ?? undefined
    if (!EXPECTED_COLUMNS[table]) {
      return reply.status(400).send({ error: 'Parámetro table debe ser "items", "locations" o "payment_methods"' })
    }
    clearTable(table, brand)
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

    const brand = request.query.brand ?? undefined
    const records = normalizeRecords(raw, table)
    bulkUpsert(table, records, brand)
    return { ok: true, imported: records.length, table }
  })
}
