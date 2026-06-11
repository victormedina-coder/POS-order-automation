const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN

// SameSite=lax ya protege contra CSRF clásico; este hook es capa adicional.
export async function requireXhr(request, reply) {
  if (request.headers['x-requested-with'] !== 'XMLHttpRequest') {
    return reply.status(403).send({ error: 'Solicitud no permitida' })
  }
}

export async function requireAuth(request, reply) {
  // En Railway con NODE_ENV=production esta línea nunca se evalúa a true.
  if (process.env.SKIP_AUTH === 'true' && process.env.NODE_ENV !== 'production') return

  const user = request.session.user

  if (!user) {
    return reply.redirect('/auth/google')
  }

  const emailDomain = user.email.split('@')[1]
  if (emailDomain !== ALLOWED_DOMAIN) {
    await request.session.destroy()
    return reply.status(403).send({ error: 'Acceso denegado: dominio no autorizado' })
  }
}
