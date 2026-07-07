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

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true })

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

// límite de archivo configurable vía CATALOG_MAX_UPLOAD_MB (default 50 MB para
// soportar catálogos grandes, p.ej. ~50,000 filas). Máximo 1 archivo por request.
const catalogMaxUploadMb = parseInt(process.env.CATALOG_MAX_UPLOAD_MB ?? '50', 10)
await app.register(multipart, {
  limits: { fileSize: catalogMaxUploadMb * 1024 * 1024, files: 1 },
})

// Security headers con CSP.
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      // scriptSrcAttr omitido → Helmet aplica su default 'none'.
      // La UI ya no usa onclick= inline; todos los listeners están en posExport.js.
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'https://lh3.googleusercontent.com', 'data:'],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameAncestors: ["'none'"],
      // Helmet activa upgrade-insecure-requests por defecto. En local (HTTP) eso
      // reescribe enlaces como /auth/google a https://localhost y los rompe.
      // Solo tiene sentido en producción (Railway sirve por HTTPS).
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
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

// Manejador global de errores: red de seguridad para excepciones NO capturadas
// (throws que no pasaron por un try/catch con reply.status(...).send(...) explícito
// en el handler). Los handlers que ya responden explícitamente nunca llegan aquí
// porque no lanzan — este setErrorHandler solo intercepta errores propagados.
// No interfiere con @fastify/rate-limit (su errorResponseBuilder corre en su propio
// hook, antes de que la request llegue a un handler que pueda lanzar).
app.setErrorHandler((err, request, reply) => {
  request.log.error(
    { err, url: request.url, method: request.method },
    'unhandled error'
  )

  // Errores de validación de schema (Fastify/AJV) o errores operacionales con
  // statusCode 4xx explícito (p.ej. errores HTTP reenviados desde servicios como
  // Facturama) preservan su código y mensaje — son "culpa del cliente" y el
  // mensaje ya es seguro de mostrar. Todo lo demás es un 500 genérico: no se
  // filtran detalles internos (stack traces, mensajes de DB, etc.) al cliente.
  const isClientError = err.validation || (err.statusCode >= 400 && err.statusCode < 500)
  if (isClientError) {
    return reply.status(err.statusCode ?? 400).send({ ok: false, error: err.message })
  }

  return reply.status(500).send({ ok: false, error: 'Error interno del servidor' })
})

app.get('/', async (_req, reply) => reply.redirect('/pos-export'))
app.get('/health', async () => ({ ok: true }))

runMigrations()

const PORT = parseInt(process.env.PORT ?? '3000', 10)
await app.listen({ port: PORT, host: '0.0.0.0' })
