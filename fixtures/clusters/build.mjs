// Four groups span the same eight directories. Each imports its peers and the shared logger.
import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[2]
const dir = i => i === 7 ? 'tests' : 'layer' + i
const groups = ['amber', 'blue', 'green', 'red']
fs.mkdirSync(root, { recursive: true })
fs.writeFileSync(path.join(root, 'shared.ts'), 'export function log() { return 0 }\n')
fs.writeFileSync(path.join(root, 'alone.ts'), 'export function alone() { return 0 }\n')
for (const [g, name] of groups.entries()) {
  for (let i = 0; i < 8; i++) {
    const peers = Array.from({ length: 8 }, (_, j) => j).filter(j => j !== i)
    const imports = peers.map(j => `import { ${name}${j} } from '../${dir(j)}/${name}'`)
    const calls = peers.map(j => `${name}${j}()`)
    if (i === 0 && g > 0) {
      imports.push(`import { ${groups[g - 1]}1 } from '../layer1/${groups[g - 1]}'`)
      calls.push(`${groups[g - 1]}1()`)
    }
    fs.mkdirSync(path.join(root, dir(i)), { recursive: true })
    fs.writeFileSync(path.join(root, dir(i), name + '.ts'), [...imports, "import { log } from '../shared'", `export function ${name}${i}(): number { return log() + ${calls.join(' + ')} }`, ''].join('\n'))
  }
}
