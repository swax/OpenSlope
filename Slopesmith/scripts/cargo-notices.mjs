import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appRoot, cargo } from './multiplayer.mjs';

const metadata = JSON.parse(
  execFileSync(cargo, ['metadata', '--manifest-path', 'multiplayer/Cargo.toml', '--locked', '--format-version', '1'], {
    cwd: appRoot,
    encoding: 'utf8',
    windowsHide: true,
  }),
);
const output = join(appRoot, 'multiplayer', 'target', 'release', 'ThirdPartyNotices');
mkdirSync(output, { recursive: true });
const inventory = [];
function licenseFiles(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(file => {
    const name = join(prefix, file.name);
    if (file.isDirectory()) return licenseFiles(root, name);
    return /^(LICENSE|LICENCE|COPYING|NOTICE)(\b|[-_.])/i.test(file.name) ? [name] : [];
  });
}
for (const pkg of metadata.packages
  .filter(pkg => pkg.source)
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))) {
  let root = dirname(pkg.manifest_path);
  const directory = join(output, `${pkg.name}-${pkg.version}`);
  mkdirSync(directory, { recursive: true });
  let files = licenseFiles(root);
  if (pkg.license_file && !files.includes(pkg.license_file)) files.push(pkg.license_file);
  let licenseSource = pkg.name;
  if (!files.length) {
    // Some proc-macro tarballs omit the workspace-root license. Use its sibling's exact-version license
    // only when repository and declared license match; never synthesize a missing copyright notice.
    const owner = metadata.packages.find(
      other =>
        other.name !== pkg.name &&
        other.version === pkg.version &&
        other.repository &&
        other.repository === pkg.repository &&
        other.license === pkg.license &&
        licenseFiles(dirname(other.manifest_path)).length,
    );
    if (owner) {
      root = dirname(owner.manifest_path);
      files = licenseFiles(root);
      licenseSource = owner.name;
    }
  }
  if (
    !files.length &&
    ['ts-rs', 'ts-rs-macros'].includes(pkg.name) &&
    pkg.version === '12.0.1' &&
    pkg.repository === 'https://github.com/Aleph-Alpha/ts-rs'
  ) {
    const commit = '7182ad8289596097235406b715fa04506443b4ad';
    const vcs = JSON.parse(readFileSync(join(root, '.cargo_vcs_info.json'), 'utf8'));
    if (vcs.git?.sha1 !== commit) throw new Error('ts-rs source commit differs from its pinned license notice.');
    root = join(appRoot, 'ThirdPartyNotices');
    files = ['TsRs-LICENSE.txt'];
    licenseSource = `https://github.com/Aleph-Alpha/ts-rs/blob/${commit}/LICENSE`;
  }
  if (!files.length) throw new Error(`No distribution license found for ${pkg.name} ${pkg.version}`);
  for (const file of files) {
    readFileSync(join(root, file));
    copyFileSync(join(root, file), join(directory, file.replaceAll(/[\\/]/g, '_')));
  }
  inventory.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    repository: pkg.repository,
    licenseSource,
    files,
  });
}
writeFileSync(join(output, 'dependencies.json'), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Collected license notices for ${inventory.length} locked Rust dependencies.`);
