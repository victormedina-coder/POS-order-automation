import { requireAuth } from '../middleware/requireAuth.js'
import { bulkUpsert } from '../services/catalog.js'
import { parse } from 'csv-parse/sync'

const EXPECTED_COLUMNS = {
  items:           ['sku', 'internal_id'],
  locations:       ['store_name', 'oracle_location', 'rep_id', 'shopify_location'],
  payment_methods: ['clave', 'payment_type'],
}

export default async function catalogImportRoutes(fastify) {
  fastify.post('/catalog/import', { preHandler: requireAuth }, async (request, reply) => {
    const table = request.query.table

    if (!EXPECTED_COLUMNS[table]) {
      return reply.status(400).send({ error: 'Parámetro table debe ser "items", "locations" o "payment_methods"' })
    }

    const data = await request.file()
    if (!data) return reply.status(400).send({ error: 'No se recibió archivo' })

    const buffer = await data.toBuffer()
    const content = buffer.toString('utf-8')

    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true })

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
