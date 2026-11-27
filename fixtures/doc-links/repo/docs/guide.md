# Guide

The `Ledger` class keeps the balance, and a `Wallet` holds one ledger.

Open one with `Wallet.open(id)`; its `Wallet.id` is the name you gave it, and `id` alone names nothing.

Call `total()` for the balance: both `Ledger.total` and `Wallet.total` answer it.

`audit()` in `src/audit.ts` sums every wallet, and [the wallet](../src/wallet.ts#L3) is where `Wallet` is declared.

Flags such as `true`, `null` and `--verbose` are not code, nor is `npm install`, nor `Ledger.missing`, nor [the site](https://example.com/ledger).

```ts
const note = `Ledger.consume is not a mention inside a fence`
wallet.total()
```

Settings are read from `tsconfig.json`, and ``Wallet.open`` takes double backticks too.
