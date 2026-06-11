const SHOPIFY_STORE = process.env.SHOPIFY_STORE
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN
const GRAPHQL_URL = `https://${SHOPIFY_STORE}/admin/api/2025-07/graphql.json`

const shopifyQuery = `
  query GetOrders($query: String!, $cursor: String) {
    orders(first: 50, query: $query, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id name createdAt displayFinancialStatus cancelledAt
          sourceName
          physicalLocation { name }
          transactions { gateway status kind }
          lineItems(first: 50) {
            edges {
              node {
                id sku quantity
                originalUnitPriceSet { shopMoney { amount } }
                discountAllocations {
                  allocatedAmountSet { shopMoney { amount } }
                }
              }
            }
          }
        }
      }
    }
  }
`

async function gqlRequest(query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`)
  }

  const json = await res.json()
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`)
  }
  return json.data
}

async function fetchAllOrders(queryStr) {
  const orders = []
  let cursor = null

  do {
    const data = await gqlRequest(shopifyQuery, { query: queryStr, cursor })
    const { edges, pageInfo } = data.orders

    for (const { node } of edges) {
      orders.push(node)
    }

    cursor = pageInfo.hasNextPage ? pageInfo.endCursor : null
  } while (cursor)

  return orders
}

// Patrón válido para un Shopify Global ID de tipo Order.
const SHOPIFY_ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/

/**
 * Construye la query GraphQL batched para obtener devoluciones de un lote de pedidos.
 * Filtra IDs inválidos según SHOPIFY_ORDER_GID.
 * Retorna null si ningún ID del batch supera la validación.
 */
function buildReturnsBatchQuery(batch) {
  const aliases = []
  for (let idx = 0; idx < batch.length; idx++) {
    if (!SHOPIFY_ORDER_GID.test(batch[idx].id)) continue
    aliases.push(`
        o${idx}: order(id: "${batch[idx].id}") {
          id
          returns(first: 10) {
            edges {
              node {
                returnLineItems(first: 20) {
                  edges {
                    node {
                      ... on ReturnLineItem {
                        quantity
                        fulfillmentLineItem {
                          lineItem { id }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }`)
  }
  if (aliases.length === 0) return null
  return `query GetReturns {${aliases.join('')}}`
}

async function fetchReturns(returnedOrders) {
  const returnsMap = {}
  const batchSize = 10

  for (let i = 0; i < returnedOrders.length; i += batchSize) {
    const batch = returnedOrders.slice(i, i + batchSize)

    const query = buildReturnsBatchQuery(batch)
    if (query === null) continue  // ningún ID válido en este batch

    const data = await gqlRequest(query)

    for (const orderData of Object.values(data)) {
      if (!orderData?.id || !orderData.returns) continue

      const idsWithQty = {}
      for (const { node: ret } of orderData.returns.edges) {
        if (!ret?.returnLineItems) continue
        for (const { node } of ret.returnLineItems.edges) {
          if (node?.fulfillmentLineItem?.lineItem) {
            const liId = node.fulfillmentLineItem.lineItem.id
            idsWithQty[liId] = (idsWithQty[liId] ?? 0) + (node.quantity ?? 1)
          }
        }
      }
      returnsMap[orderData.id] = idsWithQty
    }

    const isLastBatch = i + batchSize >= returnedOrders.length
    if (!isLastBatch) {
      await new Promise(r => setTimeout(r, 500))
    }
  }

  return returnsMap
}

export async function fetchOrders(dateFrom, dateTo) {
  const dateRangeQuery = `created_at:>='${dateFrom}T00:00:00-06:00' created_at:<='${dateTo}T23:59:59-06:00' (financial_status:paid OR financial_status:partially_refunded OR financial_status:partially_paid)`

  const allOrders = await fetchAllOrders(dateRangeQuery)
  const returnedOrders = await fetchAllOrders(dateRangeQuery + ' return_status:returned')

  if (returnedOrders.length > 0) {
    const returnsMap = await fetchReturns(returnedOrders)
    for (const order of allOrders) {
      order.returnedLineItemIds = returnsMap[order.id] ?? {}
    }
  } else {
    for (const order of allOrders) {
      order.returnedLineItemIds = {}
    }
  }

  return allOrders
}
