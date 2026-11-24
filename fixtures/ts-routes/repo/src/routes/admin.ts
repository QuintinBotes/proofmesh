import { Router } from 'express'
import { daily, weekly } from '../reports'

const PERIOD = 'weekly'

const reports = Router()
reports.get('/daily', daily)
reports.get('/' + PERIOD, weekly)

export const admin = Router()
admin.use('/reports', reports)
