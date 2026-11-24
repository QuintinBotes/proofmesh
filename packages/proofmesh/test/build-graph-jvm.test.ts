import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILT_IN } from '../src/indexer/languages.js'
import { fixtureRepo, indexedDataDir, indexedRepo, rows, tmpDir, withSnapshot } from './helpers.js'

let fixtureDir: Promise<string> | undefined
const fixtureIndex = () => (fixtureDir ??= indexedDataDir(fixtureRepo('build-graph-jvm')).then((r) => r.dataDir))
const INFERRED = 'gradle_script_pattern'
const projects = (db: Parameters<Parameters<typeof withSnapshot>[1]>[0]) => (db.prepare("select s.qualified_name as name, f.path, s.start_line as line from symbol s join file f on f.id = s.file_id where s.kind = 'project' order by s.qualified_name").all())
const owners = (db: Parameters<Parameters<typeof withSnapshot>[1]>[0]) => db.prepare("select f.path, p.qualified_name as project from assertion a join symbol p on p.id = a.source_id join symbol m on m.id = a.target_id join file f on f.id = m.file_id where a.type = 'contains' order by f.path").all()
const pom = (body: string, head = '') => `<?xml version="1.0"?>\n<project>\n${head}${body}</project>\n`

describe('FR151 FR152 FR153 FR158 the Maven module graph, read from pom.xml as text', () => {
  it('FR151 issue 13 scenario 1: a pom is a project named groupId:artifactId, the group inherited from its parent, at the line of its artifactId', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect((projects(db) as Array<{ name: string }>).filter((p) => !p.name.startsWith(':'))).toEqual([
        { name: 'com.acme:core', path: 'maven/core/pom.xml', line: 9 },
        { name: 'com.acme:shop', path: 'maven/pom.xml', line: 5 },
        { name: 'com.acme:web', path: 'maven/web/pom.xml', line: 9 },
      ])
    })
  }, 240000)

  it('FR153 issue 13 scenario 2: web depends_on core, resolved, through ${project.groupId}, at the dependency element', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect(rows(db, 'depends_on').filter((r) => !r.from.startsWith(':')).map((r) => [r.from, r.to, r.resolution, r.origin, r.path, r.line])).toEqual([
        ['com.acme:web', 'com.acme:core', 'resolved', 'configuration_adapter', 'maven/web/pom.xml', 11],
      ])
    })
  }, 240000)

  it('FR153 issue 13 scenario 3: a dependency outside the repository is maven:<group>:<artifact> with its declared version', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect(rows(db, 'depends_on_package').filter((r) => !r.from.startsWith(':')).map((r) => [r.from, r.to, r.resolution, r.detail, r.path, r.line])).toEqual([
        ['com.acme:web', 'maven:com.google.guava:guava', 'resolved_external', { version: '33.0.0-jre' }, 'maven/web/pom.xml', 16],
      ])
    })
  }, 240000)

  it('FR153 a version from a property of the same pom or its parent is resolved when literal, and otherwise recorded as written; a managed version is used', async () => {
    const { dataDir } = await indexedRepo({
      'pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>root</artifactId>\n  <properties><okio.version>3.9.0</okio.version><a>${b}</a><b>${a}</b></properties>\n  <dependencyManagement><dependencies><dependency><groupId>x</groupId><artifactId>managed</artifactId><version>2.0</version></dependency></dependencies></dependencyManagement>\n  <modules><module>kid</module></modules>\n'),
      'kid/pom.xml': pom('  <artifactId>kid</artifactId>\n  <dependencies>\n    <dependency><groupId>com.squareup.okio</groupId><artifactId>okio</artifactId><version>${okio.version}</version></dependency>\n    <dependency><groupId>x</groupId><artifactId>managed</artifactId></dependency>\n    <dependency><groupId>x</groupId><artifactId>loop</artifactId><version>${a}</version></dependency>\n    <dependency><groupId>x</groupId><artifactId>unset</artifactId><version>${nope}</version></dependency>\n  </dependencies>\n', '  <parent><groupId>g</groupId><artifactId>root</artifactId><version>1</version></parent>\n'),
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => [r.to, r.resolution, r.detail])).toEqual([
        ['maven:com.squareup.okio:okio', 'resolved_external', { version: '3.9.0' }],
        ['maven:x:loop', 'resolved_external', { version_expression: '${a}' }],
        ['maven:x:managed', 'resolved_external', { version: '2.0' }],
        ['maven:x:unset', 'resolved_external', { version_expression: '${nope}' }],
      ])
    })
  }, 240000)

  it('FR153 a dependency whose group or artifact is a property that cannot be read is named as dynamic, not dropped and not guessed', async () => {
    const { dataDir, repo } = await indexedRepo({
      'pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>a</artifactId>\n  <dependencies>\n    <dependency><groupId>${some.group}</groupId><artifactId>b</artifactId></dependency>\n  </dependencies>\n'),
    })
    expect(fs.existsSync(repo)).toBe(true)
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => [r.from, r.to, r.resolution, r.reason, r.line])).toEqual([['g:a', null, 'unresolved', 'dynamic_specifier', 6]])
      expect(db.prepare("select capabilities from file where path = 'pom.xml'").get()).toEqual({ capabilities: expect.stringContaining('"symbols":"partial"') })
    })
  }, 240000)

  it('FR152 a module the pom lists that has no pom on disk is an unresolved depends_on, dependency_missing, naming it', async () => {
    const { dataDir } = await indexedRepo({
      'pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>root</artifactId>\n  <modules>\n    <module>present</module>\n    <module>ghost</module>\n  </modules>\n'),
      'present/pom.xml': pom('  <artifactId>present</artifactId>\n', '  <parent><groupId>g</groupId><artifactId>root</artifactId><version>1</version></parent>\n'),
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on').map((r) => [r.from, r.to, r.resolution, r.reason, r.detail, r.line])).toEqual([['g:root', null, 'unresolved', 'dependency_missing', { module: 'ghost' }, 7]])
    })
  }, 240000)

  it('FR151 a pom with no artifactId declares no project and does not hide the project above it', async () => {
    const { dataDir } = await indexedRepo({
      'pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>root</artifactId>\n'),
      'odd/pom.xml': pom('  <groupId>g</groupId>\n'),
      'odd/A.java': 'class A {}\n',
    })
    withSnapshot(dataDir, (db) => {
      expect((projects(db) as Array<{ name: string }>).map((p) => p.name)).toEqual(['g:root'])
      expect(owners(db)).toEqual([{ path: 'odd/A.java', project: 'g:root' }])
    })
  }, 240000)

  it('FR151 two poms of one name make a dependency on it ambiguous, with both as candidates', async () => {
    const { dataDir } = await indexedRepo({
      'a/pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>dup</artifactId>\n'),
      'b/pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>dup</artifactId>\n'),
      'c/pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>c</artifactId>\n  <dependencies><dependency><groupId>g</groupId><artifactId>dup</artifactId></dependency></dependencies>\n'),
    })
    withSnapshot(dataDir, (db) => {
      const [r, ...rest] = rows(db, 'depends_on')
      expect(rest).toEqual([])
      expect([r!.from, r!.resolution, r!.candidates]).toEqual(['g:c', 'ambiguous', ['g:dup@a/pom.xml', 'g:dup@b/pom.xml']])
    })
  }, 240000)

  it('FR159 a pom that is not well-formed fails that file with the line, and every other build file is still read', async () => {
    const { dataDir } = await indexedRepo({
      'good/pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>good</artifactId>\n'),
      'bad/pom.xml': '<project>\n  <artifactId>bad</artifactId>\n  <dependencies>\n</project>\n',
      'gradle/settings.gradle': "include 'x'\n",
    })
    withSnapshot(dataDir, (db) => {
      expect(db.prepare("select path, disposition, disposition_detail from file where path like '%pom.xml' order by path").all()).toEqual([
        { path: 'bad/pom.xml', disposition: 'failed', disposition_detail: expect.stringMatching(/^invalid_xml:line 4\b/) },
        { path: 'good/pom.xml', disposition: 'indexed', disposition_detail: null },
      ])
      expect((projects(db) as Array<{ name: string }>).map((p) => p.name)).toEqual([':x', 'g:good'])
    })
  }, 240000)

  it('FR159 an entity declared in the DOCTYPE is never expanded: the name and a dependency keep the reference as written, and CDATA and a commented element are read as text', async () => {
    const { dataDir } = await indexedRepo({
      'pom.xml': '<?xml version="1.0"?>\n<!DOCTYPE project [<!ENTITY a "aaaa"> <!ENTITY b "&a;&a;&a;&a;">]>\n<project>\n  <!-- <artifactId>commented</artifactId> -->\n  <groupId>g</groupId>\n  <artifactId>real&b;<![CDATA[<x>]]></artifactId>\n  <dependencies><dependency><groupId>x</groupId><artifactId>dep&a;</artifactId></dependency></dependencies>\n</project>\n',
    })
    withSnapshot(dataDir, (db) => {
      expect((projects(db) as Array<{ name: string }>).map((p) => p.name)).toEqual(['g:real&b;<x>'])
      expect(rows(db, 'depends_on_package').map((r) => r.to)).toEqual(['maven:x:dep&a;'])
    })
  }, 240000)
})

