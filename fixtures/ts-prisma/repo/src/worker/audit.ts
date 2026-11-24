import { AuditedPrisma, PrismaService } from './prisma.service'

export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  recent() {
    return this.prisma.auditEntry.findMany()
  }
}

const audited = new AuditedPrisma()

export function firstUser() {
  return audited.user.findFirst()
}
