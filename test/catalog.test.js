/**
 * test/catalog.test.js
 *
 * Tests para src/services/catalog.js — ejercita el módulo REAL.
 *
 * Estrategia de aislamiento:
 *   - client.js abre la DB al importar el módulo, leyendo DATABASE_PATH.
 *   - Fijamos DATABASE_PATH a un archivo temporal único ANTES de importar
 *     cualquier módulo de producción. El import() dinámico (top-level await)
 *     garantiza que el singleton se abra sobre nuestra DB temporal.
 *   - node:test ejecuta cada archivo en su propio proceso hijo → aislamiento total.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// ── DB temporal única para este proceso ──────────────────────────────────────
const DB_FILE = join(tmpdir(), `mb-catalog-${process.pid}-${Date.now()}.db`)

// ── Fijar DATABASE_PATH ANTES de importar módulos de producción ───────────────
process.env.DATABASE_PATH = DB_FILE

// ── Importar módulos REALES (top-level await en ESM) ─────────────────────────
const { runMigrations } = await import('../src/db/schema.js')
const catalog = await import('../src/services/catalog.js')
// db singleton — necesario para cerrarlo antes de borrar el archivo en Windows
const { default: db } = await import('../src/db/client.js')

// ── Limpieza al terminar ──────────────────────────────────────────────────────
after(() => {
  try { db.close() } catch {}
  rmSync(DB_FILE,            { force: true })
  rmSync(DB_FILE + '-wal',   { force: true })
  rmSync(DB_FILE + '-shm',   { force: true })
})

// ── Helpers de seed ───────────────────────────────────────────────────────────

function seedTwoBrands() {
  // Items de ariat
  catalog.bulkUpsert('items', [
    { sku: 'ARIAT_SKU_001',   internal_id: 'NS_ARIAT_001' },
    { sku: 'ARIAT_SKU_002',   internal_id: 'NS_ARIAT_002' },
    { sku: '012345678901.0',  internal_id: 'NS_ARIAT_UPC' },  // SKU con sufijo .0
  ], 'ariat')

  // Items de stetson — mismo SKU que ariat para verificar aislamiento
  catalog.bulkUpsert('items', [
    { sku: 'ARIAT_SKU_001', internal_id: 'NS_STETSON_001' },  // mismo SKU, distinta marca
    { sku: 'STETSON_ONLY',  internal_id: 'NS_STETSON_002' },
  ], 'stetson')

  // Locations de ariat
  catalog.bulkUpsert('locations', [
    { store_name: 'Tienda Ariat GDL', oracle_location: 'ORL_ARIAT_GDL', rep_id: 'REP_ARIAT_1', shopify_location: 'ariat_gdl' },
  ], 'ariat')

  // Locations de stetson
  catalog.bulkUpsert('locations', [
    { store_name: 'Tienda Stetson MTY', oracle_location: 'ORL_STETSON_MTY', rep_id: 'REP_STETSON_1', shopify_location: 'stetson_mty' },
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
}

// ── Setup global: migrar + seed ───────────────────────────────────────────────

before(() => {
  runMigrations()
  seedTwoBrands()
})

// ─────────────────────────────────────────────────────────────────────────────
// getInternalId
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog.getInternalId — aislamiento por marca', () => {
  test('retorna el internal_id correcto para ariat', () => {
    assert.equal(catalog.getInternalId('ARIAT_SKU_001', 'ariat'), 'NS_ARIAT_001')
    assert.equal(catalog.getInternalId('ARIAT_SKU_002', 'ariat'), 'NS_ARIAT_002')
  })

  test('el mismo SKU devuelve internal_id DISTINTO para stetson', () => {
    assert.equal(catalog.getInternalId('ARIAT_SKU_001', 'stetson'), 'NS_STETSON_001')
  })

  test('retorna null si el SKU no existe para la marca solicitada', () => {
    assert.equal(catalog.getInternalId('STETSON_ONLY', 'ariat'), null)
  })

  test('normaliza SKU con sufijo .0 (artefacto Excel/Sheets)', () => {
    // '012345678901.0' debe normalizar a '012345678901' y encontrar el registro
    assert.equal(catalog.getInternalId('012345678901.0', 'ariat'), 'NS_ARIAT_UPC')
    // Sufijo .0 en un SKU de texto también normaliza
    assert.equal(catalog.getInternalId('ARIAT_SKU_001.0', 'ariat'), 'NS_ARIAT_001')
  })

  test('default brand: sin pasar brand resuelve a ariat', () => {
    // Sin argumento brand, getDefaultBrand() devuelve 'ariat'
    assert.equal(catalog.getInternalId('ARIAT_SKU_001'), 'NS_ARIAT_001')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getLocationConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog.getLocationConfig — aislamiento por marca', () => {
  test('retorna la location de ariat por shopify_location', () => {
    const loc = catalog.getLocationConfig('ariat_gdl', 'ariat')
    assert.ok(loc, 'Debe retornar la location')
    assert.equal(loc.oracle_location, 'ORL_ARIAT_GDL')
    assert.equal(loc.rep_id,          'REP_ARIAT_1')
    assert.equal(loc.store_name,      'Tienda Ariat GDL')
  })

  test('retorna null para shopify_location de stetson cuando se busca en ariat', () => {
    assert.equal(catalog.getLocationConfig('stetson_mty', 'ariat'), null)
  })

  test('retorna la location de stetson correctamente', () => {
    const loc = catalog.getLocationConfig('stetson_mty', 'stetson')
    assert.ok(loc)
    assert.equal(loc.oracle_location, 'ORL_STETSON_MTY')
  })

  test('búsqueda es case-insensitive', () => {
    const loc = catalog.getLocationConfig('ARIAT_GDL', 'ariat')
    assert.ok(loc, 'Debe encontrar la location en mayúsculas')
    assert.equal(loc.store_name, 'Tienda Ariat GDL')
  })

  test('default brand: sin pasar brand resuelve a ariat', () => {
    const loc = catalog.getLocationConfig('ariat_gdl')
    assert.ok(loc)
    assert.equal(loc.oracle_location, 'ORL_ARIAT_GDL')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// getPaymentMethods
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog.getPaymentMethods — aislamiento por marca', () => {
  test('retorna los métodos de pago de ariat (no incluye los de stetson)', () => {
    const methods = catalog.getPaymentMethods('ariat')
    assert.equal(methods['1'], '01 - Efectivo')
    assert.equal(methods['4'], '04 - Tarjeta de Crédito')
    assert.equal(methods['28'], undefined)
  })

  test('retorna los métodos de pago de stetson (no incluye los de ariat)', () => {
    const methods = catalog.getPaymentMethods('stetson')
    assert.equal(methods['1'],  '01 - Efectivo Stetson')
    assert.equal(methods['28'], '28 - Débito Stetson')
    assert.equal(methods['4'],  undefined)
  })

  test('default brand: sin pasar brand retorna métodos de ariat', () => {
    const methods = catalog.getPaymentMethods()
    assert.equal(methods['1'], '01 - Efectivo')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// listLocations
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog.listLocations — aislamiento por marca', () => {
  test('lista solo los store_name de ariat', () => {
    const locs = catalog.listLocations('ariat')
    assert.ok(locs.includes('Tienda Ariat GDL'))
    assert.ok(!locs.includes('Tienda Stetson MTY'))
  })

  test('lista solo los store_name de stetson', () => {
    const locs = catalog.listLocations('stetson')
    assert.ok(locs.includes('Tienda Stetson MTY'))
    assert.ok(!locs.includes('Tienda Ariat GDL'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// listAllItems / listAllLocations / listAllPaymentMethods
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog.listAll* — aislamiento por marca', () => {
  test('listAllItems retorna solo items de la marca solicitada', () => {
    const ariatItems   = catalog.listAllItems('ariat')
    const stetsonItems = catalog.listAllItems('stetson')

    assert.equal(ariatItems.length, 3)   // ARIAT_SKU_001, ARIAT_SKU_002, 012345678901
    assert.equal(stetsonItems.length, 2) // ARIAT_SKU_001 (stetson), STETSON_ONLY
    assert.ok(ariatItems.every(i => i.brand === 'ariat'))
    assert.ok(stetsonItems.every(i => i.brand === 'stetson'))
  })

  test('listAllLocations retorna solo locations de la marca solicitada', () => {
    const ariatLocs   = catalog.listAllLocations('ariat')
    const stetsonLocs = catalog.listAllLocations('stetson')

    assert.equal(ariatLocs.length, 1)
    assert.equal(stetsonLocs.length, 1)
    assert.ok(ariatLocs.every(l => l.brand === 'ariat'))
    assert.ok(stetsonLocs.every(l => l.brand === 'stetson'))
  })

  test('listAllPaymentMethods retorna solo métodos de la marca solicitada', () => {
    const ariatPM   = catalog.listAllPaymentMethods('ariat')
    const stetsonPM = catalog.listAllPaymentMethods('stetson')

    assert.equal(ariatPM.length, 2)
    assert.equal(stetsonPM.length, 2)
    assert.ok(ariatPM.every(m => m.brand === 'ariat'))
    assert.ok(stetsonPM.every(m => m.brand === 'stetson'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// clearTable
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog.clearTable — scope por marca', () => {
  test('clearTable("items", "ariat") borra solo items de ariat', () => {
    catalog.clearTable('items', 'ariat')

    const probe = new DatabaseSync(DB_FILE)
    const ariatItems   = probe.prepare("SELECT * FROM catalog_items WHERE brand = 'ariat'").all()
    const stetsonItems = probe.prepare("SELECT * FROM catalog_items WHERE brand = 'stetson'").all()
    probe.close()

    assert.equal(ariatItems.length, 0,   'Items de ariat deben borrarse')
    assert.equal(stetsonItems.length, 2, 'Items de stetson deben mantenerse intactos')

    // Re-seed ariat para tests siguientes
    catalog.bulkUpsert('items', [
      { sku: 'ARIAT_SKU_001', internal_id: 'NS_ARIAT_001' },
      { sku: 'ARIAT_SKU_002', internal_id: 'NS_ARIAT_002' },
    ], 'ariat')
  })

  test('clearTable("payment_methods", "stetson") NO afecta a ariat', () => {
    catalog.clearTable('payment_methods', 'stetson')

    const probe = new DatabaseSync(DB_FILE)
    const ariatPM   = probe.prepare("SELECT * FROM catalog_payment_methods WHERE brand = 'ariat'").all()
    const stetsonPM = probe.prepare("SELECT * FROM catalog_payment_methods WHERE brand = 'stetson'").all()
    probe.close()

    assert.equal(stetsonPM.length, 0, 'Métodos de stetson deben borrarse')
    assert.equal(ariatPM.length, 2,   'Métodos de ariat deben mantenerse')

    // Re-seed stetson
    catalog.bulkUpsert('payment_methods', [
      { clave: '1', payment_type: '01 - Efectivo Stetson' },
    ], 'stetson')
  })

  test('clearTable("locations", "ariat") NO afecta a stetson', () => {
    catalog.clearTable('locations', 'ariat')

    const probe = new DatabaseSync(DB_FILE)
    const ariatLocs   = probe.prepare("SELECT * FROM catalog_locations WHERE brand = 'ariat'").all()
    const stetsonLocs = probe.prepare("SELECT * FROM catalog_locations WHERE brand = 'stetson'").all()
    probe.close()

    assert.equal(ariatLocs.length, 0)
    assert.equal(stetsonLocs.length, 1)

    // Re-seed ariat locations
    catalog.bulkUpsert('locations', [
      { store_name: 'Tienda Ariat GDL', oracle_location: 'ORL_ARIAT_GDL', rep_id: 'REP_ARIAT_1', shopify_location: 'ariat_gdl' },
    ], 'ariat')
  })

  test('clearTable con tabla desconocida lanza error', () => {
    assert.throws(
      () => catalog.clearTable('unknown_table', 'ariat'),
      (err) => {
        assert.ok(err.message.includes('Unknown table'))
        return true
      }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// bulkUpsert
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog.bulkUpsert — scope por marca', () => {
  test('bulkUpsert("locations") reemplaza solo las locations de la marca indicada', () => {
    catalog.bulkUpsert('locations', [
      { store_name: 'Tienda Ariat Nueva', oracle_location: 'ORL_NUEVA', rep_id: 'REP_NUEVA', shopify_location: 'ariat_nueva' },
    ], 'ariat')

    const probe = new DatabaseSync(DB_FILE)
    const ariatLocs   = probe.prepare("SELECT * FROM catalog_locations WHERE brand = 'ariat'").all()
    const stetsonLocs = probe.prepare("SELECT * FROM catalog_locations WHERE brand = 'stetson'").all()
    probe.close()

    assert.equal(ariatLocs.length, 1, 'Solo 1 location de ariat (reemplazó)')
    assert.equal(ariatLocs[0].store_name, 'Tienda Ariat Nueva')
    assert.equal(stetsonLocs.length, 1, 'stetson no fue afectado')
    assert.equal(stetsonLocs[0].store_name, 'Tienda Stetson MTY')
  })

  test('bulkUpsert("items") usa INSERT OR REPLACE (upsert por (brand, sku))', () => {
    catalog.bulkUpsert('items', [
      { sku: 'ARIAT_SKU_001', internal_id: 'NS_ARIAT_001_UPDATED' },
    ], 'ariat')

    const probe = new DatabaseSync(DB_FILE)
    const ariatItem   = probe.prepare("SELECT * FROM catalog_items WHERE brand='ariat'   AND sku='ARIAT_SKU_001'").get()
    const stetsonItem = probe.prepare("SELECT * FROM catalog_items WHERE brand='stetson' AND sku='ARIAT_SKU_001'").get()
    probe.close()

    assert.equal(ariatItem.internal_id,   'NS_ARIAT_001_UPDATED')
    assert.equal(stetsonItem.internal_id, 'NS_STETSON_001', 'stetson no debe verse afectado')
  })

  test('bulkUpsert normaliza SKU con sufijo .0 al insertar items', () => {
    catalog.bulkUpsert('items', [
      { sku: 'NEW_UPC_001.0', internal_id: 'NS_UPC_NEW' },
    ], 'ariat')

    // Debe estar guardado sin el sufijo .0
    const probe = new DatabaseSync(DB_FILE)
    const row = probe.prepare("SELECT * FROM catalog_items WHERE brand='ariat' AND sku='NEW_UPC_001'").get()
    probe.close()

    assert.ok(row, 'SKU normalizado debe existir en la DB')
    assert.equal(row.internal_id, 'NS_UPC_NEW')
    // Y debe ser buscable también sin sufijo
    assert.equal(catalog.getInternalId('NEW_UPC_001.0', 'ariat'), 'NS_UPC_NEW')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// bulkUpsert — conteos honestos (fix bug: 50k reportados, ~2k insertados)
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog.bulkUpsert — resumen de conteo honesto', () => {
  test('retorna la forma { received, skippedEmptySku, duplicatesCollapsed, suspiciousSku, inserted } incluso con rows vacío', () => {
    const summary = catalog.bulkUpsert('items', [], 'ariat')
    assert.deepEqual(summary, {
      received: 0, skippedEmptySku: 0, duplicatesCollapsed: 0, suspiciousSku: 0, inserted: 0,
    })
  })

  test('items: filas con SKU vacío se omiten y se cuentan en skippedEmptySku (no crean fila)', () => {
    catalog.clearTable('items', 'ariat')

    const summary = catalog.bulkUpsert('items', [
      { sku: 'BLANK_SKU_TEST_1', internal_id: 'NS_1' },
      { sku: '',  internal_id: 'NS_BLANK_1' },
      { sku: '',  internal_id: 'NS_BLANK_2' },
    ], 'ariat')

    assert.equal(summary.received, 3)
    assert.equal(summary.skippedEmptySku, 2)
    assert.equal(summary.duplicatesCollapsed, 0)
    assert.equal(summary.inserted, 1)

    const probe = new DatabaseSync(DB_FILE)
    const rows = probe.prepare("SELECT * FROM catalog_items WHERE brand='ariat'").all()
    probe.close()
    assert.equal(rows.length, 1, 'Solo debe existir la fila con SKU no vacío')
    assert.ok(rows.every(r => r.sku !== ''), 'Ninguna fila debe tener SKU vacío')

    // Re-seed para no afectar tests posteriores
    catalog.bulkUpsert('items', [
      { sku: 'ARIAT_SKU_001', internal_id: 'NS_ARIAT_001' },
      { sku: 'ARIAT_SKU_002', internal_id: 'NS_ARIAT_002' },
    ], 'ariat')
  })

  test('items: SKUs duplicados colapsan a una fila (last-wins) y se cuentan en duplicatesCollapsed', () => {
    catalog.clearTable('items', 'ariat')

    const summary = catalog.bulkUpsert('items', [
      { sku: 'DUP_SKU', internal_id: 'NS_FIRST' },
      { sku: 'DUP_SKU', internal_id: 'NS_SECOND' },
      { sku: 'DUP_SKU', internal_id: 'NS_LAST' },
    ], 'ariat')

    assert.equal(summary.received, 3)
    assert.equal(summary.skippedEmptySku, 0)
    assert.equal(summary.duplicatesCollapsed, 2)
    assert.equal(summary.inserted, 1)

    const probe = new DatabaseSync(DB_FILE)
    const row = probe.prepare("SELECT * FROM catalog_items WHERE brand='ariat' AND sku='DUP_SKU'").get()
    const count = probe.prepare("SELECT COUNT(*) as c FROM catalog_items WHERE brand='ariat'").get()
    probe.close()
    assert.equal(row.internal_id, 'NS_LAST', 'last-wins: debe quedar el último valor')
    assert.equal(count.c, 1)

    // Re-seed
    catalog.bulkUpsert('items', [
      { sku: 'ARIAT_SKU_001', internal_id: 'NS_ARIAT_001' },
      { sku: 'ARIAT_SKU_002', internal_id: 'NS_ARIAT_002' },
    ], 'ariat')
  })

  test('items: mezcla de 6 filas (2 vacías, 2 dup de un sku, 2 únicas) produce el resumen exacto', () => {
    catalog.clearTable('items', 'ariat')

    const summary = catalog.bulkUpsert('items', [
      { sku: '',            internal_id: 'NS_BLANK_A' },
      { sku: 'MIX_DUP',     internal_id: 'NS_MIX_1' },
      { sku: 'MIX_DUP',     internal_id: 'NS_MIX_2' },
      { sku: '',            internal_id: 'NS_BLANK_B' },
      { sku: 'MIX_UNIQUE_1', internal_id: 'NS_UNIQUE_1' },
      { sku: 'MIX_UNIQUE_2', internal_id: 'NS_UNIQUE_2' },
    ], 'ariat')

    assert.deepEqual(summary, {
      received: 6,
      skippedEmptySku: 2,
      duplicatesCollapsed: 1,
      suspiciousSku: 0,
      inserted: 3, // MIX_DUP (colapsado), MIX_UNIQUE_1, MIX_UNIQUE_2
    })

    const probe = new DatabaseSync(DB_FILE)
    const count = probe.prepare("SELECT COUNT(*) as c FROM catalog_items WHERE brand='ariat'").get()
    const dupRow = probe.prepare("SELECT * FROM catalog_items WHERE brand='ariat' AND sku='MIX_DUP'").get()
    probe.close()
    assert.equal(count.c, 3, 'La tabla debe tener exactamente 3 filas para ariat')
    assert.equal(dupRow.internal_id, 'NS_MIX_2', 'last-wins')

    // Re-seed
    catalog.bulkUpsert('items', [
      { sku: 'ARIAT_SKU_001', internal_id: 'NS_ARIAT_001' },
      { sku: 'ARIAT_SKU_002', internal_id: 'NS_ARIAT_002' },
    ], 'ariat')
  })

  test('payment_methods: clave vacía se omite y claves duplicadas colapsan (last-wins)', () => {
    catalog.clearTable('payment_methods', 'ariat')

    const summary = catalog.bulkUpsert('payment_methods', [
      { clave: '1', payment_type: '01 - Efectivo' },
      { clave: '',  payment_type: 'Debe omitirse' },
      { clave: '4', payment_type: '04 - Tarjeta Vieja' },
      { clave: '4', payment_type: '04 - Tarjeta de Crédito' },
    ], 'ariat')

    assert.equal(summary.received, 4)
    assert.equal(summary.skippedEmptySku, 1)
    assert.equal(summary.duplicatesCollapsed, 1)
    assert.equal(summary.inserted, 2)

    const probe = new DatabaseSync(DB_FILE)
    const rows = probe.prepare("SELECT * FROM catalog_payment_methods WHERE brand='ariat' ORDER BY clave").all()
    probe.close()
    assert.equal(rows.length, 2)
    assert.equal(rows.find(r => r.clave === '4').payment_type, '04 - Tarjeta de Crédito', 'last-wins')

    // Re-seed
    catalog.bulkUpsert('payment_methods', [
      { clave: '1', payment_type: '01 - Efectivo' },
      { clave: '4', payment_type: '04 - Tarjeta de Crédito' },
    ], 'ariat')
  })

  test('locations: no tiene colapso por PK; retorna forma uniforme con inserted = rows.length', () => {
    catalog.clearTable('locations', 'ariat')

    const summary = catalog.bulkUpsert('locations', [
      { store_name: 'Tienda A', oracle_location: 'ORL_A', rep_id: 'REP_A', shopify_location: 'loc_a' },
      { store_name: 'Tienda B', oracle_location: 'ORL_B', rep_id: 'REP_B', shopify_location: 'loc_b' },
    ], 'ariat')

    assert.deepEqual(summary, {
      received: 2, skippedEmptySku: 0, duplicatesCollapsed: 0, suspiciousSku: 0, inserted: 2,
    })

    // Re-seed
    catalog.bulkUpsert('locations', [
      { store_name: 'Tienda Ariat GDL', oracle_location: 'ORL_ARIAT_GDL', rep_id: 'REP_ARIAT_1', shopify_location: 'ariat_gdl' },
    ], 'ariat')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// bulkUpsert — detector de SKUs en notación científica (warn-only)
// ─────────────────────────────────────────────────────────────────────────────

describe('catalog.bulkUpsert — suspiciousSku (notación científica, warn-only)', () => {
  test('items: SKU en notación científica (p.ej. "7.5065E+12") se cuenta en suspiciousSku Y la fila se OMITE (no se inserta)', () => {
    catalog.clearTable('items', 'ariat')

    const summary = catalog.bulkUpsert('items', [
      { sku: '7.5065E+12', internal_id: 'NS_SCI_1' },
    ], 'ariat')

    assert.equal(summary.received, 1)
    assert.equal(summary.skippedEmptySku, 0)
    assert.equal(summary.suspiciousSku, 1, 'debe detectar el SKU en notación científica')
    assert.equal(summary.duplicatesCollapsed, 0)
    assert.equal(summary.inserted, 0, 'la fila sospechosa se omite, igual que un SKU vacío')

    const probe = new DatabaseSync(DB_FILE)
    const row = probe.prepare("SELECT * FROM catalog_items WHERE brand='ariat' AND sku='7.5065E+12'").get()
    const count = probe.prepare("SELECT COUNT(*) as c FROM catalog_items WHERE brand='ariat'").get()
    probe.close()
    assert.equal(row, undefined, 'la fila sospechosa NO debe existir en la tabla')
    assert.equal(count.c, 0)

    // Re-seed
    catalog.bulkUpsert('items', [
      { sku: 'ARIAT_SKU_001', internal_id: 'NS_ARIAT_001' },
      { sku: 'ARIAT_SKU_002', internal_id: 'NS_ARIAT_002' },
    ], 'ariat')
  })

  test('items: SKUs normales (guionados/alfanuméricos) NO disparan el detector → suspiciousSku === 0', () => {
    catalog.clearTable('items', 'ariat')

    const summary = catalog.bulkUpsert('items', [
      { sku: 'ARIAT-BOOT-001', internal_id: 'NS_A' },
      { sku: '012345678901',   internal_id: 'NS_B' },  // UPC normal, ya sin sufijo .0
      { sku: 'SKU_123',        internal_id: 'NS_C' },
    ], 'ariat')

    assert.equal(summary.suspiciousSku, 0)
    assert.equal(summary.inserted, 3)

    // Re-seed
    catalog.bulkUpsert('items', [
      { sku: 'ARIAT_SKU_001', internal_id: 'NS_ARIAT_001' },
      { sku: 'ARIAT_SKU_002', internal_id: 'NS_ARIAT_002' },
    ], 'ariat')
  })

  test('items: mezcla de blancos + notación científica + duplicados reales + únicos produce el resumen exacto', () => {
    catalog.clearTable('items', 'ariat')

    // 9 filas: 2 vacías, 2 en notación científica (mismo valor, para probar que
    // también se cuentan una vez por fila antes de omitirse, no colapsan entre sí
    // como "duplicatesCollapsed"), 2 duplicados reales de un SKU válido, 3 únicos.
    const summary = catalog.bulkUpsert('items', [
      { sku: '',            internal_id: 'NS_BLANK_A' },
      { sku: '',            internal_id: 'NS_BLANK_B' },
      { sku: '7.5065E+12',  internal_id: 'NS_SCI_A' },
      { sku: '8.1234E+11',  internal_id: 'NS_SCI_B' },
      { sku: 'REAL_DUP',    internal_id: 'NS_DUP_1' },
      { sku: 'REAL_DUP',    internal_id: 'NS_DUP_2' },
      { sku: 'UNIQUE_A',    internal_id: 'NS_UNIQUE_A' },
      { sku: 'UNIQUE_B',    internal_id: 'NS_UNIQUE_B' },
      { sku: 'UNIQUE_C',    internal_id: 'NS_UNIQUE_C' },
    ], 'ariat')

    assert.deepEqual(summary, {
      received: 9,
      skippedEmptySku: 2,
      suspiciousSku: 2,
      // received - skippedEmptySku - suspiciousSku = 5 filas restantes
      // (REAL_DUP x2, UNIQUE_A, UNIQUE_B, UNIQUE_C) → 4 claves distintas → 1 colapso
      duplicatesCollapsed: 1,
      inserted: 4, // REAL_DUP (colapsado a 1), UNIQUE_A, UNIQUE_B, UNIQUE_C
    })

    const probe = new DatabaseSync(DB_FILE)
    const count = probe.prepare("SELECT COUNT(*) as c FROM catalog_items WHERE brand='ariat'").get()
    const sciRows = probe.prepare("SELECT * FROM catalog_items WHERE brand='ariat' AND sku LIKE '%E+%'").all()
    const dupRow = probe.prepare("SELECT * FROM catalog_items WHERE brand='ariat' AND sku='REAL_DUP'").get()
    probe.close()
    assert.equal(count.c, 4, 'la tabla debe tener exactamente 4 filas (las sospechosas y vacías no se insertan)')
    assert.equal(sciRows.length, 0, 'ninguna fila en notación científica debe existir')
    assert.equal(dupRow.internal_id, 'NS_DUP_2', 'last-wins entre los duplicados reales')

    // Re-seed
    catalog.bulkUpsert('items', [
      { sku: 'ARIAT_SKU_001', internal_id: 'NS_ARIAT_001' },
      { sku: 'ARIAT_SKU_002', internal_id: 'NS_ARIAT_002' },
    ], 'ariat')
  })

  test('la forma del resumen incluye suspiciousSku para las tres tablas', () => {
    catalog.clearTable('items', 'ariat')
    catalog.clearTable('payment_methods', 'ariat')

    const itemsSummary = catalog.bulkUpsert('items', [
      { sku: 'SHAPE_CHECK', internal_id: 'NS_SHAPE' },
    ], 'ariat')
    assert.ok('suspiciousSku' in itemsSummary)
    assert.equal(itemsSummary.suspiciousSku, 0)

    const pmSummary = catalog.bulkUpsert('payment_methods', [
      { clave: '1', payment_type: '01 - Efectivo' },
    ], 'ariat')
    assert.ok('suspiciousSku' in pmSummary)
    assert.equal(pmSummary.suspiciousSku, 0)

    const locSummary = catalog.bulkUpsert('locations', [
      { store_name: 'Tienda Shape', oracle_location: 'ORL_SHAPE', rep_id: 'REP_SHAPE', shopify_location: 'shape' },
    ], 'ariat')
    assert.ok('suspiciousSku' in locSummary)
    assert.equal(locSummary.suspiciousSku, 0)

    // Re-seed para no afectar el resto de la suite
    catalog.bulkUpsert('items', [
      { sku: 'ARIAT_SKU_001', internal_id: 'NS_ARIAT_001' },
      { sku: 'ARIAT_SKU_002', internal_id: 'NS_ARIAT_002' },
    ], 'ariat')
    catalog.bulkUpsert('payment_methods', [
      { clave: '1', payment_type: '01 - Efectivo' },
      { clave: '4', payment_type: '04 - Tarjeta de Crédito' },
    ], 'ariat')
    catalog.bulkUpsert('locations', [
      { store_name: 'Tienda Ariat GDL', oracle_location: 'ORL_ARIAT_GDL', rep_id: 'REP_ARIAT_1', shopify_location: 'ariat_gdl' },
    ], 'ariat')
  })
})
