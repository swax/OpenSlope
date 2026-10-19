import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const forbidden = [
  /ssx[\s_-]*library/i,
  /snowknife/i,
  /\b(?:TrickyLevelInterface|OldShapeHandler|PatchesJsonHandler|BezierUtil|StreamUtil|ArrayConv|VectorConv|PBDHandler|SSFHandler|BIGF4|COFB|ProcessedToMidEq\d+|MidToRawEq\d+|GenerateRawPoints|GenerateProcessedPoints)\b/i,
];

export function auditNativeSources(files) {
  const findings = [];
  for (const [path, content] of Object.entries(files)) {
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (forbidden.some(pattern => pattern.test(line)) || forbidden.some(pattern => pattern.test(path))) {
        findings.push(`${path}:${index + 1}: legacy component reference or decoder identifier`);
      }
    }
  }
  return findings;
}

export function checkNativeSourceBoundary() {
  // Git's ignore rules exclude SDKs, generated headers, build trees and APKs.
  // Include new source files before they have been staged as well as tracked files.
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'Native/'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
  const paths = [...new Set(result.stdout.split('\0').filter(path => path && existsSync(resolve(root, path))))];
  const files = Object.fromEntries(paths.map(path => [path, readFileSync(resolve(root, path), 'utf8')]));
  const findings = auditNativeSources(files);
  if (findings.length) throw new Error(`Native source boundary failed:\n${findings.join('\n')}`);
  console.log(`Native source boundary: ${paths.length} files checked, no forbidden references.`);
  // This checks references and known identifiers. Unnamed copying requires a
  // provenance review; a passing text check cannot establish authorship.
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkNativeSourceBoundary();
