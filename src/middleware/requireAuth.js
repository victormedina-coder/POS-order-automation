const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN

export async function requireAuth(request, reply) {
  if (process.env.SKIP_AUTH === 'true') return

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
