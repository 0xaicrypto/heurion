import { afterAll } from 'vitest'
import prisma from '../src/common/prisma.js'

// Vitest isolates modules per test file, so each file creates its own
// PrismaClient. Disconnect each one after its tests finish; otherwise dozens
// of query-engine napi refs get GC'd together at process exit and the engine
// aborts with "failed to delete napi ref" (flaky CI exit-code 1).
afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})
