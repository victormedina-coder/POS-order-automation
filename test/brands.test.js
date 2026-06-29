/**
 * test/brands.test.js
 *
 * Tests para src/config/brands.js
 *
 * Estrategia:
 *   - brands.js lee config/brands.json en tiempo de importación (fail-fast).
 *   - getBrandConfig() lee process.env en CADA llamada → es testeable sin re-importar.
 *   - Guardamos/restauramos las variables de entorno por test con beforeEach/afterEach.
 *   - La marca "western brothers" está habilitada en brands.json, por lo que no podemos
 *     testear "marca deshabilitada" sin modificar el JSON. Se usa una técnica alternativa:
 *     llamar con una clave que no existe en brands.json (marca desconocida) para probar
 *     el error de "desconocida", y documentamos el caso "deshabilitada" como pendiente.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// Importamos una única vez — brands.js carga brands.json al importar.
import {
  getBrandConfig,
  listBrands,
  listEnabledBrands,
  getDefaultBrand,
} from '../src/config/brands.js'

// ─── Snapshot de env vars para restaurar después de cada test ────────────────

let envSnapshot

beforeEach(() => {
  envSnapshot = { ...process.env }
})

afterEach(() => {
  // Restaurar env al estado previo al test
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key]
    }
  }
  for (const [key, val] of Object.entries(envSnapshot)) {
    process.env[key] = val
  }
})

// ─── Helpers para setear credenciales de marcas ───────────────────────────────

function setAriatEnv() {
  process.env.ARIAT_SHOPIFY_STORE        = 'ariat.myshopify.com'
  process.env.ARIAT_SHOPIFY_ACCESS_TOKEN = 'shpat_test_token'
}

function setStetsonEnv() {
  process.env.STETSON_SHOPIFY_STORE         = 'stetson.myshopify.com'
  process.env.STETSON_SHOPIFY_CLIENT_ID     = 'client_id_stetson'
  process.env.STETSON_SHOPIFY_CLIENT_SECRET = 'client_secret_stetson'
}

function setWesternBrothersEnv() {
  process.env.WB_SHOPIFY_STORE         = 'wb.myshopify.com'
  process.env.WB_SHOPIFY_CLIENT_ID     = 'client_id_wb'
  process.env.WB_SHOPIFY_CLIENT_SECRET = 'client_secret_wb'
}

// ─── Pruebas ──────────────────────────────────────────────────────────────────

describe('brands.js — getDefaultBrand', () => {
  test('retorna "ariat" (el valor de config/brands.json)', () => {
    assert.equal(getDefaultBrand(), 'ariat')
  })
})

describe('brands.js — listBrands / listEnabledBrands', () => {
  test('listBrands() retorna TODAS las marcas con key, label y enabled', () => {
    const brands = listBrands()
    assert.ok(Array.isArray(brands))
    // Las tres marcas del brands.json están presentes
    const keys = brands.map(b => b.key)
    assert.ok(keys.includes('ariat'))
    assert.ok(keys.includes('stetson'))
    // Cada elemento tiene la shape correcta
    for (const b of brands) {
      assert.ok('key' in b)
      assert.ok('label' in b)
      assert.ok('enabled' in b)
      assert.equal(typeof b.enabled, 'boolean')
    }
  })

  test('listEnabledBrands() devuelve solo las marcas con enabled=true', () => {
    const enabled = listEnabledBrands()
    const all = listBrands()
    const enabledAll = all.filter(b => b.enabled)
    assert.equal(enabled.length, enabledAll.length)
    for (const b of enabled) {
      assert.ok('key' in b)
      assert.ok('label' in b)
      // NO debe tener "enabled" — solo key y label
      assert.ok(!('enabled' in b))
    }
  })
})

describe('brands.js — getBrandConfig — marca desconocida', () => {
  test('lanza con mensaje "[brands]" para marca desconocida', () => {
    assert.throws(
      () => getBrandConfig('marca_que_no_existe_xyz'),
      (err) => {
        assert.ok(err.message.includes('[brands]'), `mensaje inesperado: ${err.message}`)
        assert.ok(err.message.includes('marca_que_no_existe_xyz'))
        return true
      }
    )
  })
})

describe('brands.js — getBrandConfig — null/undefined → default (ariat)', () => {
  test('null resuelve al default "ariat" si las env vars existen', () => {
    setAriatEnv()
    const cfg = getBrandConfig(null)
    assert.equal(cfg.key, 'ariat')
    assert.equal(cfg.shopify.auth, 'static')
    assert.equal(cfg.shopify.store, 'ariat.myshopify.com')
    assert.equal(cfg.shopify.accessToken, 'shpat_test_token')
  })

  test('undefined resuelve al default "ariat" si las env vars existen', () => {
    setAriatEnv()
    const cfg = getBrandConfig(undefined)
    assert.equal(cfg.key, 'ariat')
  })
})

describe('brands.js — getBrandConfig — shape para auth "static" (ariat)', () => {
  test('retorna { key, label, shopify: { store, auth, accessToken } }', () => {
    setAriatEnv()
    const cfg = getBrandConfig('ariat')

    assert.equal(cfg.key, 'ariat')
    assert.equal(cfg.label, 'Ariat')
    assert.equal(cfg.shopify.store, 'ariat.myshopify.com')
    assert.equal(cfg.shopify.auth, 'static')
    assert.equal(cfg.shopify.accessToken, 'shpat_test_token')
    // En modo static NO debe exponer clientId / clientSecret
    assert.equal(cfg.shopify.clientId, undefined)
    assert.equal(cfg.shopify.clientSecret, undefined)
  })
})

describe('brands.js — getBrandConfig — shape para auth "oauth" (stetson)', () => {
  test('retorna { key, label, shopify: { store, auth, clientId, clientSecret } }', () => {
    setStetsonEnv()
    const cfg = getBrandConfig('stetson')

    assert.equal(cfg.key, 'stetson')
    assert.equal(cfg.label, 'Stetson')
    assert.equal(cfg.shopify.store, 'stetson.myshopify.com')
    assert.equal(cfg.shopify.auth, 'oauth')
    assert.equal(cfg.shopify.clientId, 'client_id_stetson')
    assert.equal(cfg.shopify.clientSecret, 'client_secret_stetson')
    // En modo oauth NO debe exponer accessToken
    assert.equal(cfg.shopify.accessToken, undefined)
  })
})

describe('brands.js — getBrandConfig — falta env var STORE', () => {
  test('lanza con el nombre de la var faltante (ARIAT_SHOPIFY_STORE)', () => {
    // No seteamos ARIAT_SHOPIFY_STORE
    delete process.env.ARIAT_SHOPIFY_STORE
    delete process.env.SHOPIFY_STORE // también aseguramos que la legacy no esté
    process.env.ARIAT_SHOPIFY_ACCESS_TOKEN = 'shpat_token'

    assert.throws(
      () => getBrandConfig('ariat'),
      (err) => {
        assert.ok(err.message.includes('ARIAT_SHOPIFY_STORE'), `mensaje: ${err.message}`)
        return true
      }
    )
  })

  test('lanza con el nombre de la var faltante (STETSON_SHOPIFY_STORE)', () => {
    delete process.env.STETSON_SHOPIFY_STORE
    process.env.STETSON_SHOPIFY_CLIENT_ID     = 'id'
    process.env.STETSON_SHOPIFY_CLIENT_SECRET = 'secret'

    assert.throws(
      () => getBrandConfig('stetson'),
      (err) => {
        assert.ok(err.message.includes('STETSON_SHOPIFY_STORE'), `mensaje: ${err.message}`)
        return true
      }
    )
  })
})

describe('brands.js — getBrandConfig — falta env var ACCESS_TOKEN (static)', () => {
  test('lanza con ARIAT_SHOPIFY_ACCESS_TOKEN cuando falta el token', () => {
    process.env.ARIAT_SHOPIFY_STORE = 'ariat.myshopify.com'
    delete process.env.ARIAT_SHOPIFY_ACCESS_TOKEN
    delete process.env.SHOPIFY_ACCESS_TOKEN

    assert.throws(
      () => getBrandConfig('ariat'),
      (err) => {
        assert.ok(err.message.includes('ARIAT_SHOPIFY_ACCESS_TOKEN'), `mensaje: ${err.message}`)
        return true
      }
    )
  })
})

describe('brands.js — getBrandConfig — falta env var CLIENT_ID (oauth)', () => {
  test('lanza con STETSON_SHOPIFY_CLIENT_ID cuando falta', () => {
    process.env.STETSON_SHOPIFY_STORE         = 'stetson.myshopify.com'
    delete process.env.STETSON_SHOPIFY_CLIENT_ID
    process.env.STETSON_SHOPIFY_CLIENT_SECRET = 'secret'

    assert.throws(
      () => getBrandConfig('stetson'),
      (err) => {
        assert.ok(err.message.includes('STETSON_SHOPIFY_CLIENT_ID'), `mensaje: ${err.message}`)
        return true
      }
    )
  })
})

describe('brands.js — getBrandConfig — falta env var CLIENT_SECRET (oauth)', () => {
  test('lanza con STETSON_SHOPIFY_CLIENT_SECRET cuando falta', () => {
    process.env.STETSON_SHOPIFY_STORE     = 'stetson.myshopify.com'
    process.env.STETSON_SHOPIFY_CLIENT_ID = 'client_id'
    delete process.env.STETSON_SHOPIFY_CLIENT_SECRET

    assert.throws(
      () => getBrandConfig('stetson'),
      (err) => {
        assert.ok(err.message.includes('STETSON_SHOPIFY_CLIENT_SECRET'), `mensaje: ${err.message}`)
        return true
      }
    )
  })
})

describe('brands.js — getBrandConfig — fallback legacy (store)', () => {
  test('usa SHOPIFY_STORE (legacy) si ARIAT_SHOPIFY_STORE no está definida', () => {
    delete process.env.ARIAT_SHOPIFY_STORE
    process.env.SHOPIFY_STORE              = 'ariat-legacy.myshopify.com'
    process.env.ARIAT_SHOPIFY_ACCESS_TOKEN = 'shpat_token'

    const cfg = getBrandConfig('ariat')
    assert.equal(cfg.shopify.store, 'ariat-legacy.myshopify.com')
  })
})

describe('brands.js — getBrandConfig — fallback legacy (access_token)', () => {
  test('usa SHOPIFY_ACCESS_TOKEN (legacy) si ARIAT_SHOPIFY_ACCESS_TOKEN no está', () => {
    process.env.ARIAT_SHOPIFY_STORE   = 'ariat.myshopify.com'
    delete process.env.ARIAT_SHOPIFY_ACCESS_TOKEN
    process.env.SHOPIFY_ACCESS_TOKEN  = 'shpat_legacy_token'

    const cfg = getBrandConfig('ariat')
    assert.equal(cfg.shopify.accessToken, 'shpat_legacy_token')
  })
})

// ─── CASO PENDIENTE ──────────────────────────────────────────────────────────
// "Marca deshabilitada lanza con prefijo [brands]"
//
// MOTIVO: Todas las marcas en brands.json tienen enabled:true.
// Para testear este caso habría que:
//   (a) modificar brands.json temporalmente (destructivo, afecta módulo singleton), o
//   (b) añadir una marca dummy "test_disabled" al brands.json con enabled:false.
//
// La opción (b) contamina el config de producción. La opción (a) no es safe
// ya que brands.json se lee en tiempo de import (módulo cacheado por Node).
//
// PENDIENTE: Añadir una marca "test_disabled" con enabled:false en brands.json
// exclusivamente para el entorno de test, o refactorizar brands.js para
// aceptar una ruta de config inyectable.
