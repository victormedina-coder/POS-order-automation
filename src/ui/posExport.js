const pad = n => String(n).padStart(2, '0')
const now = new Date()
const TODAY_STR = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`

const MONTHS_ES    = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre']
const MONTHS_SHORT = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']

// ════════════════════════════════════════════════════════
// CLOSE ALL POPUPS (shared)
// ════════════════════════════════════════════════════════
function closeAllPopups() {
  document.querySelectorAll('.custom-select.open, .date-picker.open')
    .forEach(el => el.classList.remove('open'))
}
document.addEventListener('click', e => {
  if (!e.target.closest('.custom-select, .date-picker')) closeAllPopups()
})

// ════════════════════════════════════════════════════════
// CUSTOM SELECT
// ════════════════════════════════════════════════════════
function csInit(id) {
  const el      = document.getElementById(id)
  const trigger = el.querySelector('.cs-trigger')
  const list    = el.querySelector('.cs-list')

  trigger.addEventListener('click', e => {
    e.stopPropagation()
    const wasOpen = el.classList.contains('open')
    closeAllPopups()
    if (!wasOpen) el.classList.add('open')
  })

  list.addEventListener('click', e => {
    const opt = e.target.closest('.cs-option')
    if (!opt) return
    csSelect(id, opt.dataset.val)
  })
}

function csSetOptions(id, options) {
  const list = document.querySelector(`#${id} .cs-list`)
  list.innerHTML = options.map(opt => `
    <div class="cs-option" data-val="${opt}">
      <span class="cs-check">✓</span>
      <span>${opt}</span>
    </div>
  `).join('')
  if (options.length) csSelect(id, options[0], false)
}

function csSelect(id, value, close = true) {
  document.querySelector(`#${id} .cs-value`).textContent = value
  document.querySelectorAll(`#${id} .cs-option`).forEach(opt =>
    opt.classList.toggle('selected', opt.dataset.val === value)
  )
  // sync hidden input (cs-store → store)
  const hiddenId = id.replace('cs-', '')
  const hidden = document.getElementById(hiddenId)
  if (hidden) hidden.value = value
  if (close) document.getElementById(id).classList.remove('open')
}

// ════════════════════════════════════════════════════════
// CUSTOM DATE PICKER
// ════════════════════════════════════════════════════════
const dpState = {}

function dpInit(id, defaultDate) {
  const [y, m] = defaultDate.split('-').map(Number)
  dpState[id] = { year: y, month: m - 1, selected: defaultDate }

  const el = document.getElementById(id)

  el.querySelector('.dp-trigger').addEventListener('click', e => {
    e.stopPropagation()
    const wasOpen = el.classList.contains('open')
    closeAllPopups()
    if (!wasOpen) el.classList.add('open')
  })

  el.querySelector('.dp-prev').addEventListener('click', e => {
    e.stopPropagation()
    dpChangeMonth(id, -1)
  })
  el.querySelector('.dp-next').addEventListener('click', e => {
    e.stopPropagation()
    dpChangeMonth(id, 1)
  })

  el.querySelector('.dp-grid').addEventListener('click', e => {
    e.stopPropagation()
    const cell = e.target.closest('.dp-cell:not(.dp-empty)')
    if (cell) dpSelect(id, cell.dataset.date)
  })

  dpSetDisplay(id, defaultDate)
  dpRender(id)
}

function dpSetDisplay(id, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  document.querySelector(`#${id} .dp-value`).textContent =
    `${pad(d)} ${MONTHS_SHORT[m-1]} ${y}`
  // sync hidden input (dp-from → date-from, dp-to → date-to)
  const hiddenId = id.replace('dp-', 'date-')
  const hidden = document.getElementById(hiddenId)
  if (hidden) hidden.value = dateStr
}

function dpChangeMonth(id, delta) {
  const s = dpState[id]
  s.month += delta
  if (s.month > 11) { s.month = 0; s.year++ }
  if (s.month < 0)  { s.month = 11; s.year-- }
  dpRender(id)
}

