/** Sends mail; resolved from the container by its key. */
export class Mailer {
    send(to: string, subject: string): void {
        console.log(`Mailer sends ${subject} to ${to}`)
    }
}
