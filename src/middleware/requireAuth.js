const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN

export async function requireAuth(request, reply) {
  const user = request.session.get('user')

  if (!user) {
    return reply.redirect('/auth/google')
  }

  const emailDomain = user.email.split('@')[1]
  if (emailDomain !== ALLOWED_DOMAIN) {
    request.session.delete()
    return reply.status(403).send({ error: 'Acceso denegado: dominio no autorizado' })
  }
}
