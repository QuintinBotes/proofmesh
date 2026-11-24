import { formatAmount } from "@acme/format";

export interface Line {
  cents: number;
}

export function invoiceTotal(lines: Line[], currency: string): string {
  const cents = lines.reduce((sum, line) => sum + line.cents, 0);
  return formatAmount(cents, currency);
}
