import { invoiceTotal } from "@acme/billing";

export function handleInvoice(request: { lines: { cents: number }[] }): string {
  // <img src=x onerror=alert(1)> must render as text, never as markup
  return invoiceTotal(request.lines, "EUR");
}

const handlers: Record<string, (payload: unknown) => unknown> = {};

export function dispatch(name: string, payload: unknown): unknown {
  return handlers[name](payload);
}
