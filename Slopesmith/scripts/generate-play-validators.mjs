import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020.js').default;
const standalone = require('ajv/dist/standalone').default;
const schemas = JSON.parse(readFileSync(new URL('../multiplayer/protocol.schema.json', import.meta.url), 'utf8'));
// Schemars numeric formats document Rust widths; minimum/maximum carry the actual JSON constraints.
const ajv = new Ajv({ code: { source: true, esm: true }, strict: true, allowUnionTypes: true, validateFormats: false });
const exports = {};
for (const [name, schema] of Object.entries(schemas)) {
  ajv.addSchema(schema, name);
  exports[`validate${name}`] = name;
}
const source = `// Generated from the Rust protocol schema. Do not edit.\n${standalone(ajv, exports)}\n`;
const declarations =
  `// Generated from the Rust protocol schema. Do not edit.\nimport type { ${Object.keys(schemas).join(', ')} } from './play-protocol.generated';\n` +
  Object.keys(schemas)
    .map(name => `export declare function validate${name}(value: unknown): value is ${name};`)
    .join('\n') +
  '\n';
for (const [name, content] of [
  ['play-validators.generated.js', source],
  ['play-validators.generated.d.ts', declarations],
]) {
  const path = new URL(`../src/core/session/${name}`, import.meta.url);
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== content) throw new Error(`Stale generated validator: ${fileURLToPath(path)}`);
  } else writeFileSync(path, content);
}
