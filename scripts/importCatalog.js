#!/usr/bin/env node
import 'dotenv/config'
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { parse } from 'csv-parse/sync'
import { bulkUpsert } from '../src/services/catalog.js'
import { runMigrations } from '../src/db/schema.js'
import { normalizeRecords, EXPECTED_COLUMNS } from '../src/services/catalogNormalize.js'

const args = process.argv.slice(2)
const fileArg  = args[args.indexOf('--file')  + 1]
const tableArg = args[args.indexOf('--table') + 1]

if (!fileArg || !tableArg) {
  console.error('Uso: node scripts/importCatalog.js --file <path.csv> --table <items|locations|payment_methods>')
  process.exit(1)
}

if (!['items', 'locations', 'payment_methods'].includes(tableArg)) {
  console.error('--table debe ser "items", "locations" o "payment_methods"')
  process.exit(1)
}

// Resolver el path absoluto para evitar ambigüedad con paths relativos y
// dar un mensaje claro si el archivo no existe antes de intentar leerlo.
const resolvedFile = path.resolve(fileArg)
if (!existsSync(resolvedFile)) {
  console.error(`Archivo no encontrado: ${resolvedFile}`)
  process.exit(1)
}

runMigrations()

const content = readFileSync(resolvedFile, 'utf-8')
const raw = parse(content, { columns: true, skip_empty_lines: true, trim: true })
const records = normalizeRecords(raw, tableArg)

const summary = bulkUpsert(tableArg, records)
console.log(`Tabla: "${tableArg}"`)
console.log(`  Recibidos:            ${summary.received}`)
console.log(`  Insertados:           ${summary.inserted}`)
console.log(`  Vacíos omitidos:      ${summary.skippedEmptySku}`)
console.log(`  Duplicados colapsados: ${summary.duplicatesCollapsed}`)
