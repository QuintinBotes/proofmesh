/** A test double registry: mocks a module by the path a test imports it from. */
declare function mock(path: string): void

mock("../src/mail/mailer")

export async function loadMailer(): Promise<unknown> {
    return import("../src/mail/mailer")
}
