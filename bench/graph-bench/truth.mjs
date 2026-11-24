// Ground truth for the code-graph benchmark, from the TypeScript compiler's own checker (not from either tool).
// Usage: node truth.mjs <repo> <out.json>
// Writes: symbols (file, name, line, kind, exported), calls (caller -> callee with call-site line),
// refs (any non-declaration use of a repository symbol), and file imports (resolved by the compiler).
// Scope: every .ts/.mts/.tsx file the repository's tsconfig includes, outside node_modules, not .d.ts.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ts = require(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../node_modules/typescript'))

const [repo, out] = process.argv.slice(2)
if (!repo || !out) { console.error('usage: node truth.mjs <repo> <out.json>'); process.exit(2) }
const root = path.resolve(repo)
const cfgPath = path.join(root, 'tsconfig.json')
const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root)
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
const checker = program.getTypeChecker()
const rel = (f) => path.relative(root, f).split(path.sep).join('/')
const inRepo = (f) => f.startsWith(root + path.sep) && !f.includes(`${path.sep}node_modules${path.sep}`) && !f.endsWith('.d.ts') && !f.endsWith('.d.mts')
const files = program.getSourceFiles().filter((sf) => inRepo(sf.fileName))
const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line + 1

const symbols = new Map() // id -> {id,file,name,qname,line,kind,exported}
const declId = new Map() // declaration node -> id
function nameOfDecl(d) {
  if (d.name && (ts.isIdentifier(d.name) || ts.isPrivateIdentifier(d.name) || ts.isStringLiteral(d.name))) return d.name.text
  if (ts.isConstructorDeclaration(d)) return 'constructor'
  return null
}
function className(node) {
  for (let p = node.parent; p; p = p.parent) {
    if ((ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name) return p.name.text
    if (ts.isInterfaceDeclaration(p)) return p.name.text
    if (ts.isObjectLiteralExpression(p)) {
      const v = p.parent
      if (v && ts.isVariableDeclaration(v) && ts.isIdentifier(v.name)) return v.name.text
      return null
    }
    if (ts.isSourceFile(p)) return null
  }
  return null
}
const isFnLike = (n) => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isMethodSignature(n)
function kindOf(d) {
  if (ts.isFunctionDeclaration(d)) return 'function'
  if (ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isConstructorDeclaration(d) || ts.isGetAccessor(d) || ts.isSetAccessor(d)) return 'method'
  if (ts.isClassDeclaration(d)) return 'class'
  if (ts.isInterfaceDeclaration(d)) return 'interface'
  if (ts.isTypeAliasDeclaration(d)) return 'type'
  if (ts.isEnumDeclaration(d)) return 'enum'
  if (ts.isVariableDeclaration(d)) {
    const i = d.initializer
    if (i && (ts.isArrowFunction(i) || ts.isFunctionExpression(i))) return 'function'
    return 'variable'
  }
  if (ts.isPropertyDeclaration(d) || ts.isPropertySignature(d) || ts.isPropertyAssignment(d)) {
    const i = d.initializer
    if (i && (ts.isArrowFunction(i) || ts.isFunctionExpression(i))) return 'method'
    return 'property'
  }
  return null
}
function isExported(d) {
  let n = d
  if (ts.isVariableDeclaration(n)) n = n.parent?.parent
  return !!(n && ts.canHaveModifiers?.(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
}
function register(d) {
  if (declId.has(d)) return declId.get(d)
  const sf = d.getSourceFile()
  if (!inRepo(sf.fileName)) return null
  const kind = kindOf(d)
  const name = nameOfDecl(d)
  if (!kind || !name) return null
  // only module-level variables, class members and object-literal members of module-level consts
  if (kind === 'variable' && !(d.parent?.parent?.parent && ts.isSourceFile(d.parent.parent.parent))) return null
  if (ts.isVariableDeclaration(d) && !(d.parent?.parent?.parent && ts.isSourceFile(d.parent.parent.parent))) return null
  const cls = ts.isVariableDeclaration(d) || ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isEnumDeclaration(d) ? null : className(d)
  const qname = cls ? `${cls}.${name}` : name
  const file = rel(sf.fileName)
  const line = lineOf(sf, (d.name ?? d).getStart(sf))
  const id = `${file}#${qname}@${line}`
  if (!symbols.has(id)) symbols.set(id, { id, file, name, qname, line, kind, exported: isExported(d) })
  declId.set(d, id)
  return id
}
function resolveSym(node) {
  let s = checker.getSymbolAtLocation(node)
  if (!s) return null
  if (s.flags & ts.SymbolFlags.Alias) { try { s = checker.getAliasedSymbol(s) } catch { return null } }
  return s
}
function targetOf(sym) {
  const d = sym?.valueDeclaration ?? sym?.declarations?.[0]
  return d ? register(d) : null
}
// The named symbol whose body holds `node`: the nearest function-like, or variable/property holding a function,
// skipping anonymous callbacks; module scope when none (the file itself).
function enclosing(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (isFnLike(p)) { const id = register(p); if (id) return id }
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent) {
      const h = p.parent
      if ((ts.isVariableDeclaration(h) || ts.isPropertyDeclaration(h) || ts.isPropertyAssignment(h)) && h.initializer === p) { const id = register(h); if (id) return id }
    }
    if (ts.isPropertyDeclaration(p) && p.initializer) { const id = register(p); if (id) return id }
    if (ts.isSourceFile(p)) return `${rel(p.fileName)}#<module>@0`
  }
  return null
}

const calls = [] // {caller, callee, file, line}
const refs = [] // {from, to, file, line}
const imports = [] // {from, to, line, typeOnly, dynamic}
const heritage = [] // {from, to, kind: implements|extends, file, line}
function resolveModule(spec, fromFile) {
  const r = ts.resolveModuleName(spec, fromFile, program.getCompilerOptions(), ts.sys)
  const f = r.resolvedModule?.resolvedFileName
  return f && inRepo(f) ? rel(f) : null
}

for (const sf of files) {
  const file = rel(sf.fileName)
  symbols.set(`${file}#<module>@0`, { id: `${file}#<module>@0`, file, name: '<module>', qname: '<module>', line: 0, kind: 'module', exported: false })
  const visit = (node) => {
    // declarations
    if (isFnLike(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) register(node)
    // imports
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const to = resolveModule(node.moduleSpecifier.text, sf.fileName)
      const typeOnly = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : !!node.isTypeOnly
      if (to) imports.push({ from: file, to, line: lineOf(sf, node.getStart(sf)), typeOnly, reexport: ts.isExportDeclaration(node), dynamic: false })
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const to = resolveModule(node.arguments[0].text, sf.fileName)
      if (to) imports.push({ from: file, to, line: lineOf(sf, node.getStart(sf)), typeOnly: false, reexport: false, dynamic: true })
    }
    // heritage: class implements / extends, interface extends
    if (ts.isHeritageClause(node) && (ts.isClassDeclaration(node.parent) || ts.isInterfaceDeclaration(node.parent))) {
      const from = register(node.parent)
      for (const t of node.types) {
        const to = targetOf(resolveSym(t.expression))
        if (from && to) heritage.push({ from, to, kind: node.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends', file, line: lineOf(sf, t.getStart(sf)) })
      }
    }
    // calls and constructions
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.expression.kind !== ts.SyntaxKind.ImportKeyword) {
      let e = node.expression
      while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression
      const at = ts.isPropertyAccessExpression(e) ? e.name : ts.isElementAccessExpression(e) ? e.argumentExpression : e
      const sym = resolveSym(at)
      let callee = targetOf(sym)
      if (callee && ts.isNewExpression(node)) {
        // new C() calls C's constructor when it declares one; count it against the class too
        callee = callee
      }
      const caller = enclosing(node)
      if (callee && caller) calls.push({ caller, callee, file, line: lineOf(sf, node.getStart(sf)), kind: ts.isNewExpression(node) ? 'new' : 'call' })
    }
    // references: identifiers that name a repository declaration, other than the declaration's own name
    if (ts.isIdentifier(node) && node.parent && !(node.parent.name === node && (kindOf(node.parent) || ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent)))) {
      const p = node.parent
      const inImport = ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)
      if (!inImport) {
        const sym = resolveSym(node)
        const to = targetOf(sym)
        if (to) {
          const from = enclosing(node)
          if (from && from !== to) refs.push({ from, to, file, line: lineOf(sf, node.getStart(sf)) })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

const data = { tool: 'typescript-checker', ts_version: ts.version, root, files: files.map((f) => rel(f.fileName)).sort(), symbols: [...symbols.values()], calls, refs, imports, heritage }
fs.writeFileSync(out, JSON.stringify(data))
console.log(`files ${data.files.length}, symbols ${data.symbols.length}, calls ${calls.length}, refs ${refs.length}, imports ${imports.length}, heritage ${heritage.length}`)
