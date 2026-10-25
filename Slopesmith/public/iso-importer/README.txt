OpenSlope browser ISO importer

This JavaScript/WebAssembly runtime is compiled from Native/src/browser_import.cpp
and the existing OpenSlope Native import library. It contains no game assets.
OpenSlope Native is licensed under Apache-2.0; see the repository LICENSE.
The accompanying json-license.txt, lodepng-license.txt and zstd-license.txt cover linked dependencies.
Emscripten's runtime is distributed under MIT/University of Illinois/NCSA terms:
https://github.com/emscripten-core/emscripten/blob/main/LICENSE

Rebuild with Emscripten 6.0.12 and `npm run build:iso-importer` from Slopesmith.
The ordinary browser/server build uses these checked-in runtime artifacts, so
users and deploy hosts do not need a native toolchain.

The shared reader accepts all 25 single-player 1080 Avalanche USA layouts:
Crs00 Normal/Diamond, Crs01-Crs05 Normal/Hard/Expert/Diamond, and
Crs06 Normal/Expert/Diamond. Load them directly from
GameCube ISO/GCM or RVZ using NONE/Zstandard compression. Terrain, primary
textures, static scenery, collision, supported spawn and reset form the preview.
The world conversion corrects geometric and printed text handedness together.
Source props retain separate named placements. Baked scenery splits into connected
objects, with compound structures and foliage grouped conservatively. Authored
copies retain independent collision hulls and editable solid/decorative defaults;
tree canopies do not become trunk collision. The course stays a static reference.
Exact linear bases preserve sheared and reflected placements.
New imports also include source sky meshes with baked vertex colour/coverage,
approximate course lighting and adapted riding spray. Source shadows, emitter
programs, original event logic and animated hazards remain later work.