describe('FR154 FR155 FR156 the Gradle module graph, read from settings and build scripts as text', () => {
  it('FR154 issue 13 scenario 1: each project a settings script includes is a project named by its path, at the line of the include', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect((projects(db) as Array<{ name: string }>).filter((p) => p.name.startsWith(':'))).toEqual([
        { name: ':app', path: 'gradle/settings.gradle.kts', line: 3 },
        { name: ':lib', path: 'gradle/settings.gradle.kts', line: 3 },
      ])
    })
  }, 240000)

  it('FR155 issue 13 scenario 2: :app depends_on :lib, resolved, and marked as read from a script by pattern', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect(rows(db, 'depends_on').filter((r) => r.from.startsWith(':')).map((r) => [r.from, r.to, r.resolution, r.detail, r.path, r.line])).toEqual([
        [':app', ':lib', 'resolved', { inferred: INFERRED }, 'gradle/app/build.gradle.kts', 13],
      ])
    })
  }, 240000)

  it('FR155 issue 13 scenario 3: string coordinates are maven:<group>:<artifact> with their version, marked inferred', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect(rows(db, 'depends_on_package').filter((r) => r.from.startsWith(':') && r.resolution === 'resolved_external').map((r) => [r.from, r.to, r.detail, r.path, r.line])).toEqual([
        [':app', 'maven:com.squareup.okio:okio', { version: '3.9.0', inferred: INFERRED }, 'gradle/app/build.gradle.kts', 14],
        [':lib', 'maven:org.slf4j:slf4j-api', { version: '2.0.13', inferred: INFERRED }, 'gradle/lib/build.gradle', 8],
      ])
    })
  }, 240000)

  it('FR156 issue 13 scenario 5: a dependency a Groovy loop adds is not invented; it is named as dynamic at the loop\'s line, and the file reports partial', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect(rows(db, 'depends_on_package').filter((r) => r.resolution !== 'resolved_external').map((r) => [r.from, r.to, r.resolution, r.reason, r.path, r.line, r.detail])).toEqual([
        [':lib', null, 'unresolved', 'dynamic_specifier', 'gradle/lib/build.gradle', 10, { configuration: 'implementation', source: 'd', inferred: INFERRED }],
      ])
      const caps = (p: string) => JSON.parse((db.prepare('select capabilities from file where path = ?').get(p) as { capabilities: string }).capabilities)
      expect(caps('gradle/lib/build.gradle').symbols).toBe('partial')
      expect(caps('gradle/app/build.gradle.kts').symbols).toBe('complete')
    })
  }, 240000)

  it('FR156 the census says the Gradle graph is partial where a script has a dependency it cannot read', async () => {
    const d = await fixtureIndex()
    const census = withSnapshot(d, (db) => JSON.parse((db.prepare("select value from meta where key = 'census'").get() as { value: string }).value)) as Array<{ language: string; capabilities: Record<string, { partial: number; complete: number }> }>
    const gradle = census.filter((r) => /^Gradle$/.test(r.language))
    // The Groovy script with the loop is partial, and the Kotlin script and the settings beside it are not: the row says some of the language was not read.
    expect(gradle.map((r) => [r.language, r.capabilities.symbols!.partial])).toEqual([['Gradle', 1]])
  }, 240000)

  it('FR154 include forms: bare, nested, several per call, Groovy and Kotlin, a repeat, and a computed include that makes the file partial', async () => {
    const { dataDir } = await indexedRepo({
      'settings.gradle': "include 'a', ':b'\ninclude 'c:d'\ninclude(\n  \"e\",\n  \"a\"\n)\ninclude(*names)\n",
    })
    withSnapshot(dataDir, (db) => {
      expect((projects(db) as Array<{ name: string }>).map((p) => p.name)).toEqual([':a', ':b', ':c:d', ':e'])
      expect(JSON.parse((db.prepare("select capabilities from file where path = 'settings.gradle'").get() as { capabilities: string }).capabilities).symbols).toBe('partial')
    })
  }, 240000)

  it('FR155 a project dependency absent from the settings is an unresolved depends_on, dependency_missing; configurations, Groovy maps and platform() are read', async () => {
    const { dataDir } = await indexedRepo({
      'settings.gradle': "include 'a', 'b'\n",
      'a/build.gradle': "dependencies {\n    testImplementation project(path: ':b')\n    implementation project(':nope')\n    runtimeOnly group: 'g', name: 'n', version: '1'\n    implementation platform('org:bom:3')\n    api(\"x:y\")\n}\n",
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on').map((r) => [r.from, r.to, r.resolution, r.reason, r.detail, r.line])).toEqual([
        [':a', ':b', 'resolved', null, { inferred: INFERRED }, 2],
        [':a', null, 'unresolved', 'dependency_missing', { path: ':nope', inferred: INFERRED }, 3],
      ])
      expect(rows(db, 'depends_on_package').map((r) => [r.to, r.detail, r.line])).toEqual([
        ['maven:g:n', { version: '1', inferred: INFERRED }, 4],
        ['maven:org:bom', { version: '3', inferred: INFERRED }, 5],
        ['maven:x:y', { inferred: INFERRED }, 6],
      ])
    })
  }, 240000)

  it('FR155 a version-catalog alias resolves to its coordinates, a bundle to each member; an alias the catalog does not give is dynamic', async () => {
    const { dataDir } = await indexedRepo({
      'settings.gradle.kts': 'include(":app")\n',
      'gradle/libs.versions.toml': '[versions]\nokio = "3.9.0"\n\n[libraries]\nokio = { module = "com.squareup.okio:okio", version.ref = "okio" }\nsome-lib = "g:some:1.2"\nparts = { group = "p", name = "parts", version = "4" }\n\n[bundles]\nboth = ["okio", "some-lib"]\n',
      'app/build.gradle.kts': 'dependencies {\n    implementation(libs.okio)\n    implementation(libs.some.lib)\n    implementation(libs.bundles.both)\n    implementation(libs.parts)\n    implementation(libs.missing)\n}\n',
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => [r.to, r.resolution, r.reason, r.detail?.version ?? null, r.line])).toEqual([
        ['maven:com.squareup.okio:okio', 'resolved_external', null, '3.9.0', 2],
        ['maven:com.squareup.okio:okio', 'resolved_external', null, '3.9.0', 4],
        ['maven:g:some', 'resolved_external', null, '1.2', 3],
        ['maven:g:some', 'resolved_external', null, '1.2', 4],
        ['maven:p:parts', 'resolved_external', null, '4', 5],
        [null, 'unresolved', 'dynamic_specifier', null, 6],
      ])
    })
  }, 240000)

  it('FR156 an interpolated coordinate, a call and a dependency in an allprojects block are named dynamic or left to the file\'s partial status, never guessed', async () => {
    const { dataDir } = await indexedRepo({
      'settings.gradle': "include 'a'\n",
      'a/build.gradle': "def v = '1'\ndependencies {\n    implementation \"g:interpolated:$v\"\n    implementation(kotlin(\"stdlib\"))\n    implementation 'g:ok:1' // comment 'x:y:z'\n}\nallprojects {\n    dependencies { implementation 'g:everywhere:1' }\n}\n// implementation 'g:commented:1'\n/* implementation 'g:blocked:1' */\n",
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => [r.to, r.resolution, r.line])).toEqual([
        ['maven:g:ok', 'resolved_external', 5],
        [null, 'unresolved', 3],
        [null, 'unresolved', 4],
      ])
      expect(JSON.parse((db.prepare("select capabilities from file where path = 'a/build.gradle'").get() as { capabilities: string }).capabilities).symbols).toBe('partial')
    })
  }, 240000)

  it('FR159 a script with a comment that is never closed fails that file with the line, and the other files are still read', async () => {
    const { dataDir } = await indexedRepo({
      'settings.gradle': "include 'a', 'b'\n",
      'a/build.gradle': "dependencies {\n    implementation 'g:a:1'\n}\n/* never closed\n",
      'b/build.gradle': "dependencies {\n    implementation 'g:b:1'\n}\n",
    })
    withSnapshot(dataDir, (db) => {
      expect(db.prepare("select path, disposition, disposition_detail from file where path like '%build.gradle' order by path").all()).toEqual([
        { path: 'a/build.gradle', disposition: 'failed', disposition_detail: expect.stringMatching(/^invalid_gradle:line 4\b/) },
        { path: 'b/build.gradle', disposition: 'indexed', disposition_detail: null },
      ])
      expect(rows(db, 'depends_on_package').map((r) => [r.from, r.to])).toEqual([[':b', 'maven:g:b']])
    })
  }, 240000)
})

