/** The base of every error this library throws. */
export class AppError extends Error {
    constructor(message?: string) {
        super(message)
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

export class NotConnectedError extends AppError {
    constructor() {
        super("not connected")
    }
}

/** Whether an error is one of ours, whichever subclass. */
export function isAppError(e: unknown): e is AppError {
    return e instanceof AppError
}