function dpSelect(id, dateStr) {
  dpState[id].selected = dateStr
  dpSetDisplay(id, dateStr)
  dpRender(id)
  document.getElementById(id).classList.remove('open')
}

function dpRender(id) {
  const { year, month, selected } = dpState[id]
  document.querySelector(`#${id} .dp-month-label`).textContent =
    `${MONTHS_ES[month]} ${year}`

  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7  // Mon-first
  const totalDays = new Date(year, month + 1, 0).getDate()

  const cells = []
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${year}-${pad(month+1)}-${pad(d)}`
    cells.push({ d, dateStr, isSelected: dateStr === selected, isToday: dateStr === TODAY_STR })
  }

  document.getElementById(`${id}-grid`).innerHTML = cells.map(c => {
    if (!c) return '<div class="dp-cell dp-empty"></div>'
    const cls = ['dp-cell', c.isSelected && 'selected', c.isToday && 'today'].filter(Boolean).join(' ')
    return `<div class="${cls}" data-date="${c.dateStr}">${c.d}</div>`
  }).join('')
}

// ════════════════════════════════════════════════════════
// INIT COMPONENTS
// ════════════════════════════════════════════════════════
const FIRST_OF_MONTH = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`
dpInit('dp-from', FIRST_OF_MONTH)
dpInit('dp-to',   TODAY_STR)
csInit('cs-store')

// ── User indicator ──
fetch('/auth/me')
  .then(r => r.ok ? r.json() : null)
  .then(user => {
    const el = document.getElementById('nav-user')
    if (!user) {
      el.innerHTML = '<span class="nav-user-dot"></span><span>Dev mode</span>'
      return
    }
    el.innerHTML = `
      ${user.picture ? `<img src="${user.picture}" alt="">` : '<span class="nav-user-dot"></span>'}
      <span>${user.email}</span>
      <a href="/auth/logout" class="nav-logout" title="Cerrar sesión"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2"/><path d="M9 12h12l-3-3m0 6l3-3"/></g></svg></a>
    `
  })
  .catch(() => {})

// ── Locations → populate custom select ──
fetch('/pos-export/locations')
  .then(r => r.json())
  .then(({ locations }) => {
    if (locations.length) {
      csSetOptions('cs-store', locations)
    } else {
      document.querySelector('#cs-store .cs-value').textContent = 'Sin sucursales'
    }
  })

// ════════════════════════════════════════════════════════
// APP TAB NAVIGATION
// ════════════════════════════════════════════════════════
let catalogLoaded = false

function switchTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === tab)
  )
  document.getElementById('view-export').classList.toggle('hidden', tab !== 'export')
  document.getElementById('view-catalog').classList.toggle('hidden', tab !== 'catalog')
  if (tab === 'catalog' && !catalogLoaded) loadCatalog()
}

// ════════════════════════════════════════════════════════
// RESULTS TAB SWITCHING (Pedidos / UUID)
// ════════════════════════════════════════════════════════
function switchResults(panel) {
  document.querySelectorAll('.results-tab').forEach(el =>
    el.classList.toggle('active', el.dataset.panel === panel)
  )
  document.getElementById('panel-pedidos').classList.toggle('hidden', panel !== 'pedidos')
  document.getElementById('panel-uuid').classList.toggle('hidden', panel !== 'uuid')
}

// ════════════════════════════════════════════════════════
// CATALOG
// ════════════════════════════════════════════════════════
function loadCatalog() {
  catalogLoaded = true
  Promise.all([
    fetch('/catalog/items').then(r => r.json()),
    fetch('/catalog/locations').then(r => r.json()),
    fetch('/catalog/payment-methods').then(r => r.json()),
  ]).then(([itemsData, locData, pmData]) => {
    renderCatalogTable('items',           itemsData.items,       ['sku', 'internal_id'])
    renderCatalogTable('locations',       locData.locations,     ['store_name', 'oracle_location', 'rep_id', 'shopify_location'])
    renderCatalogTable('payment-methods', pmData.paymentMethods, ['clave', 'payment_type'])
  }).catch(err => console.error('Error cargando catálogo:', err))
}

