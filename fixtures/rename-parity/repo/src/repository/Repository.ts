import { DataSource, Driver, ObjectLiteral, ObjectType } from ".."
import { camelCase as toCamel } from "../util/StringUtils"
import { isAppError } from "../error/AppError"

/** Reads rows of one entity through a data source. */
export class Repository<T extends ObjectLiteral> {
    constructor(
        readonly dataSource: DataSource,
        readonly target: ObjectType<T>,
    ) {}

    get driver(): Driver {
        return this.dataSource.driver
    }

    columnOf(property: string): string {
        return this.driver.escape(toCamel(property))
    }

    async metadata(): Promise<ObjectLiteral | undefined> {
        try {
            return this.dataSource.getMetadata(this.target)
        } catch (e) {
            if (isAppError(e)) return undefined
            throw e
        }
    }

    static async open<E extends ObjectLiteral>(dataSource: DataSource, target: ObjectType<E>): Promise<Repository<E>> {
        if (!dataSource.isInitialized) await dataSource.initialize()
        return new Repository<E>(dataSource, target)
    }
}
