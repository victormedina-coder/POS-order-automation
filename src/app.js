import 'dotenv/config'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import session from '@fastify/session'
import multipart from '@fastify/multipart'
import { runMigrations } from './db/schema.js'
import authRoutes from './routes/auth.js'
import posExportRoutes from './routes/posExport.js'
import catalogImportRoutes from './routes/catalogImport.js'

// trustProxy: Railway termina el TLS en su proxy y reenvía HTTP a la app con
// X-Forwarded-Proto: https. Sin esto, Fastify ve la conexión como HTTP y NO setea
// la cookie de sesión `secure: true` → la sesión no persiste → loop de login.
const app = Fastify({ logger: true, trustProxy: true })

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
app.get('/health', async () => ({ ok: true }))

runMigrations()

const PORT = parseInt(process.env.PORT ?? '3000', 10)
await app.listen({ port: PORT, host: '0.0.0.0' })