describe('FR157 FR160 each source file is in the module of its nearest build file; fixtures and vendored copies declare none', () => {
  it('FR157 issue 13 scenario 4: a Maven module and a Gradle project contain the files under their directories', async () => {
    const d = await fixtureIndex()
    withSnapshot(d, (db) => {
      expect(owners(db)).toEqual([
        { path: 'gradle/app/src/main/java/app/App.java', project: ':app' },
        { path: 'gradle/lib/src/main/java/lib/Lib.java', project: ':lib' },
        { path: 'maven/core/src/main/java/com/acme/core/Core.java', project: 'com.acme:core' },
        { path: 'maven/web/src/main/java/com/acme/web/Web.java', project: 'com.acme:web' },
        { path: 'maven/web/src/test/java/com/acme/web/WebTest.java', project: 'com.acme:web' },
      ])
    })
  }, 240000)

  it('FR160 a pom or build script under testdata or vendor declares no project, and a pom.xml of another kind of XML is not a project', async () => {
    const { dataDir } = await indexedRepo({
      'pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>root</artifactId>\n'),
      'testdata/pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>fixture</artifactId>\n'),
      'vendor/x/settings.gradle': "include 'vendored'\n",
      'other/pom.xml': '<beans><artifactId>not-a-pom</artifactId></beans>\n',
    })
    withSnapshot(dataDir, (db) => {
      expect((projects(db) as Array<{ name: string }>).map((p) => p.name)).toEqual(['g:root'])
      expect(db.prepare("select disposition from file where path = 'other/pom.xml'").get()).toEqual({ disposition: 'failed' })
    })
  }, 240000)
})

