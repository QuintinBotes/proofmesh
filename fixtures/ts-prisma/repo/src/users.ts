import { prisma } from './db'

export async function listUsers() {
  return prisma.user.findMany({ orderBy: { email: 'asc' } })
}

export async function recentAudit() {
  return prisma.auditEntry.findMany({ take: 10 })
}

export async function countInvoices() {
  return prisma.invoice.count()
}
