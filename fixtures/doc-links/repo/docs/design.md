# Design

A ledger keeps a balance and the entries that changed it.

Spending goes through `Ledger.consume`, which records a negative entry.

All of it lives in [the ledger](../src/ledger.ts).

`Ledger.refund` puts an amount back.
