/**
 * test/schema.legacy.test.js
 *
 * Test de migración real de DB "vieja" (pre-Etapa-4) mediante el módulo REAL schema.js.
 *
 * Estrategia:
 *   Este archivo corre en su propio proceso hijo (node:test lo garantiza), así que
 *   puede manipular DATABASE_PATH y el singleton de client.js de forma completamente
 *   aislada.
 *
 *   Orden de operaciones:
 *     1. Crear DB legacy (sin columna brand) con DatabaseSync crudo sobre DB_FILE.
 *     2. Cerrarla.
 *     3. Fijar process.env.DATABASE_PATH = DB_FILE.
 *     4. Importar src/db/schema.js con import() dinámico → el singleton se abre sobre
 *        la DB legacy ya poblada.
 *     5. Llamar runMigrations() → la migración real se aplica.
 *     6. Verificar el estado resultante con un DatabaseSync auxiliar.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// ── Archivo temporal único para este proceso ─────────────────────────────────
const DB_FILE = join(tmpdir(), `mb-schema-legacy-real-${process.pid}-${Date.now()}.db`)

// ── Paso 1 — construir DB legacy ANTES de importar ningún módulo de producción
{
  const legacy = new DatabaseSync(DB_FILE)
  legacy.exec('PRAGMA journal_mode = WAL')
  legacy.exec(`
    CREATE TABLE catalog_items (
      sku         TEXT NOT NULL PRIMARY KEY,
      internal_id TEXT NOT NULL
    );
    CREATE TABLE catalog_locations (
      store_name       TEXT NOT NULL,
      oracle_location  TEXT NOT NULL,
      rep_id           TEXT NOT NULL,
      shopify_location TEXT NOT NULL
    );
    CREATE TABLE catalog_payment_methods (
      clave        TEXT NOT NULL PRIMARY KEY,
      payment_type TEXT NOT NULL
    );
  `)
  legacy.prepare("INSERT INTO catalog_items (sku, internal_id) VALUES ('SKU_REAL_LEGACY', 'NS_REAL_001')").run()
  legacy.prepare("INSERT INTO catalog_payment_methods (clave, payment_type) VALUES ('1', 'Efectivo Real')").run()
  legacy.prepare("INSERT INTO catalog_locations (store_name, oracle_location, rep_id, shopify_location) VALUES ('Tienda Real', 'ORL_REAL', 'REP_REAL_1', 'tienda_real')").run()
  legacy.close()
}

// ── Paso 2 — fijar DATABASE_PATH ANTES de cualquier import dinámico ──────────
process.env.DATABASE_PATH = DB_FILE

// ── Limpieza al terminar ──────────────────────────────────────────────────────
// Cerramos el singleton antes de borrar el archivo (necesario en Windows)
after(async () => {
  try {
    const { default: db } = await import('../src/db/client.js')
    db.close()
  } catch {}
  rmSync(DB_FILE,            { force: true })
  rmSync(DB_FILE + '-wal',   { force: true })
  rmSync(DB_FILE + '-shm',   { force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// Tests — importan el módulo REAL una sola vez en before()
// ─────────────────────────────────────────────────────────────────────────────

describe('schema.js REAL — migración de DB vieja (sin columna brand)', () => {
  let runMigrations

  before(async () => {
    // Import dinámico: client.js se abre sobre DB_FILE (ya con las tablas legacy)
    ;({ runMigrations } = await import('../src/db/schema.js'))
    // Ejecutar la migración real
    runMigrations()
  })

  test('catalog_items tiene columna brand después de la migración', () => {
    const probe = new DatabaseSync(DB_FILE)
    const cols = probe.prepare('PRAGMA table_info(catalog_items)').all()
    probe.close()
    assert.ok(cols.some(c => c.name === 'brand'), 'brand debe existir tras migrar')
  })

  test('datos legacy de catalog_items quedan con brand=ariat', () => {
    const probe = new DatabaseSync(DB_FILE)
    const rows = probe.prepare('SELECT * FROM catalog_items').all()
    probe.close()

    assert.equal(rows.length, 1)
    assert.equal(rows[0].brand, 'ariat')
    assert.equal(rows[0].sku, 'SKU_REAL_LEGACY')
    assert.equal(rows[0].internal_id, 'NS_REAL_001')
  })

  test('catalog_locations tiene columna brand después de la migración', () => {
    const probe = new DatabaseSync(DB_FILE)
    const cols = probe.prepare('PRAGMA table_info(catalog_locations)').all()
    probe.close()
    assert.ok(cols.some(c => c.name === 'brand'), 'brand debe existir tras migrar')
  })

  test('datos legacy de catalog_locations quedan con brand=ariat', () => {
    const probe = new DatabaseSync(DB_FILE)
    const rows = probe.prepare('SELECT * FROM catalog_locations').all()
    probe.close()

    assert.equal(rows.length, 1)
    assert.equal(rows[0].brand, 'ariat')
    assert.equal(rows[0].store_name, 'Tienda Real')
  })

  test('catalog_payment_methods tiene columna brand después de la migración', () => {
    const probe = new DatabaseSync(DB_FILE)
    const cols = probe.prepare('PRAGMA table_info(catalog_payment_methods)').all()
    probe.close()
    assert.ok(cols.some(c => c.name === 'brand'), 'brand debe existir tras migrar')
  })

  test('datos legacy de catalog_payment_methods quedan con brand=ariat', () => {
    const probe = new DatabaseSync(DB_FILE)
    const rows = probe.prepare('SELECT * FROM catalog_payment_methods').all()
    probe.close()

    assert.equal(rows.length, 1)
    assert.equal(rows[0].brand, 'ariat')
    assert.equal(rows[0].clave, '1')
    assert.equal(rows[0].payment_type, 'Efectivo Real')
  })

  test('runMigrations() es idempotente tras la migración (segunda llamada no falla)', () => {
    assert.doesNotThrow(() => runMigrations())
  })

  test('después de migrar se pueden insertar datos de dos marcas con el mismo SKU', () => {
    const probe = new DatabaseSync(DB_FILE)
    probe.prepare("INSERT OR REPLACE INTO catalog_items (brand, sku, internal_id) VALUES ('ariat',   'SHARED_SKU', 'NS_A')").run()
    probe.prepare("INSERT OR REPLACE INTO catalog_items (brand, sku, internal_id) VALUES ('stetson', 'SHARED_SKU', 'NS_S')").run()

    const ariat   = probe.prepare("SELECT * FROM catalog_items WHERE brand='ariat'   AND sku='SHARED_SKU'").get()
    const stetson = probe.prepare("SELECT * FROM catalog_items WHERE brand='stetson' AND sku='SHARED_SKU'").get()
    probe.close()

    assert.equal(ariat.internal_id,   'NS_A')
    assert.equal(stetson.internal_id, 'NS_S')
  })
})
