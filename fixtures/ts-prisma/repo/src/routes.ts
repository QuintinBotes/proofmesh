import express from 'express'
import { prisma } from './db'
import { OrderService } from './orders'
import { listUsers } from './users'

const api = express.Router()
const orders = new OrderService(prisma)

api.get('/users', async (_req, res) => res.json(await listUsers()))
api.post('/orders', placeOrder)

function placeOrder(req, res) {
  res.status(201).json(orders.place(req.body.userId, req.body.total))
}

export default api
