/**
 * test/shopify.test.js
 *
 * Tests para src/services/shopify.js → createShopifyClient
 *
 * Estrategia:
 *   - Mockeamos global.fetch con mock.method (node:test) para interceptar
 *     requests HTTP sin tocar la red real.
 *   - El _tokenCache es privado (closure del módulo), por lo que no podemos
 *     resetearlo entre tests. Para aislar el cache entre tests de OAuth usamos
 *     claves de marca únicas por test (mock_brand_N).
 *   - Para auth "static" no hay cache — el token viene del brandConfig directamente.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { createShopifyClient } from '../src/services/shopify.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Crea un mock de Response tipo fetch.
 * IMPORTANTE: gqlRequest hace `const json = await res.json()` y luego retorna
 * `json.data`. Así que para respuestas GraphQL, el body debe ser { data: { ... } }.
 * Para la respuesta del token OAuth, el body es directamente { access_token, expires_in }.
 */
function makeFetchResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

/** brandConfig para auth static */
function makeStaticConfig(key = 'test_static') {
  return {
    key,
    label: 'Test Static Brand',
    shopify: {
      store: 'test-store.myshopify.com',
      auth: 'static',
      accessToken: 'shpat_static_test_token',
    },
  }
}

/** brandConfig para auth oauth con clave única para aislar cache */
function makeOAuthConfig(key) {
  return {
    key,
    label: 'Test OAuth Brand',
    shopify: {
      store: 'oauth-store.myshopify.com',
      auth: 'oauth',
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
    },
  }
}

/**
 * Respuesta GraphQL mínima que fetchAllOrders acepta.
 * fetchOrders llama internamente a fetchAllOrders DOS veces:
 *   1. Para traer todos los pedidos del rango.
 *   2. Para traer pedidos con return_status:returned.
 * Ambas llamadas van al mismo endpoint GraphQL.
 *
 * gqlRequest extrae `json.data` de la respuesta, así que el mock fetch
 * debe retornar { data: { orders: { edges, pageInfo } } }.
 */
function makeGraphQLOrdersResponse(orders = []) {
  return {
    data: {
      orders: {
        edges: orders.map(o => ({ node: o })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }
}

// ─── Auth Static ──────────────────────────────────────────────────────────────

describe('createShopifyClient — auth static', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    mock.restoreAll()
  })

  test('usa el accessToken fijo en el header X-Shopify-Access-Token', async () => {
    const capturedRequests = []

    global.fetch = async (url, options) => {
      capturedRequests.push({ url, options })
      return makeFetchResponse(makeGraphQLOrdersResponse())
    }

    const client = createShopifyClient(makeStaticConfig('static_header_test'))
    await client.fetchOrders('2025-01-01', '2025-01-31')

    assert.ok(capturedRequests.length >= 1, 'Se debe haber llamado fetch al menos una vez')

    // La primera llamada es la GraphQL de orders
    const [req] = capturedRequests
    assert.equal(
      req.options.headers['X-Shopify-Access-Token'],
      'shpat_static_test_token',
      'El header debe llevar el accessToken fijo'
    )
  })

  test('NO hace ningún POST a /admin/oauth/access_token (auth estático no necesita token)', async () => {
    const postToOAuth = []

    global.fetch = async (url, options) => {
      if (String(url).includes('/admin/oauth/access_token')) {
        postToOAuth.push(url)
      }
      return makeFetchResponse(makeGraphQLOrdersResponse())
    }

    const client = createShopifyClient(makeStaticConfig('static_no_oauth_test'))
    await client.fetchOrders('2025-01-01', '2025-01-31')

    assert.equal(postToOAuth.length, 0, 'No debe haber POSTs al endpoint OAuth para auth static')
  })

  test('construye la URL de GraphQL con el store correcto', async () => {
    const urls = []

    global.fetch = async (url, options) => {
      urls.push(String(url))
      return makeFetchResponse(makeGraphQLOrdersResponse())
    }

    const config = makeStaticConfig('static_url_test')
    const client = createShopifyClient(config)
    await client.fetchOrders('2025-01-01', '2025-01-31')

    assert.ok(
      urls.some(u => u.includes('test-store.myshopify.com')),
      'La URL debe contener el store de la marca'
    )
  })
})

// ─── Auth OAuth ───────────────────────────────────────────────────────────────

