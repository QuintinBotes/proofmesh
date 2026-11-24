import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, tmpDir, withSnapshot } from './helpers.js'

const PULUMI = `export interface Output<T> { apply<U>(f: (value: T) => U): Output<U> }
export type Input<T> = T | Output<T>
export interface ResourceOptions { dependsOn?: Resource | Resource[]; parent?: Resource }
export interface CustomResourceOptions extends ResourceOptions {}
export interface ComponentResourceOptions extends ResourceOptions {}
export declare abstract class Resource { readonly urn: Output<string> }
export declare class CustomResource extends Resource { readonly id: Output<string>; constructor(type: string, name: string, args?: object, opts?: CustomResourceOptions) }
export declare class ComponentResource extends Resource { constructor(type: string, name: string, args?: object, opts?: ComponentResourceOptions) }
export declare class Config { require(key: string): string }
`
const AWS = `import * as pulumi from '@pulumi/pulumi'
export declare namespace s3 {
  class Bucket extends pulumi.CustomResource {
    readonly arn: pulumi.Output<string>; readonly bucket: pulumi.Output<string>; readonly websiteEndpoint: pulumi.Output<string>
    constructor(name: string, args?: { acl?: pulumi.Input<string>; loggings?: Array<{ targetBucket: pulumi.Input<string> }> }, opts?: pulumi.CustomResourceOptions)
  }
  class BucketPolicy extends pulumi.CustomResource {
    constructor(name: string, args: { bucket: pulumi.Input<string>; policy: pulumi.Input<string> }, opts?: pulumi.CustomResourceOptions)
  }
}
`

async function indexed() {
  const repo = tmpDir('pm-pulumi-')
  fs.cpSync(fixtureRepo('ts-pulumi'), repo, { recursive: true })
  for (const [name, version, types] of [['@pulumi/pulumi', '3.0.0', PULUMI], ['@pulumi/aws', '6.0.0', AWS]] as const) {
    fs.mkdirSync(path.join(repo, 'node_modules', name), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules', name, 'package.json'), JSON.stringify({ name, version, types: 'index.d.ts' }))
    fs.writeFileSync(path.join(repo, 'node_modules', name, 'index.d.ts'), types)
  }
  return (await indexedDataDir(repo)).dataDir
}

describe('A8 A25 Pulumi rules: a resource graph from TypeScript, as framework facts', () => {
  it('each resource a program constructs is a symbol named by its type and name, related to the resources it reads and depends on', async () => {
    const d = await indexed()
    expect(withSnapshot(d, (db) => db.prepare(`select qualified_name, name, signature, start_line, end_line from symbol where kind = 'resource' order by qualified_name`).all())).toEqual([
      { qualified_name: 'src/index:Site::www', name: 'www', signature: 'resource "Site"', start_line: 11, end_line: 11 },
      { qualified_name: 'src/index:aws.s3.Bucket::logs', name: 'logs', signature: 'resource "aws.s3.Bucket"', start_line: 6, end_line: 6 },
      { qualified_name: 'src/index:aws.s3.BucketPolicy::logs-policy', name: 'logs-policy', signature: 'resource "aws.s3.BucketPolicy"', start_line: 7, end_line: 10 },
      { qualified_name: 'src/site:aws.s3.Bucket::${name}-content', name: '${name}-content', signature: 'resource "aws.s3.Bucket"', start_line: 9, end_line: 9 },
    ])
    const facts = withSnapshot(d, (db) => db.prepare(`
      select a.type, s.qualified_name as src, t.qualified_name as dst, ev.start_line as line, ev.start_byte as start, ev.end_byte as end, f.path
      from assertion a join symbol s on s.id = a.source_id join symbol t on t.id = a.target_id
      join assertion_evidence ae on ae.assertion_id = a.id join evidence ev on ev.id = ae.evidence_id join file f on f.id = ev.file_id
      where a.origin = 'framework_adapter' and a.type in ('references', 'depends_on') order by f.path, ev.start_byte`).all() as Array<{ type: string; src: string; dst: string; line: number; start: number; end: number; path: string }>)
    const text = fs.readFileSync(path.join(fixtureRepo('ts-pulumi'), 'src/index.ts'), 'utf8')
    expect(facts.map((r) => [r.line, r.type, r.src, r.dst, text.slice(r.start, r.end)])).toEqual([
      [8, 'references', 'src/index:aws.s3.BucketPolicy::logs-policy', 'src/index:aws.s3.Bucket::logs', 'logs.id'],
      [9, 'references', 'src/index:aws.s3.BucketPolicy::logs-policy', 'src/index:aws.s3.Bucket::logs', 'logs.arn'],
      [10, 'depends_on', 'src/index:aws.s3.BucketPolicy::logs-policy', 'src/index:aws.s3.Bucket::logs', 'logs'],
      [11, 'references', 'src/index:Site::www', 'src/index:aws.s3.Bucket::logs', 'logs.bucket'],
    ])
    expect(new Set(facts.map((r) => r.path))).toEqual(new Set(['src/index.ts']))
    // References between resources and uses of repository types are reported, not every reference, so every file says references are partial (FR086).
    expect(withSnapshot(d, (db) => db.prepare(`select path, json_extract(capabilities, '$.references') as refs from file where language = 'typescript' order by path`).all())).toEqual([
      { path: 'src/index.ts', refs: 'partial' }, { path: 'src/site.ts', refs: 'partial' },
    ])
  }, 120000)
})
