import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import path from 'path'
import { createShopifyClient } from '../services/shopify.js'
import { getBrandConfig, listEnabledBrands, getFacturamaSerie } from '../config/brands.js'
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
  // brand es OPCIONAL — la UI aún no lo manda (Etapa 5); sin él cae al default (Ariat).
  brand:     { type: 'string' },
}

/**
 * Obtiene pedidos de Shopify y los transforma para la tienda indicada.
 * - Si la tienda no existe lanza (el caller responde 400).
 * - Loguea advertencias por errores por orden usando fastify.log.warn.
 * Retorna { rows, stats }.
 *
 * @param {object}          fastify
 * @param {string}          dateFrom
 * @param {string}          dateTo
 * @param {string}          storeName
 * @param {string|null}     brand     Clave de marca (null → usa default por contrato de getBrandConfig)
 */
async function fetchAndTransform(fastify, dateFrom, dateTo, storeName, brand) {
  const brandConfig = getBrandConfig(brand)   // lanza con prefijo [brands] si la marca es inválida
  const shopify = createShopifyClient(brandConfig)
  const orders = await shopify.fetchOrders(dateFrom, dateTo)
  const { rows, stats, errors, diagnostics } = transformOrders(orders, storeName, brandConfig.key)
  fastify.log.info({ diagnostics, storeName, brand: brandConfig.key }, 'Embudo de filtrado de transformOrders')
  if (errors.length > 0) {
    fastify.log.warn({ errors, storeName, brand: brandConfig.key }, 'Errores por orden en transformOrders')
  }
  return { rows, stats }
}

/**
 * Clasifica un error de fetchAndTransform en una respuesta clara para la UI.
 * Antes, TODO lo que no fuera "[brands]" se reportaba como "tienda no encontrada",
 * lo que enmascaraba errores de permisos de Shopify (ACCESS_DENIED) como si fuera
 * un problema de catálogo. Ahora se distinguen cuatro causas:
 *   - configuración de marca inválida ([brands])
 *   - permisos de Shopify (ACCESS_DENIED / scopes faltantes, p. ej. read_returns)
 *   - tienda ausente del catálogo (lo único que realmente lanza transformOrders)
 *   - cualquier otro error inesperado
 * @returns {{ status: number, error: string, logMsg: string }}
 */
function classifyFetchError(err) {
  const msg = err?.message ?? ''

  if (msg.startsWith('[brands]')) {
    return { status: 400, error: msg, logMsg: 'Error de configuración de marca' }
  }
  if (msg.includes('ACCESS_DENIED') || msg.startsWith('Shopify GraphQL:') || msg.startsWith('Shopify HTTP')) {
    const scopeHint = msg.includes('returns') ? ' (falta el scope read_returns)' : ''
    return {
      status: 502,
      error: `La app de Shopify de esta marca no tiene los permisos necesarios${scopeHint}. Revisa los scopes de la Custom App y reinstálala.`,
      logMsg: 'Error de permisos de Shopify (ACCESS_DENIED)',
    }
  }
  if (msg.includes('no encontrada en catalog_locations')) {
    return { status: 400, error: 'Tienda no encontrada en el catálogo', logMsg: 'Tienda no encontrada en transformOrders' }
  }
  return { status: 500, error: 'Error inesperado al procesar los pedidos. Revisa los logs del servidor.', logMsg: 'Error inesperado en fetchAndTransform' }
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

  fastify.get('/pos-export/brands', { preHandler: requireAuth }, async (_req, reply) => {
    return { brands: listEnabledBrands() }
  })

  fastify.get('/pos-export/locations', { preHandler: requireAuth }, async (request, reply) => {
    const brand = request.query.brand ?? undefined
    return { locations: listLocations(brand) }
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
    const { dateFrom, dateTo, storeName, brand } = request.body

    let rows, stats
    try {
      ;({ rows, stats } = await fetchAndTransform(fastify, dateFrom, dateTo, storeName, brand))
    } catch (err) {
      const { status, error, logMsg } = classifyFetchError(err)
      fastify.log.warn({ err, storeName, brand }, `${logMsg} en /preview`)
      return reply.status(status).send({ ok: false, error })
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
    const { dateFrom, dateTo, storeName, brand, uuids = {} } = request.body

    let rows
    try {
      ;({ rows } = await fetchAndTransform(fastify, dateFrom, dateTo, storeName, brand))
    } catch (err) {
      const { status, error, logMsg } = classifyFetchError(err)
      fastify.log.warn({ err, storeName, brand }, `${logMsg} en /download`)
      return reply.status(status).send({ ok: false, error })
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
          brand:    { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { dateFrom, dateTo, brand } = request.query
    // Serie de la marca → filtra las globales para no traer UUIDs de otra marca.
    // Si la marca no tiene serie configurada, serie = undefined → sin filtro.
    const serie = getFacturamaSerie(brand)

    // getUUIDsForRange retorna {} directamente si Facturama no está configurado,
    // por lo que no se necesita guard previo con isFacturamaConfigured().
    try {
      const uuids = await getUUIDsForRange(dateFrom, dateTo, serie)
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
