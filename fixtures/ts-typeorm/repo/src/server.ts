import express from 'express'
import { placeOrder } from './service'

const app = express()
app.post('/orders', (_req, res) => res.json(placeOrder()))

export default app
