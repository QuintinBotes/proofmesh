import { Router } from './router'

const cache = { get: (key: string, fallback: () => string) => fallback() + key }
cache.get('/api/orders', () => 'none')

const local = Router()
local.get('/decoy', () => 'not express')
