import express from 'express'
import orders from './routes/orders'
import { admin } from './routes/admin'
import { legacy } from './routes/legacy'

const VERSION = '/v1'

const app = express()
app.use(express.json())
app.use('/api/orders', orders)
app.use('/admin', admin)
app.use(VERSION, legacy)
app.get('env')
app.get('/health', (_req, res) => res.send('ok'))

export default app