const props = (o: Record<string, string>) => `  <properties>${Object.entries(o).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</properties>\n`
const dep1 = (version: string) => `  <dependencies><dependency><groupId>x</groupId><artifactId>lib</artifactId><version>${version}</version></dependency></dependencies>\n`
const partialSymbols = (db: Parameters<Parameters<typeof withSnapshot>[1]>[0], file: string) => JSON.parse((db.prepare('select capabilities from file where path = ?').get(file) as { capabilities: string }).capabilities).symbols
const jvmRoot = '  <groupId>g</groupId>\n  <artifactId>a</artifactId>\n'

describe('FR153 FR159 hostile and unusual build files cannot hang, crash or mislead the adapter', () => {
  it('FR153 a property chain that fans out past the cap is left as written and the file is partial, and it finishes', async () => {
    const chain = Object.fromEntries([0, 1, 2, 3].map((i) => [`p${i}`, i === 3 ? 'x' : ('${p' + (i + 1) + '}').repeat(30)]))
    const { dataDir } = await indexedRepo({ 'pom.xml': pom(jvmRoot + props(chain) + dep1('${p0}')) })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => [r.to, r.detail])).toEqual([['maven:x:lib', { version_expression: '${p0}' }]])
      expect(partialSymbols(db, 'pom.xml')).toBe('partial')
    })
  }, 120000)

  it('FR153 a property that refers to itself 3 times is left as written and the file is partial', async () => {
    const { dataDir } = await indexedRepo({ 'pom.xml': pom(jvmRoot + props({ s: '${s}'.repeat(3) }) + dep1('${s}')) })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => r.detail)).toEqual([{ version_expression: '${s}' }])
      expect(partialSymbols(db, 'pom.xml')).toBe('partial')
    })
  }, 120000)

  it('FR153 a property that refers to itself 30 times finishes, is left as written, and the file is partial', async () => {
    const { dataDir } = await indexedRepo({ 'pom.xml': pom(jvmRoot + props({ s: '${s}'.repeat(30) }) + dep1('${s}')) })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => r.detail)).toEqual([{ version_expression: '${s}' }])
      expect(partialSymbols(db, 'pom.xml')).toBe('partial')
    })
  }, 120000)

  it('FR153 a three-property cycle leaves the value exactly as written, not an arbitrary member of the cycle', async () => {
    const { dataDir } = await indexedRepo({ 'pom.xml': pom(jvmRoot + props({ a: '${b}', b: '${c}', c: '${a}' }) + dep1('${a}')) })
    withSnapshot(dataDir, (db) => expect(rows(db, 'depends_on_package').map((r) => r.detail)).toEqual([{ version_expression: '${a}' }]))
  }, 120000)

  it('FR153 names of Object.prototype are not properties: ${constructor} and ${toString} stay as written', async () => {
    const { dataDir } = await indexedRepo({ 'pom.xml': pom(jvmRoot + dep1('${constructor}-${toString}')) })
    withSnapshot(dataDir, (db) => expect(rows(db, 'depends_on_package').map((r) => r.detail)).toEqual([{ version_expression: '${constructor}-${toString}' }]))
  }, 120000)

  it('FR153 ${project.version} and ${project.parent.version} are the version the pom or its parent states; a missing parent and a parent cycle do not stop the read', async () => {
    const { dataDir } = await indexedRepo({
      'k/pom.xml': pom('  <artifactId>k</artifactId>\n  <dependencies><dependency><groupId>x</groupId><artifactId>one</artifactId><version>${project.version}</version></dependency><dependency><groupId>x</groupId><artifactId>two</artifactId><version>${project.parent.version}</version></dependency></dependencies>\n', '  <parent><groupId>g</groupId><artifactId>r</artifactId><version>7.1</version><relativePath>../nowhere/pom.xml</relativePath></parent>\n'),
      'c1/pom.xml': pom('  <artifactId>c1</artifactId>\n' + dep1('${nope}'), '  <parent><groupId>g</groupId><artifactId>c2</artifactId><version>1</version><relativePath>../c2/pom.xml</relativePath></parent>\n'),
      'c2/pom.xml': pom('  <artifactId>c2</artifactId>\n', '  <parent><groupId>g</groupId><artifactId>c1</artifactId><version>1</version><relativePath>../c1/pom.xml</relativePath></parent>\n'),
    })
    withSnapshot(dataDir, (db) => {
      expect(rows(db, 'depends_on_package').map((r) => [r.from, r.to, r.detail])).toEqual([
        ['g:c1', 'maven:x:lib', { version_expression: '${nope}' }],
        ['g:k', 'maven:x:one', { version: '7.1' }],
        ['g:k', 'maven:x:two', { version: '7.1' }],
      ])
    })
  }, 120000)

  it('FR159 a numeric character reference to no XML character fails that pom as invalid_xml, and the other build files are still read', async () => {
    const { dataDir } = await indexedRepo({
      'a/pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>a&#x110000;</artifactId>\n'),
      'b/pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>b&#xD800;</artifactId>\n'),
      'c/pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>c&#0;</artifactId>\n'),
      'd/pom.xml': pom('  <groupId>g</groupId>\n  <artifactId>d&#65;</artifactId>\n'),
    })
    withSnapshot(dataDir, (db) => {
      expect(db.prepare("select path, disposition, disposition_detail from file where path like '%pom.xml' order by path").all()).toEqual([
        { path: 'a/pom.xml', disposition: 'failed', disposition_detail: expect.stringMatching(/^invalid_xml:line 4\b/) },
        { path: 'b/pom.xml', disposition: 'failed', disposition_detail: expect.stringMatching(/^invalid_xml:line 4\b/) },
        { path: 'c/pom.xml', disposition: 'failed', disposition_detail: expect.stringMatching(/^invalid_xml:line 4\b/) },
        { path: 'd/pom.xml', disposition: 'indexed', disposition_detail: null },
      ])
      expect((projects(db) as Array<{ name: string }>).map((p) => p.name)).toEqual(['g:dA'])
    })
  }, 240000)

  it('FR159 elements nested past the depth cap fail that pom cleanly, and a pom just inside the cap is read', async () => {
    const nest = (n: number) => '<project><groupId>g</groupId><artifactId>deep</artifactId>' + '<x>'.repeat(n) + '</x>'.repeat(n) + '</project>\n'
    const { dataDir } = await indexedRepo({ 'ok/pom.xml': nest(150), 'deep/pom.xml': nest(250) })
    withSnapshot(dataDir, (db) => {
      expect(db.prepare("select path, disposition, disposition_detail from file where path like '%pom.xml' order by path").all()).toEqual([
        { path: 'deep/pom.xml', disposition: 'failed', disposition_detail: expect.stringMatching(/^invalid_xml:line 1: elements nested deeper than 200/) },
        { path: 'ok/pom.xml', disposition: 'indexed', disposition_detail: null },
      ])
    })
  }, 240000)

  it('FR154 an include in a comment or in a string declares nothing, in Groovy and in Kotlin', async () => {
    const { dataDir } = await indexedRepo({
      'settings.gradle': "// include ':commented'\n/* include ':blocked' */\ndef s = \"include ':string'\"\ninclude ':real'\n",
      'k/settings.gradle.kts': '// include(":commented")\nval s = "include(\\":string\\")"\nval raw = """include(":raw")"""\ninclude(":real")\n',
    })
    withSnapshot(dataDir, (db) => {
      expect((projects(db) as Array<{ name: string; path: string }>).map((p) => [p.name, p.path])).toEqual([[':real', 'k/settings.gradle.kts'], [':real', 'settings.gradle']])
    })
  }, 240000)

  it('FR154 an include in a block, a closure or after a condition declares nothing and makes the settings partial; a top-level include still counts', async () => {
    const { dataDir } = await indexedRepo({
      'settings.gradle': "if (System.getenv('X')) {\n  include 'cond'\n}\n['a', 'b'].each { include it }\nif (true) include 'one'\npluginManagement { }\ninclude 'top'; include 'second'\n",
    })
    withSnapshot(dataDir, (db) => {
      expect((projects(db) as Array<{ name: string }>).map((p) => p.name)).toEqual([':second', ':top'])
      expect(partialSymbols(db, 'settings.gradle')).toBe('partial')
    })
  }, 240000)
})

