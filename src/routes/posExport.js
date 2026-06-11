import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import path from 'path'
import { fetchOrders } from '../services/shopify.js'
import { transformOrders } from '../services/posTransform.js'
import { generateCSV } from '../services/csvGenerator.js'
import { listLocations } from '../services/catalog.js'
import { requireAuth, requireXhr } from '../middleware/requireAuth.js'
import { getUUIDsForRange } from '../services/facturama.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_PATH = path.join(__dirname, '../ui/posExport.html')
const JS_PATH = path.join(__dirname, '../ui/posExport.js')

// Propiedades de rango de fechas y tienda compartidas por /preview y /download
const DATE_RANGE_SCHEMA = {
  dateFrom:  { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  dateTo:    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  storeName: { type: 'string', minLength: 1 },
}

/**
 * Obtiene pedidos de Shopify y los transforma para la tienda indicada.
 * - Si la tienda no existe lanza (el caller responde 400).
 * - Loguea advertencias por errores por orden usando fastify.log.warn.
 * Retorna { rows, stats }.
 */
async function fetchAndTransform(fastify, dateFrom, dateTo, storeName) {
  const orders = await fetchOrders(dateFrom, dateTo)
  const { rows, stats, errors } = transformOrders(orders, storeName)
  if (errors.length > 0) {
    fastify.log.warn({ errors, storeName }, 'Errores por orden en transformOrders')
  }
  return { rows, stats }
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
    preHandler: [requireAuth, requireXhr],
    schema: {
      body: {
        type: 'object',
        required: ['dateFrom', 'dateTo', 'storeName'],
        properties: DATE_RANGE_SCHEMA,
      },
    },
  }, async (request, reply) => {
    const { dateFrom, dateTo, storeName } = request.body

    let rows, stats
    try {
      ;({ rows, stats } = await fetchAndTransform(fastify, dateFrom, dateTo, storeName))
    } catch (err) {
      fastify.log.warn({ err, storeName }, 'Tienda no encontrada en transformOrders')
      return reply.status(400).send({ ok: false, error: 'Tienda no encontrada en el catálogo' })
    }

    if (rows.length === 0) {
      return reply.status(200).send({ ok: false, error: 'No se encontraron pedidos en este periodo' })
    }

    return { ok: true, rows, stats }
  })

  fastify.post('/pos-export/download', {
    preHandler: [requireAuth, requireXhr],
    schema: {
      body: {
        type: 'object',
        required: ['dateFrom', 'dateTo', 'storeName'],
        properties: {
          ...DATE_RANGE_SCHEMA,
          uuids: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const { dateFrom, dateTo, storeName, uuids = {} } = request.body

    let rows
    try {
      ;({ rows } = await fetchAndTransform(fastify, dateFrom, dateTo, storeName))
    } catch (err) {
      fastify.log.warn({ err, storeName }, 'Tienda no encontrada en transformOrders')
      return reply.status(400).send({ ok: false, error: 'Tienda no encontrada en el catálogo' })
    }

    if (rows.length === 0) {
      return reply.status(200).send({ ok: false, error: 'No se encontraron pedidos en este periodo' })
    }

    for (const row of rows) {
      const fecha = row['Order Date']
      const iso = `${fecha.slice(6, 10)}-${fecha.slice(3, 5)}-${fecha.slice(0, 2)}`
      row['UUID'] = uuids[iso] ?? ''
    }

    const csv = generateCSV(rows)
    // sanitizar storeName para el header Content-Disposition.
    // Solo se permiten caracteres alfanuméricos, guion y guion bajo;
    const safeStore = storeName.replace(/[^a-zA-Z0-9_-]/g, '_')
    const filename = `netsuite_${safeStore}_${dateFrom}_${dateTo}.csv`

    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv)
  })

  fastify.get('/pos-export/uuids', {
    preHandler: requireAuth,
    schema: {
      querystring: {
        type: 'object',
        required: ['dateFrom', 'dateTo'],
        properties: {
          dateFrom: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          dateTo:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
      },
    },
  }, async (request, reply) => {
    const { dateFrom, dateTo } = request.query

    // getUUIDsForRange retorna {} directamente si Facturama no está configurado,
    // por lo que no se necesita guard previo con isFacturamaConfigured().
    try {
      const uuids = await getUUIDsForRange(dateFrom, dateTo)
      if (Object.keys(uuids).length === 0 && !process.env.FACTURAMA_USER) {
        return { ok: true, uuids: {}, warning: 'Facturama no configurado — UUID manual requerido' }
      }
      return { ok: true, uuids }
    } catch (err) {
      // Loguear el error completo en servidor, pero devolver al cliente un mensaje genérico
      fastify.log.warn({ err }, 'Error consultando UUIDs de Facturama')
      return { ok: true, uuids: {}, warning: 'No se pudieron obtener los UUIDs de Facturama' }
    }
  })
}
