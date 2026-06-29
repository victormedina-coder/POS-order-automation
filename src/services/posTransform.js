import { getInternalId, getLocationConfig, getPaymentMethods } from './catalog.js'
import { getDefaultBrand } from '../config/brands.js'

const VALID_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED', 'PARTIALLY_PAID'])

const GATEWAY_TO_CLAVE = {
  'cash': '1', 'efectivo': '1',
  'tarjeta': '4', 'tarjeta de crédito': '4', 'tarjeta de credito': '4',
  'débito': '28', 'debito': '28',
  'tarjeta de débito': '28', 'tarjeta de debito': '28',
}

function getSuccessfulGateway(transactions) {
  const successful = transactions.filter(
    t => t.status === 'SUCCESS' && ['SALE', 'EXCHANGE'].includes(t.kind)
  )
  if (successful.length === 0) return ''

  const uniqueGateways = [...new Set(successful.map(t => t.gateway.toLowerCase().trim()))]
  return uniqueGateways.length === 1 ? uniqueGateways[0] : 'multiple'
}

function getPaymentMethod(gateway, paymentMethods) {
  if (gateway === 'multiple') return '99 - Por definir'

  const g = gateway.toLowerCase().trim()
  const clave = GATEWAY_TO_CLAVE[g] ?? '4'
  return paymentMethods[clave] ?? '04 - Tarjeta de Crédito'
}

function formatDateCST(isoString) {
  const local = new Date(new Date(isoString).getTime() - 6 * 60 * 60 * 1000)
  const d = local.toISOString().slice(0, 10)
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
}

// Factor de IVA México (16 %)
const IVA_FACTOR = 1.16

// Placeholder del Internal ID para líneas SIN match en el catálogo (SKU vacío o no
// cargado). La línea NO se descarta: el CSV se genera con este marcador y luego se
// reemplaza MANUALMENTE (Buscar y reemplazar) por el Internal ID del item NO
// INVENTARIABLE de NetSuite. Cambiar el texto aquí si se prefiere otro marcador.
const FALLBACK_INTERNAL_ID = 'SIN_SKU'

/**
 * Transforma los pedidos Shopify en filas CSV para NetSuite.
 *
 * Retorna { rows, stats, errors }.
 * - rows:   array de objetos con las columnas del CSV.
 * - stats:  { totalOrders, totalLines }.
 * - errors: array de { orderName, message } — errores por orden (no bloquean el resto).
 *
 * Lanza si la tienda no existe en catalog_locations.
 */
export function transformOrders(orders, storeName, brand) {
  const b = brand ?? getDefaultBrand()
  const store = getLocationConfig(storeName, b)
  if (!store) throw new Error(`Tienda '${storeName}' no encontrada en catalog_locations`)

  const paymentMethods = getPaymentMethods(b)
  const rows = []
  const errors = []

  // Diagnóstico del embudo de filtrado: por qué se descartan pedidos/líneas.
  // (El descarte de línea por SKU ausente en el catálogo era SILENCIOSO — esto lo expone.)
  const diag = {
    fetched: orders.length,
    notPos: 0,
    wrongLocation: 0,
    badStatus: 0,
    cancelled: 0,
    linesFallback: 0,
    missingSkus: new Set(),
    locationsSeen: new Set(),
    excludedByStatus: [],
  }

  for (const order of orders) {
    try {
      if (order.sourceName !== 'pos') { diag.notPos++; continue }

      const orderLocation = (order.physicalLocation?.name ?? '').toLowerCase().trim()
      diag.locationsSeen.add(order.physicalLocation?.name ?? '(sin ubicación)')
      if (orderLocation !== String(store.shopify_location).toLowerCase().trim()) { diag.wrongLocation++; continue }

      if (!VALID_STATUSES.has(order.displayFinancialStatus)) {
        diag.badStatus++
        if (diag.excludedByStatus.length < 25) {
          diag.excludedByStatus.push({ name: order.name, status: order.displayFinancialStatus })
        }
        continue
      }
      if (order.cancelledAt) { diag.cancelled++; continue }

      const returnedQtys = order.returnedLineItemIds ?? {}
      const gateway = getSuccessfulGateway(order.transactions)
      const paymentMethod = getPaymentMethod(gateway, paymentMethods)
      const orderDate = formatDateCST(order.createdAt)

      for (const { node: li } of order.lineItems.edges) {
        const returnedQty = returnedQtys[li.id] ?? 0
        const effectiveQty = li.quantity - returnedQty
        if (effectiveQty <= 0) continue

        const sku = (li.sku ?? '').trim()
        // Match exacto contra el catálogo. Si NO hay match, la línea se INCLUYE con
        // el placeholder (para llenar a mano el item no inventariable después).
        const matchedInternalId = getInternalId(sku, b)
        const internalId = matchedInternalId ?? FALLBACK_INTERNAL_ID
        if (!matchedInternalId) {
          diag.linesFallback++
          if (diag.missingSkus.size < 25) diag.missingSkus.add(sku || '(SKU vacío)')
        }

        const unitPrice      = parseFloat(li.originalUnitPriceSet.shopMoney.amount)
        const totalDiscount  = li.discountAllocations.reduce(
          (sum, d) => sum + parseFloat(d.allocatedAmountSet.shopMoney.amount), 0
        )
        const discountPerUnit    = totalDiscount / li.quantity
        const priceAfterDiscount = unitPrice - discountPerUnit
        const netPrice           = (priceAfterDiscount / IVA_FACTOR).toFixed(6)

        rows.push({
          'Order Date': orderDate,
          'Order Number': order.name,
          'Sales Rep ID': store.rep_id,
          'Internal ID': internalId,
          'Net Price': netPrice,
          'Item Qty': effectiveQty,
          'Payment Method UUID': paymentMethod,
          'Oracle Location': store.oracle_location,
          'UUID': '',
          'Price Level': 'Personalizado',
        })
      }
    } catch (e) {
      errors.push({ orderName: order.name, message: e.message })
    }
  }

  const stats = {
    totalOrders: new Set(rows.map(r => r['Order Number'])).size,
    totalLines: rows.length,
  }

  const diagnostics = {
    fetched: diag.fetched,
    notPos: diag.notPos,
    wrongLocation: diag.wrongLocation,
    badStatus: diag.badStatus,
    cancelled: diag.cancelled,
    linesFallback: diag.linesFallback,
    missingSkus: [...diag.missingSkus],
    locationsSeen: [...diag.locationsSeen],
    excludedByStatus: diag.excludedByStatus,
    matchedOrders: stats.totalOrders,
  }

  return { rows, stats, errors, diagnostics }
}
