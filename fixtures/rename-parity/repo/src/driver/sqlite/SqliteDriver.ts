import { Driver } from "../Driver"
import { ObjectLiteral } from "../../common/ObjectLiteral"
import { AppError } from "../../error/AppError"

export class SqliteDriver implements Driver {
    async connect(): Promise<void> {
        throw new AppError("sqlite connects lazily")
    }

    escape(columnName: string): string {
        return '"' + columnName + '"'
    }

    normalize(row: ObjectLiteral): ObjectLiteral {
        return row
    }
}
