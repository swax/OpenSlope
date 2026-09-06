// tier: fast

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const files: string[] = [];

function collect(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(normalize(path));
  }
}
collect(root);

const known = new Set(files);

function localModule(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  return [
    `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'),
  ].map(normalize).find(candidate => known.has(candidate)) ?? null;
}

/** Static imports and re-exports form the initialization and type-checking graph we keep acyclic. */
function dependencies(file: string): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  for (const statement of source.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const dependency = localModule(file, statement.moduleSpecifier.text);
    if (dependency) out.add(dependency);
  }
  return out;
}

const graph = new Map(files.map(file => [file, dependencies(file)]));

/** Tarjan strongly-connected components: every component larger than one is an import cycle. */
function cyclicComponents(): string[][] {
  let nextIndex = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const cycles: string[][] = [];

  function visit(file: string): void {
    index.set(file, nextIndex);
    lowLink.set(file, nextIndex++);
    stack.push(file);
    onStack.add(file);

    for (const dependency of graph.get(file) ?? []) {
      if (!index.has(dependency)) {
        visit(dependency);
        lowLink.set(file, Math.min(lowLink.get(file)!, lowLink.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLink.set(file, Math.min(lowLink.get(file)!, index.get(dependency)!));
      }
    }

    if (lowLink.get(file) !== index.get(file)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== file);
    if (component.length > 1 || graph.get(file)?.has(file)) cycles.push(component);
  }

  for (const file of files) if (!index.has(file)) visit(file);
  return cycles;
}

const cycles = cyclicComponents();
if (cycles.length) {
  for (const cycle of cycles) {
    console.error('FAIL import cycle:', cycle
      .map(file => relative(root, file).replaceAll('\\', '/')).sort().join(' <-> '));
  }
  process.exitCode = 1;
} else {
  console.log(`IMPORT CYCLES PASS (${files.length} source modules, 0 cycles)`);
}
