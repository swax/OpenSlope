OpenSlope browser ISO importer

This JavaScript/WebAssembly runtime is compiled from Native/src/browser_import.cpp
and the existing OpenSlope Native import library. It contains no game assets.
OpenSlope Native is licensed under Apache-2.0; see the repository LICENSE.
The accompanying json-license.txt and lodepng-license.txt cover linked dependencies.
Emscripten's runtime is distributed under MIT/University of Illinois/NCSA terms:
https://github.com/emscripten-core/emscripten/blob/main/LICENSE

Rebuild with Emscripten 6.0.12 and `npm run build:iso-importer` from Slopesmith.
The ordinary browser/server build uses these checked-in runtime artifacts, so
users and deploy hosts do not need a native toolchain.
