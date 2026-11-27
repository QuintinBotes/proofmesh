import { Driver } from "../Driver"
import { ObjectLiteral } from "../../common/ObjectLiteral"

export class MysqlDriver implements Driver {
    async connect(): Promise<void> {}

    escape(columnName: string): string {
        return "`" + columnName + "`"
    }

    normalize(row: ObjectLiteral): ObjectLiteral {
        return { ...row }
    }
}

/** A dialect that quotes like MySQL and says so in its own escape. */
export class MariaDriver extends MysqlDriver {
    escape(columnName: string): string {
        return super.escape(columnName)
    }
}
