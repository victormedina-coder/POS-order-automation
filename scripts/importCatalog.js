#!/usr/bin/env node
import 'dotenv/config'
import { readFileSync } from 'fs'
import { parse } from 'csv-parse/sync'
import { bulkUpsert } from '../src/services/catalog.js'
import { runMigrations } from '../src/db/schema.js'

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

runMigrations()

const content = readFileSync(fileArg, 'utf-8')
const records = parse(content, { columns: true, skip_empty_lines: true, trim: true })

bulkUpsert(tableArg, records)
console.log(`✓ ${records.length} registros importados en tabla "${tableArg}"`)
