import { Driver } from "../Driver"
import { ObjectLiteral } from "../../common/ObjectLiteral"
import { camelCase } from "../../util/StringUtils"

export class PostgresDriver implements Driver {
    async connect(): Promise<void> {}

    escape(columnName: string): string {
        return '"' + columnName + '"'
    }

    normalize(row: ObjectLiteral): ObjectLiteral {
        const out: ObjectLiteral = {}
        for (const key of Object.keys(row)) out[camelCase(key)] = row[key]
        return out
    }
}

/** A wrapper that adds nothing but its name. */
export class PostgresWrapper extends PostgresDriver {}
