import { upper } from "../util/text"

/** A subject line with the shop's prefix. */
export function formatSubject(subject: string): string {
    return `[shop] ${upper(subject)}`
}

/** Sends mail; the class a move plan moves. */
export class Mailer {
    send(to: string, subject: string): string {
        return `${to}: ${formatSubject(subject)}`
    }
}

/** The mailer the shop uses when none is given. */
export function defaultMailer(): Mailer {
    return new Mailer()
}
