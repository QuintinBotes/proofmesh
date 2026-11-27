import { Ledger } from './ledger'

export class Wallet {
  readonly id: string
  private readonly ledger = new Ledger()

  constructor(id: string) {
    this.id = id
  }

  static open(id: string): Wallet {
    return new Wallet(id)
  }

  total(): number {
    return this.ledger.total()
  }
}
