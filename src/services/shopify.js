// ─── Helpers de módulo (sin dependencia de credenciales) ─────────────────────

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

// ─── Cache de tokens OAuth por marca ─────────────────────────────────────────
// key de marca → { accessToken: string, expiresAt: number (ms) }
const _tokenCache = new Map()

/**
 * Obtiene un access token OAuth de Shopify para la marca indicada.
 * Reutiliza el token en caché si no ha expirado (con 60s de margen).
 * Si expiró o no existe, solicita uno nuevo via client_credentials.
 *
 * @param {{ key: string, shopify: { store: string, clientId: string, clientSecret: string } }} brandConfig
 * @returns {Promise<string>} access token
 */
async function getShopifyToken(brandConfig) {
  const { key } = brandConfig
  const { store, clientId, clientSecret } = brandConfig.shopify

  const cached = _tokenCache.get(key)
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken
  }

  const url = `https://${store}/admin/oauth/access_token`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  })

  if (!res.ok) {
    throw new Error(`Shopify token HTTP ${res.status} para '${key}': ${await res.text()}`)
  }

  const data = await res.json()
  const expiresIn = data.expires_in ?? 86400
  _tokenCache.set(key, {
    accessToken: data.access_token,
    expiresAt:   Date.now() + expiresIn * 1000,
  })

  console.log(`[shopify] Token OAuth renovado para '${key}', expira en ${expiresIn}s`)
  return data.access_token
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Crea un cliente Shopify para la marca indicada.
 * Soporta dos modos de autenticación según brandConfig.shopify.auth:
 *   - "static": usa el accessToken fijo resuelto en getBrandConfig().
 *   - "oauth":  obtiene y rota automáticamente el token via client_credentials.
 *
 * @param {{ key: string, label: string, shopify: { store: string, auth: string, accessToken?: string, clientId?: string, clientSecret?: string } }} brandConfig
 *   Resultado de getBrandConfig() de src/config/brands.js.
 * @returns {{ fetchOrders: (dateFrom: string, dateTo: string) => Promise<object[]> }}
 */
export function createShopifyClient(brandConfig) {
  const { store, auth } = brandConfig.shopify
  const GRAPHQL_URL = `https://${store}/admin/api/2025-07/graphql.json`

  // Resuelve la función que provee el token según el modo de auth.
  let getToken
  if (auth === 'oauth') {
    getToken = () => getShopifyToken(brandConfig)
  } else {
    // auth === 'static' (o ausente por compatibilidad)
    const { accessToken } = brandConfig.shopify
    getToken = async () => accessToken
  }

  async function gqlRequest(query, variables = {}) {
    const token = await getToken()
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
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

  async function fetchOrders(dateFrom, dateTo) {
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

  return { fetchOrders }
}
