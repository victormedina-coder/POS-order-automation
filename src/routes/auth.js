import fp from 'fastify-plugin'
import oauth2Plugin from '@fastify/oauth2'

export default fp(async function authRoutes(fastify) {
  // Saneamos BASE_URL: un espacio o slash final sobrante (fácil de meter al pegar en
  // el dashboard de Railway) produce un redirect_uri mal formado → Google "Error 400:
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

  fastify.get('/auth/callback', async (request, reply) => {
    const token = await fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request)

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token.token.access_token}` },
    })

    if (!userRes.ok) {
      return reply.status(500).send({ error: 'Error obteniendo perfil de Google' })
    }

    const profile = await userRes.json()
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
