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
