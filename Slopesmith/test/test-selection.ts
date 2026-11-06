import ts from 'typescript';

export type TestEnvironment = 'node' | 'dom' | 'api' | 'browser';
export type EnvironmentSelection = TestEnvironment | 'non-browser' | 'all';

/** Browser discovery follows the actual launcher import, including tests without "browser" in their name. */
export function testEnvironment(source: string): TestEnvironment {
  const marker = source.split(/\r?\n/, 20).find(line => /^\/\/\s*environment:/.test(line));
  const declared = marker?.replace(/^\/\/\s*environment:\s*/, '').trim();
  const imports = ts
    .createSourceFile('test.ts', source, ts.ScriptTarget.Latest, false)
    .statements.filter(ts.isImportDeclaration);
  const modules = imports.map(statement => (statement.moduleSpecifier as ts.StringLiteral).text);
  const launchesBrowser = imports.some(statement => {
    if (
      (statement.moduleSpecifier as ts.StringLiteral).text !== 'playwright-core' ||
      statement.importClause?.isTypeOnly
    )
      return false;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.name || (bindings && ts.isNamespaceImport(bindings))) return true;
    return (
      bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        binding =>
          !binding.isTypeOnly &&
          ['chromium', 'firefox', 'webkit'].includes((binding.propertyName ?? binding.name).text),
      )
    );
  });
  if (declared && !['node', 'dom', 'api', 'browser'].includes(declared))
    throw new Error(`Unknown test environment: ${declared}`);
  if (launchesBrowser && declared && declared !== 'browser')
    throw new Error(`Browser launcher cannot be classified as ${declared}`);
  if (declared) return declared as TestEnvironment;
  if (launchesBrowser) return 'browser';
  return modules.some(name => /src\/server\/(main|api\/server)$/.test(name) || name.endsWith('/http-test-support'))
    ? 'api'
    : 'node';
}

export function matchesEnvironment(actual: TestEnvironment, requested: EnvironmentSelection): boolean {
  return requested === 'all' || (requested === 'non-browser' ? actual !== 'browser' : actual === requested);
}

/** File names are exact; area names retain the existing substring convenience. */
export function matchesFilter(name: string, filter: string): boolean {
  const normalized = filter.replaceAll('\\', '/').replace(/^test\//, '');
  return normalized.endsWith('.test.ts') ? name === normalized : name.includes(normalized);
}

export function browserSmoke(source: string): boolean {
  return source.split(/\r?\n/, 20).some(line => /^\/\/\s*browser:\s*smoke\s*$/.test(line));
}

export interface TestRunRecord {
  outcomes: { label: string; ok: boolean }[];
  running: string[];
  pending: string[];
}

/** A retry is explicitly a focused run; previously passing checks are never reported as newly verified. */
export function unfinishedTests(record: TestRunRecord): Set<string> {
  return new Set([
    ...record.outcomes.filter(outcome => !outcome.ok).map(outcome => outcome.label),
    ...record.running,
    ...record.pending,
  ]);
}
