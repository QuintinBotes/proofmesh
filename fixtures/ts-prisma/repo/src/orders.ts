import { PrismaClient } from '@prisma/client'

export class OrderService {
  constructor(private readonly prisma: PrismaClient) {}

  place(userId: number, total: number) {
    return this.prisma.order.create({ data: { userId, total } })
  }
}
