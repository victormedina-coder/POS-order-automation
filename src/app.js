import 'dotenv/config'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import session from '@fastify/session'
import multipart from '@fastify/multipart'
import { runMigrations } from './db/schema.js'
import authRoutes from './routes/auth.js'
import posExportRoutes from './routes/posExport.js'
import catalogImportRoutes from './routes/catalogImport.js'

const app = Fastify({ logger: true })

await app.register(cookie)
await app.register(session, {
  secret: process.env.SESSION_SECRET,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
  },
  saveUninitialized: false,
})
await app.register(multipart)

await app.register(authRoutes)
await app.register(posExportRoutes)
await app.register(catalogImportRoutes)

app.get('/', async (_req, reply) => reply.redirect('/pos-export'))

runMigrations()

const PORT = parseInt(process.env.PORT ?? '3000', 10)
await app.listen({ port: PORT, host: '0.0.0.0' })
