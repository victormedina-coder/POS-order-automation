import 'dotenv/config'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import session from '@fastify/session'
import multipart from '@fastify/multipart'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { runMigrations } from './db/schema.js'
import authRoutes from './routes/auth.js'
import posExportRoutes from './routes/posExport.js'
import catalogImportRoutes from './routes/catalogImport.js'

// Verificar SESSION_SECRET antes de registrar el plugin de sesión.
const sessionSecret = process.env.SESSION_SECRET
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET debe estar definido y tener al menos 32 caracteres')
}

const app = Fastify({ logger: true, trustProxy: true })

await app.register(cookie)
await app.register(session, {
  secret: sessionSecret,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    // Expiración de sesión a 8 horas para limitar la ventana de secuestro de sesión.
    maxAge: 8 * 60 * 60 * 1000,
  },
  saveUninitialized: false,
})

// límite de 5 MB por archivo y máximo 1 archivo por request.
await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
})

// Security headers con CSP.
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      // script-src-attr controla los manejadores inline (onclick=, etc.).
      // Helmet lo pone en 'none' por defecto; la UI usa onclick en el HTML.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'https://lh3.googleusercontent.com', 'data:'],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
})

// Rate limiting global.
await app.register(rateLimit, {
  global: true,
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (request) => request.ip,
  errorResponseBuilder: (_request, context) => ({
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: `Demasiadas solicitudes. Intenta de nuevo en ${context.after}.`,
    },
  }),
})

await app.register(authRoutes)
await app.register(posExportRoutes)
await app.register(catalogImportRoutes)

app.get('/', async (_req, reply) => reply.redirect('/pos-export'))
app.get('/health', async () => ({ ok: true }))

runMigrations()

const PORT = parseInt(process.env.PORT ?? '3000', 10)
await app.listen({ port: PORT, host: '0.0.0.0' })
