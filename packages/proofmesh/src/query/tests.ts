import type Database from 'better-sqlite3'

/**
 * Test code is recognised by the conventions of each language (FR191) and, for a symbol, by the roles its adapter gave it (FR192, FR193): a
 * path under a test directory or named like a test file, a project named as a test project, or a symbol that is a test entry point or sits in
 * a test-only scope. find_tests states this in its limitations.
 */
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.cs$/i
const TEST_PROJECT = /(^|\.)(Tests?|UnitTests|IntegrationTests|Specs?)(\.|$)|UnitTests$|Tests$/
/** The file names the other languages give tests; case matters, since a name like Contest.php is no PHPUnit file. */
const CONVENTIONS = [
  /(^|\/)test_[^/]*\.py$/, /_test\.py$/, /(^|\/)conftest\.py$/, // pytest and unittest discovery
  /Test\.php$/, // PHPUnit
  /_(spec|test)\.rb$/, // RSpec and Minitest
  /_(unit)?test\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/, // gtest
]
/** Go compiles a file as a test only when its name ends in _test.go; a directory named test is a package like any other. */
const GO_TEST = /_test\.go$/
const isGo = (path: string) => path.endsWith('.go')

/** The roles an adapter gave a symbol (protocol 1.1): test for a test entry point, test_support for test code that is none. */
export type Roles = readonly string[] | null | undefined
export const parseRoles = (stored: string | null | undefined): string[] | null => (stored ? (JSON.parse(stored) as string[]) : null)
export const roleTest = (roles: Roles) => !!roles?.some((r) => r === 'test' || r === 'test_support')
/** Whether a symbol is a test entry point by its own marker. */
export const isTestEntry = (roles: Roles) => !!roles?.includes('test')
const conventional = (path: string) => (isGo(path) ? GO_TEST.test(path) : TEST_PATH.test(path) || CONVENTIONS.some((c) => c.test(path)))
/** Whether a symbol is test code: its file is a test file, its project a test project, or its roles say so. Decided per symbol, not per file. */
export const isTestCode = (path: string, project: string | null, roles?: Roles): boolean =>
  roleTest(roles) || conventional(path) || (!isGo(path) && project !== null && TEST_PROJECT.test(project))
/** Test code by path alone: the file conventions, or a directory named like a test project. */
export const isTestPath = (path: string): boolean => conventional(path) || (!isGo(path) && path.split('/').slice(0, -1).some((segment) => TEST_PROJECT.test(segment)))

const withRoles = new WeakMap<Database.Database, boolean>()
/** Whether the snapshot was sealed in a format that has symbol roles (0.9); an older one has none, so every symbol is decided by its path. */
export function hasRoles(db: Database.Database): boolean {
  let has = withRoles.get(db)
  if (has === undefined) withRoles.set(db, (has = !!db.prepare("select 1 from pragma_table_info('symbol') where name = 'roles'").get()))
  return has
}
/** The symbol's roles column as SQL, or null where the snapshot has none. */
export const rolesSql = (db: Database.Database, alias = 's') => (hasRoles(db) ? `${alias}.roles` : 'null')


/** Register the SQL filter shared by query tools and the duplicate listing CLI. */
export function registerTestFilter(db: Database.Database) {
  db.function('pm_is_test', { deterministic: true, varargs: true }, (path: unknown, roles?: unknown) =>
    typeof path === 'string' && (isTestPath(path) || (typeof roles === 'string' && roleTest(parseRoles(roles)))) ? 1 : 0)
}
