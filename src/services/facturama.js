// Singleton lazy: evita recomputar el authHeader (Buffer+base64) en cada llamada.
// Las env vars son inmutables en producción, por lo que este caché es seguro.
let _config = undefined

function getConfig() {
  if (_config !== undefined) return _config
  const user    = process.env.FACTURAMA_USER
  const pass    = process.env.FACTURAMA_PASS
  const baseUrl = process.env.FACTURAMA_BASE_URL
  if (!user || !pass || !baseUrl) {
    _config = null
    return null
  }
  _config = {
    baseUrl,
    authHeader: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
  }
  return _config
}

export function isFacturamaConfigured() {
  return getConfig() !== null
}

function toFacturamaDate(iso) {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

function parseFacturamaDate(dateStr) {
  // Producción: "2026-05-31T21:32:00" → "2026-05-31"
  if (dateStr.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return dateStr.slice(0, 10)
  }
  // Sandbox: "DD/MM/YYYY HH:MM:SS" → "YYYY-MM-DD"
  const [datePart] = dateStr.split(' ')
  const [d, m, y] = datePart.split('/')
  return `${y}-${m}-${d}`
}

// RFC genérico "público en general" — identifica las facturas GLOBALES (corte de caja diario).
// Las facturas de clientes individuales traen su propio RFC y se descartan.
const GLOBAL_RFC = 'XAXX010101000'

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
}

// La fecha real de la venta vive en Observations, NO en Date (emisión).
// Formato típico: "01/junio/2026". Tolerante a separadores (/ - . espacio),
// día sin cero a la izquierda, mes por nombre (con/ sin acento) o numérico.
// Devuelve "YYYY-MM-DD" o null si no se puede parsear.
function parseObservacionesDate(obs) {
  if (!obs || typeof obs !== 'string') return null
  const m = obs.trim().toLowerCase()
    .match(/(\d{1,2})\s*[\/\-. ]\s*([a-záéíóúñ]+|\d{1,2})\s*[\/\-. ]\s*(\d{4})/)
  if (!m) return null
  const day = m[1].padStart(2, '0')
  let month
  if (/^\d+$/.test(m[2])) {
    month = m[2].padStart(2, '0')
  } else {
    const norm = m[2].normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    const num = MESES[norm]
    if (!num) return null
    month = String(num).padStart(2, '0')
  }
  return `${m[3]}-${month}-${day}`
}

async function request(baseUrl, authHeader, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  })
  const ct   = res.headers.get('content-type') ?? ''
  const data = ct.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    const msg = typeof data === 'object' && data !== null
      ? (data.message ?? data.Message ?? JSON.stringify(data))
      : String(data) || `HTTP ${res.status}`
    const err = new Error(msg)
    err.statusCode = res.status
    throw err
  }
  return data
}

const PAGE_SIZE = 10   // la API de Facturama devuelve 10 CFDIs por página
const MAX_PAGES = 100  // tope de seguridad (1000 CFDIs por consulta)

export async function listarCFDIs(params = {}) {
  const cfg = getConfig()
  if (!cfg) throw new Error('Facturama no configurado')
  // Query string manual — URLSearchParams encodifica las / de DD/MM/YYYY y Facturama las ignora
  let base = '/cfdi?type=issued'
  if (params.fechaInicio) base += `&dateStart=${toFacturamaDate(params.fechaInicio)}`
  if (params.fechaFin)   base += `&dateEnd=${toFacturamaDate(params.fechaFin)}`
  if (params.status)     base += `&status=${encodeURIComponent(params.status)}`

  // La API pagina los resultados (10 por página, base 0) — recorrer páginas hasta agotar
  const all = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await request(cfg.baseUrl, cfg.authHeader, `${base}&page=${page}`)
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    if (batch.length < PAGE_SIZE) break
  }
  return all
}

// Detalle de un CFDI por UUID — el listado NO trae Observations, solo el detalle.
export async function obtenerCFDI(uuid) {
  const cfg = getConfig()
  if (!cfg) throw new Error('Facturama no configurado')
  return request(cfg.baseUrl, cfg.authHeader, `/cfdi/${uuid}`)
}

function hoyISO() {
  return new Date().toISOString().slice(0, 10)
}

// Tamaño de batch para las llamadas paralelas al detalle de cada CFDI global.
const DETAIL_BATCH_SIZE = 5

// Devuelve un mapa { "YYYY-MM-DD": "UUID" } de la FACTURA GLOBAL de cada fecha de venta
// dentro del rango [dateFrom, dateTo].
//
// Sutilezas del negocio (confirmadas contra la API de producción):
//  - La fecha de venta vive en Observations ("01/junio/2026"), NO en Date (emisión).
//  - Las globales se emiten DESPUÉS de la venta (a veces días después): la del 1-jun
//    puede emitirse el 8-jun. Por eso la ventana de emisión se amplía hasta HOY.
//  - Solo cuentan las globales (Rfc == XAXX010101000); las facturas de clientes se descartan.
//  - Si un detalle falla (rejected), se omite esa global sin bloquear las demás.
//  - Primera global que mapea a una fecha gana si hay duplicados.
export async function getUUIDsForRange(dateFrom, dateTo) {
  const cfg = getConfig()
  if (!cfg) return {}  // Facturama no configurado — el caller recibe mapa vacío

  // Ventana de emisión amplia: desde la primera fecha de venta hasta hoy (no se puede
  // emitir en el futuro). Captura globales emitidas con retraso respecto a la venta.
  const emisHasta = dateTo > hoyISO() ? dateTo : hoyISO()
  const cfdis = await listarCFDIs({ fechaInicio: dateFrom, fechaFin: emisHasta, status: 'active' })

  // Filtrar a globales ANTES de pedir detalle (minimiza llamadas a la API).
  const globales = cfdis.filter(c => (c.Rfc ?? c.Receiver?.Rfc) === GLOBAL_RFC)

  // Extraer UUIDs válidos de las globales
  const uuidEntries = globales
    .map(g => g.Uuid ?? g.Complement?.TaxStamp?.Uuid ?? null)
    .filter(Boolean)

  // Obtener detalles en batches paralelos de DETAIL_BATCH_SIZE
  const map = {}
  for (let i = 0; i < uuidEntries.length; i += DETAIL_BATCH_SIZE) {
    const batchUuids = uuidEntries.slice(i, i + DETAIL_BATCH_SIZE)
    const results = await Promise.allSettled(batchUuids.map(uuid => obtenerCFDI(uuid)))

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'rejected') continue  // detalle fallido — se omite

      const det = results[j].value
      const fechaVenta = parseObservacionesDate(det.Observations)
      if (!fechaVenta) continue                       // Observations vacío o ilegible
      if (fechaVenta < dateFrom || fechaVenta > dateTo) continue // fuera del rango pedido

      const uuid = batchUuids[j]
      if (!map[fechaVenta]) map[fechaVenta] = uuid    // primera global gana si hay duplicados
    }
  }

  return map
}
