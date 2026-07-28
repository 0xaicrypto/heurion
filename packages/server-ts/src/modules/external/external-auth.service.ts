import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import type { FastifyRequest, FastifyReply } from 'fastify'
import prisma from '../../common/prisma'
import { config } from '../../config'

export const EXTERNAL_TOKEN_AUDIENCE = 'heurion-external'

export interface ExternalAccessTokenPayload {
  appId: string
  clientId: string
  scopes: string[]
  aud: typeof EXTERNAL_TOKEN_AUDIENCE
}

export interface ExternalAppContext {
  appId: string
  clientId: string
  scopes: string[]
}

declare module 'fastify' {
  interface FastifyRequest {
    externalApp?: ExternalAppContext
  }
}

export interface CreateExternalAppInput {
  name: string
  scopes?: string[]
  quotas?: Record<string, number>
}

export interface ExternalApplicationResult {
  id: string
  clientId: string
  clientSecret: string // raw secret, shown only once
  name: string
  scopes: string[]
  quotas: Record<string, number>
  createdAt: string
}

export async function createExternalApplication(
  input: CreateExternalAppInput,
): Promise<ExternalApplicationResult> {
  const clientId = `heurion_ext_${crypto.randomUUID().replace(/-/g, '')}`
  const rawSecret = crypto.randomBytes(32).toString('hex')
  const hash = await bcrypt.hash(rawSecret, 10)
  const now = new Date().toISOString()
  const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : ['marketplace:read']
  const quotas = input.quotas ?? {}

  const app = await prisma.externalApplication.create({
    data: {
      clientId,
      clientSecret: hash,
      name: input.name,
      scopes: JSON.stringify(scopes),
      quotas: JSON.stringify(quotas),
      createdAt: now,
      updatedAt: now,
    },
  })

  return {
    id: app.id,
    clientId: app.clientId,
    clientSecret: rawSecret,
    name: app.name,
    scopes,
    quotas,
    createdAt: app.createdAt,
  }
}

export async function verifyClientCredentials(
  clientId: string,
  clientSecret: string,
): Promise<{ appId: string; scopes: string[] } | null> {
  const app = await prisma.externalApplication.findUnique({ where: { clientId } })
  if (!app) return null
  const valid = await bcrypt.compare(clientSecret, app.clientSecret)
  if (!valid) return null
  try {
    return { appId: app.id, scopes: JSON.parse(app.scopes) as string[] }
  } catch {
    return { appId: app.id, scopes: [] }
  }
}

export function issueAccessToken(appId: string, clientId: string, scopes: string[]): string {
  const payload: ExternalAccessTokenPayload = {
    appId,
    clientId,
    scopes,
    aud: EXTERNAL_TOKEN_AUDIENCE,
  }
  return jwt.sign(payload, config.secret, {
    algorithm: config.jwtAlgorithm,
    expiresIn: '1h',
  })
}

export function verifyAccessToken(token: string): ExternalAccessTokenPayload {
  return jwt.verify(token, config.secret, {
    algorithms: [config.jwtAlgorithm],
    audience: EXTERNAL_TOKEN_AUDIENCE,
  }) as ExternalAccessTokenPayload
}

export async function externalAuthGuard(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'missing authorization header' })
  }
  const token = header.slice(7)
  try {
    const payload = verifyAccessToken(token)
    request.externalApp = {
      appId: payload.appId,
      clientId: payload.clientId,
      scopes: payload.scopes,
    }
  } catch {
    return reply.status(401).send({ error: 'invalid or expired token' })
  }
}

export function requireScope(...requiredScopes: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const scopes = request.externalApp?.scopes ?? []
    const hasScope = requiredScopes.some((s) => scopes.includes(s))
    if (!hasScope) {
      return reply.status(403).send({ error: 'insufficient scope' })
    }
  }
}

export function parseScopeList(scopeParam: string | undefined): string[] {
  if (!scopeParam) return []
  return scopeParam.split(' ').filter(Boolean)
}
