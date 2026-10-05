import type { Server } from 'node:http'
import { attachCollab } from '@heurion2/platform/src/collab/gateway.ts'
import type { Documents } from '@heurion2/platform/src/model/runtime.ts'
import { verifyToken } from '@heurion2/platform/src/auth/token.ts'

export interface CollabConfig {
  docs: Documents
  secret: string
  devMode?: boolean
  devUser?: string
}

/** 挂载针对纯文档/画布的 Yjs WebSocket 实时协同通道 */
export function attachCanvasCollab(server: Server, config: CollabConfig) {
  return attachCollab(server, {
    docs: config.docs,
    authenticate: (token: string) => {
      const claims = verifyToken(config.secret, token, 'web') ?? verifyToken(config.secret, token, 'mcp')
      if (claims?.u) return claims.u
      if (config.devMode && config.devUser) return config.devUser
      return null
    },
    role: (user, doc) => (doc.owner === user || (config.devMode && config.devUser) ? 'owner' : null),
  })
}
