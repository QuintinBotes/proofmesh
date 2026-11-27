import { DataSource } from "./data-source/DataSource"
import { Driver } from "./driver/Driver"
import { AuroraDriver } from "./driver/aurora/AuroraDriver"
import { MariaDriver } from "./driver/mysql/MysqlDriver"
import { SqliteDriver } from "./driver/sqlite/SqliteDriver"
import { metadataStorage } from "./globals"

/** A data source for a dialect by name, initialized. */
export async function connect(dialect: string): Promise<DataSource> {
    const driver: Driver = dialect === "aurora" ? new AuroraDriver() : dialect === "maria" ? new MariaDriver() : new SqliteDriver()
    const dataSource = new DataSource(driver, metadataStorage())
    console.log(`connecting ${driver.escape(dialect)}`)
    return dataSource.initialize()
}

/** A driver the caller does not type: the call binds to nothing the compiler can name. */
export function quoteLoosely(driver: any, name: string): string {
    return driver.escape(name)
}
