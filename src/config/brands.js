import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

// Resuelve la ruta de config/brands.json relativa a la raíz del proyecto,
// sin depender del cwd desde donde se lanza el proceso.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG_PATH  = resolve(PROJECT_ROOT, 'config', 'brands.json')

// ─── Carga y validación al importar el módulo (fail-fast) ────────────────────

let _raw
try {
  _raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
} catch (err) {
  throw new Error(`[brands] No se pudo leer config/brands.json: ${err.message}`)
}

if (!_raw.default) {
  throw new Error('[brands] config/brands.json: falta el campo "default"')
}
if (!_raw.brands || typeof _raw.brands !== 'object') {
  throw new Error('[brands] config/brands.json: falta el campo "brands"')
}
if (!(_raw.default in _raw.brands)) {
  throw new Error(
    `[brands] config/brands.json: "default" apunta a "${_raw.default}" que no existe en "brands"`
  )
}

for (const [key, brand] of Object.entries(_raw.brands)) {
  const prefix = `[brands] config/brands.json → brands.${key}`
  if (!brand.label) {
    throw new Error(`${prefix}: falta "label"`)
  }
  if (!brand.shopify?.store_env) {
    throw new Error(`${prefix}: falta "shopify.store_env"`)
  }
  if (brand.shopify.auth !== 'oauth') {
    throw new Error(`${prefix}: shopify.auth inválido "${brand.shopify.auth}" — valor permitido: "oauth"`)
  }
  if (!brand.shopify.client_id_env) {
    throw new Error(`${prefix}: auth "oauth" requiere "shopify.client_id_env"`)
  }
  if (!brand.shopify.client_secret_env) {
    throw new Error(`${prefix}: auth "oauth" requiere "shopify.client_secret_env"`)
  }
  if (typeof brand.enabled !== 'boolean') {
    throw new Error(`${prefix}: "enabled" debe ser boolean`)
  }
}

// ─── Exports públicos ────────────────────────────────────────────────────────

/** Devuelve la clave de la marca default (string). */
export function getDefaultBrand() {
  return _raw.default
}

/**
 * Lista TODAS las marcas con su key, label y estado enabled.
 * Uso interno / admin.
 * @returns {{ key: string, label: string, enabled: boolean }[]}
 */
export function listBrands() {
  return Object.entries(_raw.brands).map(([key, brand]) => ({
    key,
    label:   brand.label,
    enabled: brand.enabled,
  }))
}

/**
 * Lista solo las marcas habilitadas.
 * Uso: alimentar selectores en la UI.
 * @returns {{ key: string, label: string }[]}
 */
export function listEnabledBrands() {
  return Object.entries(_raw.brands)
    .filter(([, brand]) => brand.enabled)
    .map(([key, brand]) => ({ key, label: brand.label }))
}

/**
 * Resuelve la Serie de Facturama de una marca (para filtrar las facturas GLOBALES
 * por marca, ya que todas comparten el RFC receptor "público en general").
 * Independiente de las credenciales de Shopify: NO requiere las env vars de Shopify,
 * por lo que el endpoint de UUIDs puede usarlo sin tenerlas configuradas.
 * @param {string|null|undefined} brandKey
 * @returns {string|undefined} la Serie, o undefined si la marca no define
 *   facturama_serie_env o la env var no está seteada (→ sin filtro por serie).
 */
export function getFacturamaSerie(brandKey) {
  const key = brandKey ?? _raw.default
  const brand = _raw.brands[key]
  if (!brand?.facturama_serie_env) return undefined
  const val = process.env[brand.facturama_serie_env]
  return val ? String(val).trim() : undefined
}

/**
 * Resuelve la configuración operativa de una marca y sus credenciales Shopify.
 * Retorna { key, label, shopify: { store, auth: 'oauth', clientId, clientSecret } }.
 *
 * @param {string|null|undefined} brandKey Clave de la marca; null/undefined usa el default.
 * @throws Si la marca no existe, está deshabilitada o le faltan env vars.
 */
export function getBrandConfig(brandKey) {
  const key = brandKey ?? _raw.default

  const brand = _raw.brands[key]
  if (!brand) {
    throw new Error(`[brands] Marca desconocida: "${key}"`)
  }
  if (!brand.enabled) {
    throw new Error(
      `[brands] La marca "${key}" está deshabilitada. Configura sus credenciales y actívala en config/brands.json`
    )
  }

  const store = process.env[brand.shopify.store_env]
  if (!store) {
    throw new Error(
      `[brands] Falta la variable de entorno ${brand.shopify.store_env} requerida por la marca "${key}"`
    )
  }

  const clientId = process.env[brand.shopify.client_id_env]
  if (!clientId) {
    throw new Error(
      `[brands] Falta la variable de entorno ${brand.shopify.client_id_env} requerida por la marca "${key}"`
    )
  }

  const clientSecret = process.env[brand.shopify.client_secret_env]
  if (!clientSecret) {
    throw new Error(
      `[brands] Falta la variable de entorno ${brand.shopify.client_secret_env} requerida por la marca "${key}"`
    )
  }

  return {
    key,
    label: brand.label,
    shopify: { store, auth: 'oauth', clientId, clientSecret },
  }
}
