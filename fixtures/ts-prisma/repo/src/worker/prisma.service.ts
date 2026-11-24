import { PrismaClient } from '@prisma/client'

export class PrismaService extends PrismaClient {}

export class AuditedPrisma extends PrismaService {}
