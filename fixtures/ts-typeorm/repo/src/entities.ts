import { ChildEntity, Column, Entity, PrimaryGeneratedColumn, TableInheritance } from 'typeorm'

@Entity()
export class OrderLine {
  @PrimaryGeneratedColumn() id!: number
  @Column() quantity!: number
}

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn() id!: number
}

@Entity({ name: 'clients', schema: 'sales' })
export class Customer {
  @PrimaryGeneratedColumn() id!: number
}

@Entity({ schema: 'billing' })
export class Invoice {
  @PrimaryGeneratedColumn() id!: number
}

@Entity()
@TableInheritance({ column: { type: 'varchar', name: 'type' } })
export class Payment {
  @PrimaryGeneratedColumn() id!: number
}

@ChildEntity()
export class CardPayment extends Payment {
  @Column() last4!: string
}
