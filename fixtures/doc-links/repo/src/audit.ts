import { Wallet } from './wallet'

export function audit(wallets: Wallet[]): number {
  return wallets.reduce((sum, wallet) => sum + wallet.total(), 0)
}
