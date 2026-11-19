#!/usr/bin/env node
// Silence node:sqlite's ExperimentalWarning before the module is loaded; hook output must stay clean.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning?.message || '';
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type || warning?.name;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
  return originalEmitWarning.call(process, warning, ...rest);
};

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  if (process.argv[2] === 'hook') process.exit(0); // never break Claude Code
  console.error(`ccstore 需要 Node.js >= 22.13，当前是 ${process.versions.node}`);
  process.exit(1);
}

const { main } = await import('../src/cli.js');
await main(process.argv.slice(2));