function renderCatalogTable(id, rows, cols) {
  document.getElementById(`count-${id}`).textContent = rows?.length ?? 0
  const el = document.getElementById(`table-${id}`)
  if (!rows?.length) { el.innerHTML = '<div class="catalog-empty">Sin registros</div>'; return }
  el.innerHTML = `<table>
    <thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(row => `<tr>${cols.map(c => `<td>${row[c] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>
  </table>`
}

async function clearCatalog(table) {
  const labels = { items: 'Items', locations: 'Sucursales', payment_methods: 'Métodos de pago' }
  if (!confirm(`¿Eliminar todos los registros de "${labels[table]}"?`)) return

  try {
    const res = await fetch(`/catalog/clear?table=${table}`, { method: 'DELETE' })
    const data = await res.json()
    if (data.ok) { catalogLoaded = false; loadCatalog() }
  } catch (e) {
    alert('Error al limpiar la tabla: ' + e.message)
  }
}

async function importCatalog() {
  const table     = document.getElementById('import-table').value
  const fileInput = document.getElementById('import-file')
  const statusEl  = document.getElementById('import-status')
  const btn       = document.getElementById('btn-import')
  if (!fileInput.files[0]) { statusEl.textContent = 'Selecciona un archivo CSV'; statusEl.className = 'import-status err'; return }

  btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-accent"></div>'
  statusEl.textContent = ''; statusEl.className = 'import-status'
  const formData = new FormData(); formData.append('file', fileInput.files[0])

  try {
    const res = await fetch(`/catalog/import?table=${table}`, { method: 'POST', body: formData })
    const data = await res.json()
    if (data.ok) {
      statusEl.textContent = `✓ ${data.imported} registros importados`
      statusEl.className = 'import-status ok'
      fileInput.value = ''
      catalogLoaded = false; loadCatalog()
    } else {
      statusEl.textContent = data.error ?? 'Error desconocido'
      statusEl.className = 'import-status err'
    }
  } catch (e) {
    statusEl.textContent = e.message; statusEl.className = 'import-status err'
  } finally {
    btn.disabled = false; btn.innerHTML = '↑ Importar'
  }
}

// ════════════════════════════════════════════════════════
// POS EXPORT
// ════════════════════════════════════════════════════════
let lastRows = null

function consultar() {
  const dateFrom  = document.getElementById('date-from').value
  const dateTo    = document.getElementById('date-to').value
  const storeName = document.getElementById('store').value
  if (!dateFrom || !dateTo || !storeName) return

  setLoading(true); hideError(); lastRows = null
  document.getElementById('btn-export').classList.add('hidden')
  document.getElementById('stats-row').classList.add('hidden')
  document.getElementById('results-section').classList.add('hidden')

  const previewPromise = fetch('/pos-export/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateFrom, dateTo, storeName }),
  }).then(r => r.json())

  const uuidsPromise = fetch(
    `/pos-export/uuids?dateFrom=${dateFrom}&dateTo=${dateTo}`
  ).then(r => r.json()).catch(() => ({ ok: true, uuids: {} }))

  Promise.all([previewPromise, uuidsPromise])
    .then(([result, uuidData]) => {
      setLoading(false)
      if (!result.ok) { showError(result.error); return }

      lastRows = result.rows
      renderStats(result.stats, storeName)
      renderUUIDFields(dateFrom, dateTo)

      if (uuidData.ok && uuidData.uuids) {
        for (const [date, uuid] of Object.entries(uuidData.uuids)) {
          const input = document.getElementById(`uuid-${date}`)
          if (input) input.value = uuid
        }
      }
      if (uuidData.warning) showUUIDWarning(uuidData.warning)

      renderTable(result.rows)
      document.getElementById('btn-export').classList.remove('hidden')
    })
    .catch(err => { setLoading(false); showError(err.message) })
}

function descargar() {
  if (!lastRows) return
  const dateFrom  = document.getElementById('date-from').value
  const dateTo    = document.getElementById('date-to').value
  const storeName = document.getElementById('store').value
  const uuids     = collectUUIDs()
  setDownloading(true)

  fetch('/pos-export/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateFrom, dateTo, storeName, uuids }),
  })
    .then(async res => {
      setDownloading(false)
      if (!res.ok) { const d = await res.json(); showError(d.error); return }
      const blob = new Blob(['﻿' + await res.text()], { type: 'text/csv;charset=utf-8;' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url
      a.download = `netsuite_${storeName.replace(/\s+/g,'_')}_${dateFrom}_${dateTo}.csv`
      a.click(); URL.revokeObjectURL(url)
    })
    .catch(err => { setDownloading(false); showError(err.message) })
}

function renderStats(stats, store) {
  document.getElementById('stats-row').innerHTML = `
    <div class="stat"><span class="stat-val">${stats.totalOrders}</span><span class="stat-lbl">Pedidos</span></div>
    <div class="stat"><span class="stat-val">${stats.totalLines}</span><span class="stat-lbl">Líneas</span></div>
    <div class="stat"><span class="stat-val" style="font-size:1rem;padding-top:.3rem">${store}</span><span class="stat-lbl">Sucursal</span></div>
  `
  document.getElementById('stats-row').classList.remove('hidden')
  document.getElementById('empty-state').classList.add('hidden')
}

function getDateRange(from, to) {
  const dates = []
  const cur = new Date(from + 'T12:00:00')
  const end = new Date(to   + 'T12:00:00')
  while (cur <= end) {
    dates.push(`${cur.getFullYear()}-${pad(cur.getMonth()+1)}-${pad(cur.getDate())}`)
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

function renderUUIDFields(dateFrom, dateTo) {
  document.getElementById('uuid-fields').innerHTML = getDateRange(dateFrom, dateTo).map(d => `
    <div class="uuid-row">
      <span class="uuid-date">${d}</span>
      <input class="uuid-input" type="text" id="uuid-${d}" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
    </div>
  `).join('')
}

function collectUUIDs() {
  const uuids = {}
  for (const d of getDateRange(
    document.getElementById('date-from').value,
    document.getElementById('date-to').value
  )) {
    const val = document.getElementById(`uuid-${d}`)?.value.trim()
    if (val) uuids[d] = val
  }
  return uuids
}

function renderTable(rows) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  const preview = rows.slice(0, 50)
  const note = rows.length > 50
    ? `<div class="table-note">Mostrando 50 de ${rows.length} líneas — el CSV incluye todas</div>` : ''
  document.getElementById('table-wrap').innerHTML =
    `<table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
     <tbody>${preview.map(row => `<tr>${headers.map(h => `<td>${row[h] ?? ''}</td>`).join('')}</tr>`).join('')}</tbody>
     </table>${note}`
  switchResults('pedidos')
  document.getElementById('results-section').classList.remove('hidden')
}

function setLoading(v) {
  const btn = document.getElementById('btn-consultar')
  btn.disabled = v; btn.innerHTML = v ? '<div class="spinner"></div>' : 'Consultar pedidos'
}
function setDownloading(v) {
  const btn = document.getElementById('btn-export')
  btn.disabled = v; btn.innerHTML = v ? '<div class="spinner spinner-accent"></div> Generando...' : '↓ Descargar CSV'
}
function showError(msg) { const el = document.getElementById('error-banner'); el.textContent = msg; el.style.display = 'block' }
function hideError() { document.getElementById('error-banner').style.display = 'none' }

function showUUIDWarning(msg) {
  let el = document.getElementById('uuid-warning')
  if (!el) {
    el = document.createElement('div')
    el.id = 'uuid-warning'
    el.style.cssText = 'font-size:.75rem;color:var(--text-muted,#888);margin-top:.25rem'
    document.getElementById('uuid-fields')?.after(el)
  }
  el.textContent = '⚠ ' + msg
}
