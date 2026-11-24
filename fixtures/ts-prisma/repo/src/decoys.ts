import { prisma } from './db'

// Named and shaped like Prisma Client, but declared here, not imported from @prisma/client.
class PrismaClient {
  user = { findMany: () => [] as string[] }
}

const local = new PrismaClient()
const cache = { order: { create: (total: number) => total } }

export const lookalike = () => local.user.findMany()
export const cached = () => cache.order.create(1)
export const metrics = () => prisma.$metrics.json()
