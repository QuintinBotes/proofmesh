import { Mailer, formatSubject } from "./mail/mailer"

/** Mails the order's confirmation. */
export function confirm(id: string): string {
    const mailer = new Mailer()
    return mailer.send("shop@example.com", formatSubject(`order ${id}`))
}
