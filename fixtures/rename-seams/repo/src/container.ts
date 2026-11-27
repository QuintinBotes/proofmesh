import { Mailer } from "./mailer"

/** A small service container: a class is registered under a string key and resolved by it. */
class Container {
    private readonly factories = new Map<string, () => unknown>()

    register(key: string, type: new () => unknown): void {
        this.factories.set(key, () => new type())
    }

    resolve<T>(key: string): T {
        return this.factories.get(key)!() as T
    }
}

export const container = new Container()
container.register("Mailer", Mailer)
// container.resolve("Mailer") reads it back, in src/orders.ts
