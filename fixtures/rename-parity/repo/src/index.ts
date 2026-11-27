export * from "./driver/Driver"
export * from "./common/ObjectLiteral"
export { ObjectType } from "./common/ObjectType"
export { DataSource } from "./data-source/DataSource"
export { AppError, NotConnectedError } from "./error/AppError"
export { camelCase } from "./util/StringUtils"
import { bracketed as bracketText } from "./util/StringUtils"
export { bracketText }

/** The package name, for messages; not exported, so not public. */
function packageName(): string {
    return "rename-parity-fixture"
}
