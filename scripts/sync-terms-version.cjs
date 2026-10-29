const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');

const termPath = path.join(__dirname, '..', 'TERMO_DE_RESPONSABILIDADE.md');
const current = fs.readFileSync(termPath, 'utf8');
const updated = current.replace(
  /(\*\*Versão do software e deste termo:\s*)[\d.]+(\*\*)/,
  `$1${packageJson.version}$2`
);

if (updated === current && !current.includes(`**Versão do software e deste termo: ${packageJson.version}**`)) {
  throw new Error('Não encontrei a linha de versão do termo para sincronizar.');
}

if (updated !== current) fs.writeFileSync(termPath, updated, 'utf8');
console.log(`Termo sincronizado com PrintShot ${packageJson.version}.`);
