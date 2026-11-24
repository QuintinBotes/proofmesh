import { Router } from 'express'
import { getOrder } from '../orders/service'

export const legacy = Router()
legacy.get('/orders/:orderId', (req, res) => res.json(getOrder(req.params.orderId)))

const spare = Router()
spare.get('/orders', (_req, res) => res.json([]))
