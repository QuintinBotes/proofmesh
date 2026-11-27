import { Driver } from "../driver/Driver"
import { ObjectLiteral } from "../common/ObjectLiteral"
import { ObjectType } from "../common/ObjectType"
import { getMetadataStorage } from "../globals"
import { AppError, NotConnectedError } from "../error/AppError"
import { OrmUtils } from "../util/OrmUtils"

export class DataSource {
    isInitialized = false

    constructor(readonly driver: Driver, readonly options: ObjectLiteral = {}) {}

    async initialize(): Promise<this> {
        if (this.isInitialized) throw new AppError("already initialized")
        await this.driver.connect()
        this.isInitialized = true
        return this
    }

    getMetadata(target: ObjectType<any> | string): ObjectLiteral {
        if (!this.isInitialized) throw new NotConnectedError()
        const all = getMetadataStorage()
        const name = typeof target === "string" ? target : target.name
        return OrmUtils.mergeDeep({}, all[name] ?? {}, this.options)
    }

    hasMetadata(target: ObjectType<any>): boolean {
        return !!this.getMetadata(target)
    }

    quote(column: string): string {
        const { escape } = this.driver
        return escape.call(this.driver, column)
    }
}
