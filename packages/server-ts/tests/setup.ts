import { createApp } from '../src/app.js'
import type { FastifyInstance } from 'fastify'

let app: FastifyInstance | null = null
let token: string | null = null

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    process.env.NODE_ENV = 'test'
    app = await createApp()
    await app.ready()
  }
  return app
}

export async function getToken(): Promise<string> {
  if (!token) {
    const a = await getApp()
    // Retry a few times in case of displayName collisions across parallel workers.
    for (let attempt = 0; attempt < 5; attempt++) {
      const username = `testadmin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const res = await a.inject({
        method: 'POST', url: '/api/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ username, password: 'test123456', display_name: 'Test Admin' }),
      })
      const body = JSON.parse(res.payload)
      if (body.jwt_token) {
        token = body.jwt_token
        break
      }
    }
    if (!token) throw new Error('Failed to obtain test auth token')
  }
  return token
}

export async function authHeader() {
  return { authorization: `Bearer ${await getToken()}` }
}

export async function getAuthUserId(): Promise<string> {
  const t = await getToken()
  const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString())
  return payload.userId
}
