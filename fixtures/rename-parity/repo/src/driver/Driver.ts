import { ObjectLiteral } from "../common/ObjectLiteral"

/** A database driver: every dialect implements it. */
export interface Driver {
    connect(): Promise<void>

    escape(name: string): string

    normalize(row: ObjectLiteral): ObjectLiteral
}
