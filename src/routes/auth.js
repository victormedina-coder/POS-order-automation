import fp from 'fastify-plugin'
import oauth2Plugin from '@fastify/oauth2'

export default fp(async function authRoutes(fastify) {
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
    callbackUri: `${process.env.BASE_URL}/auth/callback`,
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
    request.session.set('user', {
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    })

    return reply.redirect('/pos-export')
  })

  fastify.get('/auth/me', async (request, reply) => {
    const user = request.session.get('user')
    if (!user) return reply.status(401).send({ error: 'No autenticado' })
    return user
  })

  fastify.get('/auth/logout', async (request, reply) => {
    request.session.delete()
    return reply.redirect('/auth/google')
  })
})
