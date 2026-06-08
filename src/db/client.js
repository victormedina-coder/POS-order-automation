import { DatabaseSync } from 'node:sqlite'
import path from 'path'

const DB_PATH = process.env.DATABASE_PATH ?? './data/catalog.db'
const db = new DatabaseSync(path.resolve(DB_PATH))
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

export default db
