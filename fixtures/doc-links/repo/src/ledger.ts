export class Ledger {
  private balance = 0
  private readonly entries: number[] = []

  consume(amount: number): number {
    if (amount > this.balance) throw new Error('insufficient balance')
    this.balance -= amount
    this.entries.push(-amount)
    return this.balance
  }

  refund(amount: number): number {
    this.balance += amount
    this.entries.push(amount)
    return this.balance
  }

  total(): number {
    return this.entries.reduce((sum, entry) => sum + entry, 0)
  }
}
