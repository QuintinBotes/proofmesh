import { Mailer } from "./mail/mailer.js"

/** Mails an alert; it names mail/mailer in a log message, which is no path. */
export function alert(text: string): string {
    console.log("mail/mailer")
    return new Mailer().send("ops@example.com", text)
}
