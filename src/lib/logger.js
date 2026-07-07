// Logger estructurado compartido para código de servicio que corre FUERA del
// contexto de un request de Fastify (p.ej. src/services/*.js, src/config/*.js).
// Las rutas ya tienen `request.log` / `fastify.log` — usar ESTE módulo solo
// donde no hay acceso a esos objetos.
//
// IMPORTANTE: este módulo NO importa src/app.js. app.js hace `await app.listen(...)`
// a nivel de módulo (side effect de arrancar el servidor), así que importarlo desde
// aquí arrancaría un segundo listener al importar el logger y arriesga un import
// circular (app.js → routes → services → logger → app.js). Este logger se configura
// de forma independiente, con el mismo `level` que Fastify, para que el JSON de
// salida sea consistente en los logs de Railway.
//
// NUNCA loguear secretos/tokens/PII a través de este logger: solo IDs, conteos,
// nombres de marca y metadata operativa.

import pino from 'pino'

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
})

export default logger
