import { ObjectLiteral } from "./common/ObjectLiteral"

const storage: ObjectLiteral = {}

/** The one metadata store of the process. */
export function getMetadataStorage(): ObjectLiteral {
    return storage
}

export { getMetadataStorage as metadataStorage }
