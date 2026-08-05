import { FastifyRequest, FastifyReply } from 'fastify'
import { verifyToken, JwtPayload } from './jwt'

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload
  }
}

export async function authGuard(request: FastifyRequest, reply: FastifyReply) {
  // #213: <img src> cannot send an Authorization header — the chart
  // download endpoint accepts a short-lived query token instead.
  if (request.url.startsWith('/api/v1/files/download/') && (request.query as any)?.token) {
    return
  }

  const header = request.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing authorization header' })
  }

  const token = header.slice(7)
  try {
    request.user = verifyToken(token)
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' })
  }
}

export async function adminGuard(request: FastifyRequest, reply: FastifyReply) {
  await authGuard(request, reply)
  if (reply.sent) return

  if (request.user?.role !== 'admin') {
    return reply.status(403).send({ error: 'Admin access required' })
  }
}
