import { Driver } from "../Driver"
import { PostgresWrapper } from "../postgres/PostgresDriver"

/** Implements Driver through the members it inherits: it declares no escape of its own. */
export class AuroraDriver extends PostgresWrapper implements Driver {
    region = "eu"
}
