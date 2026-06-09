import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import path from 'path'
import { fetchOrders } from '../services/shopify.js'
import { transformOrders } from '../services/posTransform.js'
import { generateCSV } from '../services/csvGenerator.js'
import { listLocations } from '../services/catalog.js'
import { requireAuth } from '../middleware/requireAuth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_PATH = path.join(__dirname, '../ui/posExport.html')
const JS_PATH = path.join(__dirname, '../ui/posExport.js')

const BODY_SCHEMA = {
  type: 'object',
  required: ['dateFrom', 'dateTo', 'storeName'],
  properties: {
    dateFrom:  { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    dateTo:    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    storeName: { type: 'string', minLength: 1 },
  },
}

export default async function posExportRoutes(fastify) {
  // GET /pos-export/app.js — sirve el JS de la UI
  fastify.get('/pos-export/app.js', async (_req, reply) => {
    const js = await readFile(JS_PATH, 'utf-8')
    return reply.type('application/javascript').send(js)
  })

  fastify.get('/pos-export', { preHandler: requireAuth }, async (request, reply) => {
    const html = await readFile(UI_PATH, 'utf-8')
    return reply.type('text/html').send(html)
  })

  fastify.get('/pos-export/locations', { preHandler: requireAuth }, async (_req, reply) => {
    return { locations: listLocations() }
  })

  fastify.post('/pos-export/preview', {
    preHandler: requireAuth,
    schema: { body: BODY_SCHEMA },
  }, async (request, reply) => {
    const { dateFrom, dateTo, storeName } = request.body

    const orders = await fetchOrders(dateFrom, dateTo)
    const { rows, stats } = transformOrders(orders, storeName)

    if (rows.length === 0) {
      return reply.status(200).send({ ok: false, error: 'No se encontraron pedidos en este periodo' })
    }

    return { ok: true, rows, stats }
  })

  fastify.post('/pos-export/download', {
    preHandler: requireAuth,
    schema: {
      body: {
        type: 'object',
        required: ['dateFrom', 'dateTo', 'storeName'],
        properties: {
          dateFrom:  { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          dateTo:    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          storeName: { type: 'string', minLength: 1 },
          uuids:     { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { dateFrom, dateTo, storeName, uuids = {} } = request.body

    const orders = await fetchOrders(dateFrom, dateTo)
    const { rows } = transformOrders(orders, storeName)

    if (rows.length === 0) {
      return reply.status(200).send({ ok: false, error: 'No se encontraron pedidos en este periodo' })
    }

    for (const row of rows) {
      const fecha = row['Order Date']
      const iso = `${fecha.slice(6, 10)}-${fecha.slice(3, 5)}-${fecha.slice(0, 2)}`
      row['UUID'] = uuids[iso] ?? ''
    }

    const csv = generateCSV(rows)
    const filename = `netsuite_${storeName.replace(/\s+/g, '_')}_${dateFrom}_${dateTo}.csv`

    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv)
  })
}
