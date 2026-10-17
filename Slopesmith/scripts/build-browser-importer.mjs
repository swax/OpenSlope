import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sdk = process.env.EMSDK || join(root, 'temp', 'emsdk');
const toolchain = join(sdk, 'upstream', 'emscripten', 'cmake', 'Modules', 'Platform', 'Emscripten.cmake');
if (!existsSync(toolchain)) throw new Error('Install and activate Emscripten 6.0.12, then set EMSDK to its directory.');
const visualStudioCmake =
  'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe';
const cmake = process.env.CMAKE || (existsSync(visualStudioCmake) ? visualStudioCmake : 'cmake');
const build = resolve(root, 'temp/browser-import');
const options = [
  '-S',
  join(root, 'Native'),
  '-B',
  build,
  '-G',
  'Ninja',
  `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DOPENSLOPE_BUILD_TESTS=OFF',
  '-DOPENSLOPE_BUILD_PLAYER=OFF',
];
if (cmake === visualStudioCmake)
  options.push(`-DCMAKE_MAKE_PROGRAM=${resolve(dirname(cmake), '../../Ninja/ninja.exe')}`);
for (const name of ['json', 'lodepng']) {
  const source = join(root, 'temp/native-core/_deps', `${name}-src`);
  if (existsSync(source)) options.push(`-DFETCHCONTENT_SOURCE_DIR_${name.toUpperCase()}=${source}`);
}
function run(args) {
  const result = spawnSync(cmake, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}
run(options);
run(['--build', build, '--target', 'openslope_browser_import', '--parallel', '4']);
const output = join(root, 'Slopesmith/public/iso-importer');
mkdirSync(output, { recursive: true });
for (const extension of ['js', 'wasm'])
  copyFileSync(
    join(build, `openslope_browser_import.${extension}`),
    join(output, `openslope_browser_import.${extension}`),
  );
function copyNotice(source, destination) {
  writeFileSync(
    destination,
    `${readFileSync(source, 'utf8')
      .replace(/[ \t]+$/gm, '')
      .trimEnd()}\n`,
  );
}
for (const name of ['json', 'lodepng'])
  copyNotice(join(root, 'Native/ThirdPartyNotices', `${name}.txt`), join(output, `${name}-license.txt`));
copyNotice(join(sdk, 'upstream/emscripten/LICENSE'), join(output, 'emscripten-license.txt'));
console.log('Built the browser ISO importer from Native and copied runtime files and notices.');
