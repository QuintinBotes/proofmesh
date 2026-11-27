import { ObjectLiteral } from "../common/ObjectLiteral"

export class OrmUtils {
    /** Copies every key of the sources into the target, objects key by key. */
    static mergeDeep(target: ObjectLiteral, ...sources: ObjectLiteral[]): ObjectLiteral {
        for (const source of sources) {
            for (const key of Object.keys(source)) {
                const value = source[key]
                target[key] = value && typeof value === "object" && !Array.isArray(value)
                    ? OrmUtils.mergeDeep(target[key] ?? {}, value)
                    : value
            }
        }
        return target
    }
}
