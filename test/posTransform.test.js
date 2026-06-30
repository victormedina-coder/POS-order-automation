/**
 * test/posTransform.test.js
 *
 * Tests para src/services/posTransform.js → transformOrders()
 *
 * Estrategia de aislamiento:
 *   - posTransform.js llama a getInternalId/getLocationConfig/getPaymentMethods de
 *     catalog.js, que depende del singleton db (client.js).
 *   - Fijamos DATABASE_PATH a un archivo temporal ANTES de importar cualquier módulo.
 *   - Importamos los módulos REALES con import() dinámico (top-level await).
 *   - Sembramos el catálogo con bulkUpsert real en un before().
 *   - Llamamos transformOrders() real — ejerce la integración completa.
 *
 * node:test ejecuta cada archivo en su propio proceso hijo → aislamiento total.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// ── DB temporal única para este proceso ──────────────────────────────────────
const DB_FILE = join(tmpdir(), `mb-postransform-${process.pid}-${Date.now()}.db`)

// ── Fijar DATABASE_PATH ANTES de importar módulos de producción ───────────────
process.env.DATABASE_PATH = DB_FILE

// ── Importar módulos REALES (top-level await ESM) ────────────────────────────
const { runMigrations }   = await import('../src/db/schema.js')
const catalog             = await import('../src/services/catalog.js')
const { transformOrders } = await import('../src/services/posTransform.js')
// db singleton — necesario para cerrarlo antes de borrar el archivo en Windows
const { default: db }     = await import('../src/db/client.js')

// ── Limpieza al terminar ──────────────────────────────────────────────────────
after(() => {
  try { db.close() } catch {}
  rmSync(DB_FILE,            { force: true })
  rmSync(DB_FILE + '-wal',   { force: true })
  rmSync(DB_FILE + '-shm',   { force: true })
})

// ── Setup: migrar DB + seed catálogo ─────────────────────────────────────────

before(() => {
  runMigrations()

  // Items de ariat
  catalog.bulkUpsert('items', [
    { sku: 'ARIAT_SKU_001', internal_id: 'NS_A001' },
    { sku: 'ARIAT_SKU_002', internal_id: 'NS_A002' },
  ], 'ariat')

  // Items de stetson
  catalog.bulkUpsert('items', [
    { sku: 'STETSON_SKU_001', internal_id: 'NS_S001' },
  ], 'stetson')

  // Locations de ariat
  catalog.bulkUpsert('locations', [
    {
      store_name:       'Tienda Ariat GDL',
      oracle_location:  'ORL_ARIAT_GDL',
      rep_id:           'REP_A_1',
      shopify_location: 'ariat_gdl',
    },
  ], 'ariat')

  // Locations de stetson
  catalog.bulkUpsert('locations', [
    {
      store_name:       'Tienda Stetson MTY',
      oracle_location:  'ORL_STETSON_MTY',
      rep_id:           'REP_S_1',
      shopify_location: 'stetson_mty',
    },
  ], 'stetson')

  // Payment methods de ariat
  catalog.bulkUpsert('payment_methods', [
    { clave: '1',  payment_type: '01 - Efectivo' },
    { clave: '4',  payment_type: '04 - Tarjeta de Crédito' },
  ], 'ariat')

  // Payment methods de stetson
  catalog.bulkUpsert('payment_methods', [
    { clave: '1',  payment_type: '01 - Efectivo Stetson' },
    { clave: '28', payment_type: '28 - Débito Stetson' },
  ], 'stetson')
})

// ── Helpers para construir pedidos Shopify de muestra ─────────────────────────

function makeLineItem(id, sku, quantity, unitPrice, discounts = []) {
  return {
    node: {
      id,
      sku,
      quantity,
      originalUnitPriceSet: { shopMoney: { amount: String(unitPrice) } },
      discountAllocations: discounts.map(amount => ({
        allocatedAmountSet: { shopMoney: { amount: String(amount) } },
      })),
    },
  }
}

function makeOrder({
  id                  = 'gid://shopify/Order/1',
  name                = '#1001',
  createdAt           = '2025-01-15T12:00:00Z',
  displayFinancialStatus = 'PAID',
  cancelledAt         = null,
  sourceName          = 'pos',
  physicalLocationName = 'ariat_gdl',
  gateway             = 'efectivo',
  lineItems           = [],
  returnedLineItemIds = {},
} = {}) {
  return {
    id,
    name,
    createdAt,
    displayFinancialStatus,
    cancelledAt,
    sourceName,
    physicalLocation: { name: physicalLocationName },
    transactions: [
      { gateway, status: 'SUCCESS', kind: 'SALE' },
    ],
    lineItems: { edges: lineItems },
    returnedLineItemIds,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// transformOrders — lanza si tienda no existe en la marca
// ─────────────────────────────────────────────────────────────────────────────

describe('posTransform — lanza si tienda no encontrada', () => {
  test('lanza con mensaje claro cuando la tienda no existe en la marca pedida', () => {
    assert.throws(
      () => transformOrders([], 'tienda_inexistente', 'ariat'),
      (err) => {
        assert.ok(err.message.includes('tienda_inexistente'), `mensaje: ${err.message}`)
        assert.ok(err.message.includes('catalog_locations'),  `mensaje: ${err.message}`)
        return true
      }
    )
  })

  test('lanza cuando se pide tienda de stetson con brand=ariat', () => {
    // stetson_mty existe en catálogo de stetson, pero NO en el de ariat
    assert.throws(
      () => transformOrders([], 'stetson_mty', 'ariat'),
      (err) => {
        assert.ok(err.message.includes('stetson_mty'), `mensaje: ${err.message}`)
        return true
      }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Transformación correcta
// ─────────────────────────────────────────────────────────────────────────────

describe('posTransform — transformación correcta de pedidos', () => {
  test('transforma un pedido simple con precio, rep_id, oracle_location y UUID vacío', () => {
    const orders = [
      makeOrder({
        name: '#2001',
        createdAt: '2025-06-15T18:00:00Z',  // 12:00 CST (UTC-6)
        displayFinancialStatus: 'PAID',
        physicalLocationName: 'ariat_gdl',
        gateway: 'efectivo',
        lineItems: [
          makeLineItem('gid://shopify/LineItem/1', 'ARIAT_SKU_001', 2, '116.00'),
        ],
      }),
    ]

    const { rows, stats, errors } = transformOrders(orders, 'ariat_gdl', 'ariat')

    assert.equal(errors.length, 0)
    assert.equal(rows.length, 1)
    assert.equal(stats.totalOrders, 1)
    assert.equal(stats.totalLines,  1)

    const row = rows[0]
    assert.equal(row['Order Number'],   '#2001')
    assert.equal(row['Internal ID'],    'NS_A001')
    assert.equal(row['Item Qty'],       2)
    assert.equal(row['Sales Rep ID'],   'REP_A_1')
    assert.equal(row['Oracle Location'],'ORL_ARIAT_GDL')
    assert.equal(row['Price Level'],    'Personalizado')
    // UUID siempre vacío en salida de transformOrders (el alta por API lo llenará)
    assert.equal(row['UUID'], '')
    // netPrice = (116 / 1.16).toFixed(6) = '100.000000'
    assert.equal(row['Net Price'], '100.000000')
    assert.equal(row['Payment Method UUID'], '01 - Efectivo')
  })

  test('Net Price = (precio - descuento/unidad) / 1.16 con toFixed(6)', () => {
    // unitPrice=116, discount total=23.20 sobre qty=2 → discountPerUnit=11.6
    // priceAfterDiscount = 116 - 11.6 = 104.4 → netPrice = 104.4/1.16 = 90.000000
    const orders = [
      makeOrder({
        name: '#2002',
        lineItems: [
          makeLineItem('gid://shopify/LineItem/2', 'ARIAT_SKU_001', 2, '116.00', ['23.20']),
        ],
        physicalLocationName: 'ariat_gdl',
      }),
    ]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]['Net Price'], '90.000000')
  })

  test('línea sin match en catálogo se incluye con Internal ID = SIN_SKU (no se descarta)', () => {
    const orders = [
      makeOrder({
        name: '#2003',
        lineItems: [
          makeLineItem('gid://shopify/LineItem/3', 'SKU_SIN_MAPPING', 1, '100.00'),
          makeLineItem('gid://shopify/LineItem/4', 'ARIAT_SKU_001',   1, '116.00'),
        ],
        physicalLocationName: 'ariat_gdl',
      }),
    ]
    const { rows, diagnostics } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows.length, 2, 'Ambas líneas aparecen: la matcheada y la de fallback')

    const matched  = rows.find(r => r['Internal ID'] === 'NS_A001')
    const fallback = rows.find(r => r['Internal ID'] === 'SIN_SKU')
    assert.ok(matched,  'el item con SKU en catálogo resuelve a su Internal ID')
    assert.ok(fallback, 'el item sin match se incluye con el placeholder SIN_SKU')
    // El fallback conserva precio y cantidad reales para el reemplazo manual posterior.
    assert.equal(fallback['Item Qty'], 1)
    assert.equal(fallback['Net Price'], (100 / 1.16).toFixed(6))
    assert.equal(diagnostics.linesFallback, 1, 'el embudo registra la línea de fallback')
  })

  test('línea sin SKU y precio 0 (bolsa de sucursal) se ignora', () => {
    const orders = [
      makeOrder({
        name: '#2004',
        lineItems: [
          makeLineItem('li_bag',  '',              1, '0'),
          makeLineItem('li_real', 'ARIAT_SKU_001', 1, '116.00'),
        ],
        physicalLocationName: 'ariat_gdl',
      }),
    ]
    const { rows, diagnostics } = transformOrders(orders, 'ariat_gdl', 'ariat')

    assert.equal(rows.length, 1, 'solo la línea real debe aparecer; la bolsa se descarta')
    assert.equal(rows[0]['Internal ID'], 'NS_A001')
    assert.equal(diagnostics.skippedNoSkuZeroPrice, 1)
    assert.equal(diagnostics.linesFallback, 0, 'la bolsa no debe contar como fallback')
  })

  test('línea sin SKU pero con precio > 0 sigue cayendo a SIN_SKU (control)', () => {
    const orders = [
      makeOrder({
        name: '#2005',
        lineItems: [
          makeLineItem('li_nosku_priced', '', 1, '100.00'),
        ],
        physicalLocationName: 'ariat_gdl',
      }),
    ]
    const { rows, diagnostics } = transformOrders(orders, 'ariat_gdl', 'ariat')

    assert.equal(rows.length, 1)
    assert.equal(rows[0]['Internal ID'], 'SIN_SKU')
    assert.equal(diagnostics.skippedNoSkuZeroPrice, 0)
    assert.equal(diagnostics.linesFallback, 1)
  })

  test('línea con SKU no vacío pero NO cargado en catálogo y precio 0 (bolsa con SKU) se ignora', () => {
    const orders = [
      makeOrder({
        name: '#2006',
        lineItems: [
          makeLineItem('li_bag_sku', 'BOLSA',         1, '0'),
          makeLineItem('li_real',    'ARIAT_SKU_001', 1, '116.00'),
        ],
        physicalLocationName: 'ariat_gdl',
      }),
    ]
    const { rows, diagnostics } = transformOrders(orders, 'ariat_gdl', 'ariat')

    assert.equal(rows.length, 1, 'solo la línea real debe aparecer; la bolsa con SKU se descarta')
    assert.equal(rows[0]['Internal ID'], 'NS_A001')
    assert.equal(diagnostics.skippedNoSkuZeroPrice, 1)
    assert.equal(diagnostics.linesFallback, 0, 'la bolsa no debe contar como fallback')
  })

  test('línea con SKU no cargado y precio > 0 sigue cayendo a SIN_SKU (control)', () => {
    const orders = [
      makeOrder({
        name: '#2007',
        lineItems: [
          makeLineItem('li_sku_priced', 'BOLSA', 1, '50.00'),
        ],
        physicalLocationName: 'ariat_gdl',
      }),
    ]
    const { rows, diagnostics } = transformOrders(orders, 'ariat_gdl', 'ariat')

    assert.equal(rows.length, 1)
    assert.equal(rows[0]['Internal ID'], 'SIN_SKU')
    assert.equal(diagnostics.linesFallback, 1)
    assert.equal(diagnostics.skippedNoSkuZeroPrice, 0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Filtros de pedidos
// ─────────────────────────────────────────────────────────────────────────────

describe('posTransform — filtros de pedidos', () => {
  test('omite pedidos con sourceName !== "pos"', () => {
    const orders = [
      makeOrder({ name: '#3001', sourceName: 'web', lineItems: [makeLineItem('li1', 'ARIAT_SKU_001', 1, '116')] }),
      makeOrder({ name: '#3002', sourceName: 'pos', lineItems: [makeLineItem('li2', 'ARIAT_SKU_001', 1, '116')] }),
    ]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]['Order Number'], '#3002')
  })

  test('omite pedidos cancelados (cancelledAt != null)', () => {
    const orders = [
      makeOrder({
        name: '#4001',
        cancelledAt: '2025-01-15T14:00:00Z',
        lineItems: [makeLineItem('li3', 'ARIAT_SKU_001', 1, '116')],
        physicalLocationName: 'ariat_gdl',
      }),
    ]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows.length, 0, 'Pedido cancelado no debe generar rows')
  })

  test('omite pedidos con displayFinancialStatus inválido', () => {
    const orders = [
      makeOrder({ name: '#5001', displayFinancialStatus: 'PENDING',  lineItems: [makeLineItem('li4', 'ARIAT_SKU_001', 1, '116')] }),
      makeOrder({ name: '#5002', displayFinancialStatus: 'REFUNDED', lineItems: [makeLineItem('li5', 'ARIAT_SKU_001', 1, '116')] }),
    ]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows.length, 0)
  })

  test('acepta PARTIALLY_REFUNDED y PARTIALLY_PAID como estados válidos', () => {
    const orders = [
      makeOrder({ name: '#5003', displayFinancialStatus: 'PARTIALLY_REFUNDED', lineItems: [makeLineItem('li6', 'ARIAT_SKU_001', 1, '116')] }),
      makeOrder({ name: '#5004', displayFinancialStatus: 'PARTIALLY_PAID',     lineItems: [makeLineItem('li7', 'ARIAT_SKU_001', 1, '116')] }),
    ]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows.length, 2)
  })

  test('omite pedidos de una physicalLocation que no coincide con la tienda pedida', () => {
    const orders = [
      makeOrder({
        name: '#6001',
        physicalLocationName: 'stetson_mty',  // distinta a 'ariat_gdl'
        lineItems: [makeLineItem('li8', 'ARIAT_SKU_001', 1, '116')],
      }),
    ]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows.length, 0, 'Pedido de otra sucursal debe omitirse')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Devoluciones (returnedLineItemIds)
// ─────────────────────────────────────────────────────────────────────────────

describe('posTransform — devoluciones (returnedLineItemIds)', () => {
  test('descuenta la cantidad devuelta del line item', () => {
    const orders = [
      makeOrder({
        name: '#7001',
        lineItems: [makeLineItem('gid://shopify/LineItem/10', 'ARIAT_SKU_001', 3, '116.00')],
        physicalLocationName: 'ariat_gdl',
        returnedLineItemIds: { 'gid://shopify/LineItem/10': 1 },  // 1 devuelto de 3
      }),
    ]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]['Item Qty'], 2, 'Qty efectiva = 3 - 1 = 2')
  })

  test('descarta line item si la cantidad efectiva es ≤ 0 (todo devuelto)', () => {
    const orders = [
      makeOrder({
        name: '#7002',
        lineItems: [makeLineItem('gid://shopify/LineItem/11', 'ARIAT_SKU_001', 2, '116.00')],
        physicalLocationName: 'ariat_gdl',
        returnedLineItemIds: { 'gid://shopify/LineItem/11': 2 },  // todos devueltos
      }),
    ]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows.length, 0, 'Line item totalmente devuelto debe omitirse')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Métodos de pago
// ─────────────────────────────────────────────────────────────────────────────

describe('posTransform — métodos de pago', () => {
  test('mapea "efectivo" → clave 1 → método de pago del catálogo', () => {
    const orders = [makeOrder({
      gateway: 'efectivo',
      lineItems: [makeLineItem('li20', 'ARIAT_SKU_001', 1, '116')],
      physicalLocationName: 'ariat_gdl',
    })]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows[0]['Payment Method UUID'], '01 - Efectivo')
  })

  test('múltiples gateways distintos → "99 - Por definir"', () => {
    const order = {
      ...makeOrder({
        lineItems: [makeLineItem('li21', 'ARIAT_SKU_001', 1, '116')],
        physicalLocationName: 'ariat_gdl',
      }),
      transactions: [
        { gateway: 'cash',    status: 'SUCCESS', kind: 'SALE' },
        { gateway: 'tarjeta', status: 'SUCCESS', kind: 'SALE' },
      ],
    }
    const { rows } = transformOrders([order], 'ariat_gdl', 'ariat')
    assert.equal(rows[0]['Payment Method UUID'], '99 - Por definir')
  })

  test('gateway desconocido → fallback clave 4 → Tarjeta de Crédito', () => {
    const order = {
      ...makeOrder({
        lineItems: [makeLineItem('li22', 'ARIAT_SKU_001', 1, '116')],
        physicalLocationName: 'ariat_gdl',
      }),
      transactions: [
        { gateway: 'gateway_desconocido', status: 'SUCCESS', kind: 'SALE' },
      ],
    }
    const { rows } = transformOrders([order], 'ariat_gdl', 'ariat')
    assert.equal(rows[0]['Payment Method UUID'], '04 - Tarjeta de Crédito')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Formato de fecha CST (UTC-6)
// ─────────────────────────────────────────────────────────────────────────────

describe('posTransform — formateo de fecha CST', () => {
  test('convierte ISO UTC a fecha DD/MM/YYYY en CST (UTC-6)', () => {
    // 2025-01-15T06:30:00Z → CST 2025-01-15T00:30:00 → 15/01/2025
    const orders = [makeOrder({
      createdAt: '2025-01-15T06:30:00Z',
      lineItems: [makeLineItem('li30', 'ARIAT_SKU_001', 1, '116')],
      physicalLocationName: 'ariat_gdl',
    })]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows[0]['Order Date'], '15/01/2025')
  })

  test('fecha que cruza medianoche CST (UTC 06:00 = medianoche CST)', () => {
    // 2025-01-16T06:00:00Z → CST 2025-01-16T00:00:00 → 16/01/2025
    const orders = [makeOrder({
      createdAt: '2025-01-16T06:00:00Z',
      lineItems: [makeLineItem('li31', 'ARIAT_SKU_001', 1, '116')],
      physicalLocationName: 'ariat_gdl',
    })]
    const { rows } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(rows[0]['Order Date'], '16/01/2025')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

describe('posTransform — stats', () => {
  test('stats.totalOrders y totalLines correctos para múltiples órdenes', () => {
    const orders = [
      makeOrder({
        name: '#9001',
        lineItems: [
          makeLineItem('li40', 'ARIAT_SKU_001', 1, '116'),
          makeLineItem('li41', 'ARIAT_SKU_002', 2, '200'),
        ],
        physicalLocationName: 'ariat_gdl',
      }),
      makeOrder({
        id:   'gid://shopify/Order/2',
        name: '#9002',
        lineItems: [makeLineItem('li42', 'ARIAT_SKU_001', 1, '116')],
        physicalLocationName: 'ariat_gdl',
      }),
    ]
    const { stats } = transformOrders(orders, 'ariat_gdl', 'ariat')
    assert.equal(stats.totalOrders, 2)
    assert.equal(stats.totalLines,  3)
  })

  test('errores por-orden van a errors[] sin abortar el resto', () => {
    // Un pedido malformado (falta lineItems.edges) + uno válido
    const badOrder = {
      id:                    'gid://shopify/Order/99',
      name:                  '#MALO',
      createdAt:             '2025-01-15T12:00:00Z',
      displayFinancialStatus:'PAID',
      cancelledAt:           null,
      sourceName:            'pos',
      physicalLocation:      { name: 'ariat_gdl' },
      transactions:          [{ gateway: 'efectivo', status: 'SUCCESS', kind: 'SALE' }],
      lineItems:             null,  // <-- malformado a propósito
      returnedLineItemIds:   {},
    }
    const goodOrder = makeOrder({
      name: '#BUENO',
      lineItems: [makeLineItem('li99', 'ARIAT_SKU_001', 1, '116')],
      physicalLocationName: 'ariat_gdl',
    })

    const { rows, errors } = transformOrders([badOrder, goodOrder], 'ariat_gdl', 'ariat')

    assert.equal(errors.length, 1,  'El pedido malformado debe ir a errors[]')
    assert.equal(errors[0].orderName, '#MALO')
    assert.equal(rows.length, 1,    'El pedido bueno debe procesarse de todas formas')
    assert.equal(rows[0]['Order Number'], '#BUENO')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Aislamiento de marca stetson
// ─────────────────────────────────────────────────────────────────────────────

describe('posTransform — marca stetson correctamente aislada', () => {
  test('usa catálogo de stetson para buscar internalId, rep_id y oracle_location', () => {
    const orders = [
      makeOrder({
        name: '#S001',
        physicalLocationName: 'stetson_mty',
        gateway: 'efectivo',
        lineItems: [
          makeLineItem('gid://shopify/LineItem/100', 'STETSON_SKU_001', 1, '116.00'),
        ],
      }),
    ]

    const { rows, errors } = transformOrders(orders, 'stetson_mty', 'stetson')

    assert.equal(errors.length, 0)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]['Internal ID'],     'NS_S001')
    assert.equal(rows[0]['Oracle Location'], 'ORL_STETSON_MTY')
    assert.equal(rows[0]['Sales Rep ID'],    'REP_S_1')
    assert.equal(rows[0]['Payment Method UUID'], '01 - Efectivo Stetson')
  })

  test('SKU de ariat no se resuelve en catálogo de stetson → cae a SIN_SKU (no cruza marca)', () => {
    const orders = [
      makeOrder({
        name: '#S002',
        physicalLocationName: 'stetson_mty',
        lineItems: [
          makeLineItem('li_cross', 'ARIAT_SKU_001', 1, '116'),  // SKU de ariat, no en stetson
        ],
      }),
    ]
    const { rows } = transformOrders(orders, 'stetson_mty', 'stetson')
    assert.equal(rows.length, 1, 'la línea se incluye (ya no se descarta)')
    assert.equal(
      rows[0]['Internal ID'], 'SIN_SKU',
      'el SKU de ariat NO debe resolver a un Internal ID de stetson; cae al placeholder'
    )
  })
})
