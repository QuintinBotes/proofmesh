import * as orm from 'typeorm'
import { Entity as Table } from 'typeorm'
import { Entity } from './decorators'

const AUDIT = ['audit', 'log'].join('_')

/** A read model over the orders table: a second entity on a table another file declared first. */
@orm.Entity({ name: 'orders' })
export class OrderSummary {
  total!: number
}

@Table(AUDIT)
export class AuditEntry {
  message!: string
}

@Entity('drafts')
export class Draft {
  body!: string
}
