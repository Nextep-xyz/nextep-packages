#!/usr/bin/env node
'use strict';
// Entrada de la CLI. El código vive compilado en dist/ (lo genera `pnpm build`; `prepack` lo hace antes de empaquetar).
const fs = require('fs');
const path = require('path');

const cli = path.join(__dirname, '..', 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('nextep-guardrails: falta dist/. Compile el paquete: pnpm --filter @nextep/cdk-guardrails build');
  process.exit(2);
}
process.exit(require(cli).main(process.argv.slice(2)));
