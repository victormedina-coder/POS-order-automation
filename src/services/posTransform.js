import { getInternalId, getLocationConfig, getPaymentMethods } from './catalog.js'

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
export function transformOrders(orders, storeName) {
  const store = getLocationConfig(storeName)
  if (!store) throw new Error(`Tienda '${storeName}' no encontrada en catalog_locations`)

  const paymentMethods = getPaymentMethods()
  const rows = []
  const errors = []

  for (const order of orders) {
    try {
      if (order.sourceName !== 'pos') continue

      const orderLocation = (order.physicalLocation?.name ?? '').toLowerCase().trim()
      if (orderLocation !== String(store.shopify_location).toLowerCase().trim()) continue

      if (!VALID_STATUSES.has(order.displayFinancialStatus)) continue
      if (order.cancelledAt) continue

      const returnedQtys = order.returnedLineItemIds ?? {}
      const gateway = getSuccessfulGateway(order.transactions)
      const paymentMethod = getPaymentMethod(gateway, paymentMethods)
      const orderDate = formatDateCST(order.createdAt)

      for (const { node: li } of order.lineItems.edges) {
        const returnedQty = returnedQtys[li.id] ?? 0
        const effectiveQty = li.quantity - returnedQty
        if (effectiveQty <= 0) continue

        const sku = (li.sku ?? '').trim()
        const internalId = getInternalId(sku)
        if (!internalId) continue

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

  return { rows, stats, errors }
}
