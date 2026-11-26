# Vendored packages

`tree-sitter-prisma-1.6.0.tgz` is the npm package `tree-sitter-prisma@1.6.0`
(integrity `sha512-w3rnsmW+XVVvLeIykMCU0Tevbg23s6xa8wiSrLw+WUTbIBBS47Ds4W9rX0yzPXXFRaOwFPAFooqdv8BQUQxTBA==`)
repacked with one file removed: `.vscode/settings.json` (`{"editor.formatOnSave": false}`).

Sandboxes that refuse writes to any `.vscode` folder (Claude Code's and Orbit's
sandbox runtime) cannot install the published package, so `pnpm install` fails
there. Nothing else changed: `build.mjs` reads only the package's `package.json`
and `LICENSE`, and the Prisma grammar is the committed `grammars/prisma.wasm`,
checked by hash against `grammars/built.json`.

To upgrade: `npm pack tree-sitter-prisma@<version>`, check its integrity against
the registry, extract it, delete `package/.vscode`, run
`npm pack <dir> --ignore-scripts`, and replace the tarball here.
