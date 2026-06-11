import fp from 'fastify-plugin'
import oauth2Plugin from '@fastify/oauth2'

export default fp(async function authRoutes(fastify) {
  // invalid_request". Quitamos espacios y slash final antes de construir el callback.
  const baseUrl = (process.env.BASE_URL ?? '').trim().replace(/\/+$/, '')
  const callbackUri = `${baseUrl}/auth/callback`
  fastify.log.info(`Google OAuth callbackUri: "${callbackUri}"`)

  await fastify.register(oauth2Plugin, {
    name: 'googleOAuth2',
    scope: ['profile', 'email'],
    credentials: {
      client: {
        id: process.env.GOOGLE_CLIENT_ID,
        secret: process.env.GOOGLE_CLIENT_SECRET,
      },
      auth: oauth2Plugin.GOOGLE_CONFIGURATION,
    },
    startRedirectPath: '/auth/google',
    callbackUri,
  })

  // Límite estricto en el callback de OAuth para mitigar abuso de token
  fastify.get('/auth/callback', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {

    let token
    try {
      token = await fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request)
    } catch (err) {
      fastify.log.warn({ err }, 'OAuth token exchange failed — posible state inválido o CSRF')
      return reply.status(400).send({ error: 'Error en la autenticación. Intenta de nuevo.' })
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.token.access_token}` },
    })

    if (!userRes.ok) {
      return reply.status(500).send({ error: 'Error obteniendo perfil de Google' })
    }

    const profile = await userRes.json()

    // Validar dominio ANTES de escribir la sesión.
    const allowedDomain = process.env.ALLOWED_DOMAIN
    if (allowedDomain) {
      const emailDomain = (profile.email ?? '').split('@')[1]
      const hdMatch = !profile.hd || profile.hd === allowedDomain
      if (emailDomain !== allowedDomain || !hdMatch) {
        return reply.status(403).send({ error: 'Acceso denegado: dominio no autorizado' })
      }
    }

    // Regenerar la sesión antes de escribir datos del usuario para prevenir session fixation.
    await request.session.regenerate()

    request.session.user = {
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    }

    return reply.redirect('/pos-export')
  })

  fastify.get('/auth/me', async (request, reply) => {
    const user = request.session.user
    if (!user) return reply.status(401).send({ error: 'No autenticado' })
    return user
  })

  fastify.get('/auth/logout', async (request, reply) => {
    await request.session.destroy()
    return reply.redirect('/auth/google')
  })
})