describe('FR156 FR160 Gradle routing and the scripts nothing includes', () => {
  it('FR160 settings.gradle.kts and build.gradle.kts are build manifests: indexed, and no Kotlin symbols come from them', async () => {
    const { dataDir } = await indexedRepo({
      'settings.gradle.kts': 'fun helper(): String = "x"\ninclude(":app")\n',
      'app/build.gradle.kts': 'fun configure(): Int = 1\nclass Local\ndependencies {\n    implementation("g:a:1")\n}\n',
      'app/Helper.kt': 'fun real(): Int = 2\n',
    })
    withSnapshot(dataDir, (db) => {
      expect(db.prepare("select path, disposition, language from file where path like '%.kts' order by path").all()).toEqual([
        { path: 'app/build.gradle.kts', disposition: 'indexed', language: 'build' },
        { path: 'settings.gradle.kts', disposition: 'indexed', language: 'build' },
      ])
      // The positive control: Kotlin source still gets its symbols, so the absence of any from the scripts is not an empty index.
      expect(db.prepare("select f.path, s.name from symbol s join file f on f.id = s.file_id where s.kind in ('function', 'class') order by f.path, s.name").all()).toEqual([{ path: 'app/Helper.kt', name: 'real' }])
      expect(rows(db, 'depends_on_package').map((r) => r.to)).toEqual(['maven:g:a'])
    })
  }, 240000)

  it('FR156 a build script no settings include owns is reported partial, with a diagnostic naming why, not skipped silently', async () => {
    const { repo, dataDir } = await indexedRepo({
      'settings.gradle': "include 'a'\n",
      'a/build.gradle': "dependencies {\n    implementation 'g:a:1'\n}\n",
      'orphan/build.gradle': "dependencies {\n    implementation 'g:orphan:1'\n}\n",
    })
    withSnapshot(dataDir, (db) => {
      expect(partialSymbols(db, 'orphan/build.gradle')).toBe('partial')
      expect(partialSymbols(db, 'a/build.gradle')).toBe('complete')
      expect(rows(db, 'depends_on_package').map((r) => r.to)).toEqual(['maven:g:a'])
    })
    const entry = BUILT_IN.find((x) => x.id === 'build')!.entry()!
    const req = (id: number, method: string, params: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const files = ['settings.gradle', 'a/build.gradle', 'orphan/build.gradle'].map((p) => ({ path: p, language: 'build' }))
    const out = spawnSync(process.execPath, [entry], { input: [req(1, 'initialize', { workspace: repo, files }), req(2, 'workspace', {}), req(3, 'shutdown', {})].join('\n') + '\n', encoding: 'utf8' })
    const workspace = out.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2)
    expect(workspace.result.diagnostics).toEqual([{ level: 'warning', path: 'orphan/build.gradle', message: expect.stringMatching(/no settings script includes a project in this directory/) }])
  }, 240000)
})

describe('FR158 FR079 a build file that would write a marker if it ran leaves none', () => {
  it('FR158 issue 13 scenario 6: the exec plugin, the Gradle task and the top-level Gradle statement are read, never run, and no JVM or build tool starts', async () => {
    const repo = tmpDir('pm-jvm-sentinel-')
    fs.cpSync(fixtureRepo('build-graph-jvm'), repo, { recursive: true })
    // A positive control: the same files are read (their projects exist), so an empty marker list is not an empty index.
    const { dataDir } = await indexedDataDir(repo)
    expect(withSnapshot(dataDir, (db) => (projects(db) as Array<{ name: string }>).map((p) => p.name))).toEqual([':app', ':lib', 'com.acme:core', 'com.acme:shop', 'com.acme:web'])
    const markers: string[] = []
    const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(dir, e.name)); else if (e.name.startsWith('MARKER')) markers.push(path.join(dir, e.name)) } }
    walk(repo)
    expect(markers).toEqual([])
    expect(fs.existsSync(path.join(repo, 'maven', 'web', 'target'))).toBe(false)
    expect(fs.existsSync(path.join(repo, 'gradle', '.gradle'))).toBe(false)
  }, 240000)
})
