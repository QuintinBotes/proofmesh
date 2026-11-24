import express from 'express'
import { cancelOrder, getOrder, listOrders, placeOrder } from '../orders/service'

const router = express.Router()
const guard = (fn) => (req, res) => fn(req, res)

router.get('/', (_req, res) => res.json(listOrders()))
router.get('/:orderId', show)
router.post('/', authenticate, (req, res) => res.status(201).json(placeOrder(req.body)))
router.delete('/:orderId(\\d+)', guard(cancel))

function show(req, res) {
  res.json(getOrder(req.params.orderId))
}

function cancel(req, res) {
  res.json(cancelOrder(req.params.orderId))
}

function authenticate(_req, _res, next) {
  next()
}

export default router
