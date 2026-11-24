/**
 * Test code is recognised by convention, not by framework attributes: a path under a test directory or named like a
 * test file, or a project named as a test project. find_tests states this in its limitations.
 */
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|Tests?\.cs$/i
const TEST_PROJECT = /(^|\.)(Tests?|UnitTests|IntegrationTests|Specs?)(\.|$)|UnitTests$|Tests$/

export const isTestCode = (path: string, project: string | null): boolean => TEST_PATH.test(path) || (project !== null && TEST_PROJECT.test(project))
/** Test code by path alone: the path patterns, or a directory named like a test project. */
export const isTestPath = (path: string): boolean => TEST_PATH.test(path) || path.split('/').slice(0, -1).some((segment) => TEST_PROJECT.test(segment))
