/**
 * test/csvGenerator.test.js
 *
 * Tests para src/services/csvGenerator.js → generateCSV
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { generateCSV } from '../src/services/csvGenerator.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parsea un CSV simple (sin campos multi-línea) en array de objetos.
 * Útil para verificar contenido sin depender del orden exacto de líneas.
 */
function parseCSV(csv) {
  const lines = csv.split('\n')
  const headers = lines[0].split(',')
  return lines.slice(1).map(line => {
    const values = line.split(',')
    const obj = {}
    headers.forEach((h, i) => { obj[h] = values[i] })
    return obj
  })
}

/** Construye una fila de CSV con la misma estructura que posTransform produce. */
function makeRow({
  orderDate = '15/01/2025',
  orderNumber = '#1001',
  salesRepId = 'REP_001',
  internalId = 'NS_001',
  netPrice = '100.000000',
  itemQty = 1,
  paymentMethod = '01 - Efectivo',
  oracleLocation = 'ORL_GDL',
  uuid = '',
  priceLevel = 'Personalizado',
} = {}) {
  return {
    'Order Date': orderDate,
    'Order Number': orderNumber,
    'Sales Rep ID': salesRepId,
    'Internal ID': internalId,
    'Net Price': netPrice,
    'Item Qty': itemQty,
    'Payment Method UUID': paymentMethod,
    'Oracle Location': oracleLocation,
    'UUID': uuid,
    'Price Level': priceLevel,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('csvGenerator — caso vacío', () => {
  test('retorna string vacío si rows es []', () => {
    assert.equal(generateCSV([]), '')
  })
})

describe('csvGenerator — headers', () => {
  test('primera línea contiene todas las columnas correctas en el orden esperado', () => {
    const rows = [makeRow()]
    const csv = generateCSV(rows)
    const firstLine = csv.split('\n')[0]

    const expectedColumns = [
      'Order Date',
      'Order Number',
      'Sales Rep ID',
      'Internal ID',
      'Net Price',
      'Item Qty',
      'Payment Method UUID',
      'Oracle Location',
      'UUID',
      'Price Level',
    ]

    assert.equal(firstLine, expectedColumns.join(','))
  })
})

describe('csvGenerator — valores simples', () => {
  test('genera una fila con los valores correctos en el orden de los headers', () => {
    const rows = [makeRow({
      orderDate:    '15/01/2025',
      orderNumber:  '#2001',
      salesRepId:   'REP_A_1',
      internalId:   'NS_A001',
      netPrice:     '100.000000',
      itemQty:      2,
      paymentMethod: '01 - Efectivo',
      oracleLocation: 'ORL_ARIAT_GDL',
      uuid:         '',
      priceLevel:   'Personalizado',
    })]

    const csv = generateCSV(rows)
    const lines = csv.split('\n')

    assert.equal(lines.length, 2, 'Debe haber 1 header + 1 fila de datos')

    const dataLine = lines[1]
    assert.equal(
      dataLine,
      '15/01/2025,#2001,REP_A_1,NS_A001,100.000000,2,01 - Efectivo,ORL_ARIAT_GDL,,Personalizado'
    )
  })
})

describe('csvGenerator — múltiples filas', () => {
  test('genera N filas de datos para N rows', () => {
    const rows = [
      makeRow({ orderNumber: '#3001', itemQty: 1 }),
      makeRow({ orderNumber: '#3002', itemQty: 3 }),
      makeRow({ orderNumber: '#3003', itemQty: 5 }),
    ]

    const csv = generateCSV(rows)
    const lines = csv.split('\n')

    assert.equal(lines.length, 4, '1 header + 3 filas')
    assert.ok(lines[1].includes('#3001'))
    assert.ok(lines[2].includes('#3002'))
    assert.ok(lines[3].includes('#3003'))
  })
})

describe('csvGenerator — UUID presente', () => {
  test('incluye el UUID cuando está presente en la fila', () => {
    const rows = [makeRow({ uuid: 'A1B2-C3D4-E5F6-G7H8' })]
    const csv = generateCSV(rows)
    assert.ok(csv.includes('A1B2-C3D4-E5F6-G7H8'))
  })

  test('campo UUID vacío produce celda vacía (no undefined ni null)', () => {
    const rows = [makeRow({ uuid: '' })]
    const csv = generateCSV(rows)
    const parsed = parseCSV(csv)
    assert.equal(parsed[0]['UUID'], '', 'UUID vacío debe ser cadena vacía en CSV')
  })
})

describe('csvGenerator — sanitización CSV injection', () => {
  test('valores que empiezan con = reciben comilla simple prefija', () => {
    const rows = [makeRow({ orderNumber: '=CMD("rm -rf /")' })]
    const csv = generateCSV(rows)
    // El valor sanitizado debe empezar con comilla simple
    assert.ok(csv.includes("'=CMD"), `CSV: ${csv}`)
  })

  test('valores que empiezan con + son sanitizados', () => {
    const rows = [makeRow({ internalId: '+123456' })]
    const csv = generateCSV(rows)
    assert.ok(csv.includes("'+123456"), `CSV: ${csv}`)
  })

  test('valores que empiezan con - son sanitizados', () => {
    const rows = [makeRow({ netPrice: '-100.00' })]
    const csv = generateCSV(rows)
    assert.ok(csv.includes("'-100.00"), `CSV: ${csv}`)
  })

  test('valores que empiezan con @ son sanitizados', () => {
    const rows = [makeRow({ salesRepId: '@INJECT' })]
    const csv = generateCSV(rows)
    assert.ok(csv.includes("'@INJECT"), `CSV: ${csv}`)
  })
})

describe('csvGenerator — campos con coma', () => {
  test('campo que contiene coma queda entre comillas dobles', () => {
    const rows = [makeRow({ paymentMethod: '04 - Tarjeta de Crédito, Visa' })]
    const csv = generateCSV(rows)
    // El campo con coma debe quedar entre ""
    assert.ok(csv.includes('"04 - Tarjeta de Crédito, Visa"'), `CSV: ${csv}`)
  })
})

describe('csvGenerator — comillas dobles en valores', () => {
  test('comillas dobles internas se escapan duplicándolas', () => {
    // El código hace: val.replace(/"/g, '""') LUEGO envuelve en "" si contiene ","
    // Si el valor tiene " pero no "," el resultado es la cadena con "" internos pero sin envolver
    // Para forzar el envolvimiento, usamos un valor con AMBOS: comilla y coma
    const rows = [makeRow({ oracleLocation: 'Tienda "Central", GDL' })]
    const csv = generateCSV(rows)
    // El valor tiene coma → se envuelve; las comillas internas se duplican
    assert.ok(csv.includes('"Tienda ""Central"", GDL"'), `CSV: ${csv}`)
  })

  test('valor solo con comillas (sin coma) → comillas duplicadas pero sin envoltura', () => {
    const rows = [makeRow({ oracleLocation: 'Tienda "Central"' })]
    const csv = generateCSV(rows)
    // Sin coma → no se envuelve. Las comillas se duplican: Tienda ""Central""
    assert.ok(csv.includes('Tienda ""Central""'), `CSV: ${csv}`)
    // Y no debe haber envoltura adicional de comillas en el campo completo
    // (el campo no empieza con " envolviendo todo el valor)
    assert.ok(!csv.includes('"Tienda ""Central"""'), `No debe haber triple comilla: ${csv}`)
  })
})

describe('csvGenerator — columnas en orden de la primera fila', () => {
  test('el orden de columnas sigue el orden de keys del primer objeto', () => {
    // Verificar que los headers siguen el orden de Object.keys(rows[0])
    const row = makeRow()
    const expectedHeaders = Object.keys(row)
    const csv = generateCSV([row])
    const headerLine = csv.split('\n')[0]
    assert.equal(headerLine, expectedHeaders.join(','))
  })
})