describe('createShopifyClient — auth oauth', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    mock.restoreAll()
  })

  test('hace POST a /admin/oauth/access_token con grant_type=client_credentials', async () => {
    // Clave única para evitar hits de cache de tests anteriores
    const brandKey = `oauth_post_test_${Date.now()}`
    const capturedRequests = []
    let callCount = 0

    global.fetch = async (url, options) => {
      capturedRequests.push({ url: String(url), options })
      callCount++

      if (String(url).includes('/admin/oauth/access_token')) {
        return makeFetchResponse({
          access_token: 'oauth_fresh_token',
          expires_in: 3600,
        })
      }
      // GraphQL
      return makeFetchResponse(makeGraphQLOrdersResponse())
    }

    const client = createShopifyClient(makeOAuthConfig(brandKey))
    await client.fetchOrders('2025-01-01', '2025-01-31')

    const oauthReq = capturedRequests.find(r => r.url.includes('/admin/oauth/access_token'))
    assert.ok(oauthReq, 'Debe haber un POST al endpoint OAuth')
    assert.equal(oauthReq.options.method, 'POST')

    // Verifica el body: debe ser application/x-www-form-urlencoded con grant_type=client_credentials
    const bodyStr = oauthReq.options.body.toString()
    assert.ok(bodyStr.includes('grant_type=client_credentials'), `body: ${bodyStr}`)
    assert.ok(bodyStr.includes('client_id=test_client_id'), `body: ${bodyStr}`)
    assert.ok(bodyStr.includes('client_secret=test_client_secret'), `body: ${bodyStr}`)
  })

  test('usa el token OAuth obtenido en el header X-Shopify-Access-Token de GraphQL', async () => {
    const brandKey = `oauth_header_test_${Date.now()}`
    const graphqlHeaders = []

    global.fetch = async (url, options) => {
      if (String(url).includes('/admin/oauth/access_token')) {
        return makeFetchResponse({ access_token: 'oauth_header_token', expires_in: 3600 })
      }
      // Es una llamada GraphQL — capturamos el header
      graphqlHeaders.push(options?.headers?.['X-Shopify-Access-Token'])
      return makeFetchResponse(makeGraphQLOrdersResponse())
    }

    const client = createShopifyClient(makeOAuthConfig(brandKey))
    await client.fetchOrders('2025-01-01', '2025-01-31')

    assert.ok(graphqlHeaders.length > 0, 'Debe haber al menos una llamada GraphQL')
    for (const token of graphqlHeaders) {
      assert.equal(token, 'oauth_header_token', 'El header debe tener el token OAuth')
    }
  })

  test('cache hit: un segundo fetchOrders NO vuelve a pedir token OAuth', async () => {
    const brandKey = `oauth_cache_test_${Date.now()}`
    let oauthCallCount = 0

    global.fetch = async (url, options) => {
      if (String(url).includes('/admin/oauth/access_token')) {
        oauthCallCount++
        return makeFetchResponse({ access_token: 'cached_token', expires_in: 3600 })
      }
      return makeFetchResponse(makeGraphQLOrdersResponse())
    }

    const client = createShopifyClient(makeOAuthConfig(brandKey))
    await client.fetchOrders('2025-01-01', '2025-01-15')
    await client.fetchOrders('2025-01-16', '2025-01-31')

    assert.equal(oauthCallCount, 1, 'El token OAuth debe solicitarse solo una vez (cache hit en segundo request)')
  })

  test('aísla el cache de token entre marcas distintas', async () => {
    const brandKeyA = `oauth_iso_a_${Date.now()}`
    const brandKeyB = `oauth_iso_b_${Date.now()}`

    const tokensIssuedTo = {}

    global.fetch = async (url, options) => {
      if (String(url).includes('/admin/oauth/access_token')) {
        // Extraemos client_id del body para saber de qué marca es
        const body = options?.body?.toString() ?? ''
        const match = body.match(/client_id=([^&]+)/)
        const clientId = match?.[1] ?? 'unknown'
        tokensIssuedTo[clientId] = (tokensIssuedTo[clientId] ?? 0) + 1
        return makeFetchResponse({ access_token: `token_for_${clientId}`, expires_in: 3600 })
      }
      return makeFetchResponse(makeGraphQLOrdersResponse())
    }

    const configA = { ...makeOAuthConfig(brandKeyA), shopify: { ...makeOAuthConfig(brandKeyA).shopify, clientId: 'client_a' } }
    const configB = { ...makeOAuthConfig(brandKeyB), shopify: { ...makeOAuthConfig(brandKeyB).shopify, clientId: 'client_b' } }

    const clientA = createShopifyClient(configA)
    const clientB = createShopifyClient(configB)

    await clientA.fetchOrders('2025-01-01', '2025-01-31')
    await clientB.fetchOrders('2025-01-01', '2025-01-31')

    // Cada marca debe haber pedido su propio token exactamente una vez
    assert.equal(tokensIssuedTo['client_a'], 1, 'Marca A debe pedir token 1 vez')
    assert.equal(tokensIssuedTo['client_b'], 1, 'Marca B debe pedir token 1 vez')
  })

  test('lanza si el endpoint OAuth responde con error HTTP', async () => {
    const brandKey = `oauth_error_test_${Date.now()}`

    global.fetch = async (url, options) => {
      if (String(url).includes('/admin/oauth/access_token')) {
        return makeFetchResponse({ error: 'invalid_client' }, { ok: false, status: 401 })
      }
      return makeFetchResponse(makeGraphQLOrdersResponse())
    }

    const client = createShopifyClient(makeOAuthConfig(brandKey))
    await assert.rejects(
      () => client.fetchOrders('2025-01-01', '2025-01-31'),
      (err) => {
        assert.ok(err.message.includes('401'), `error: ${err.message}`)
        return true
      }
    )
  })
})

// ─── NOTA sobre refresh 60s antes de expirar ─────────────────────────────────
//
// El comportamiento de "renovar el token 60 segundos antes de que expire"
// no puede testarse directamente sin:
//   (a) avanzar el reloj (mock.timers) — que requiere que el código use Date.now()
//       de forma interceptable, o
//   (b) inyectar una función "now" en getShopifyToken (cambio de testabilidad).
//
// En el código actual, _tokenCache usa Date.now() internamente y no hay manera
// de inyectar el reloj sin modificar código de producción.
//
// PENDIENTE: Para testear el refresh, refactorizar getShopifyToken para aceptar
// un parámetro opcional `nowFn = Date.now` (cambio mínimo de testabilidad).
// Documentado aquí como caso pendiente según las instrucciones del objetivo.
