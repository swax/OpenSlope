# Shared by desktop, Android and the Slopesmith WebAssembly importer.
# Keep sources explicit so new game families have one build registration point.
target_sources(openslope_core PRIVATE
  # Shared orchestration and portable output.
  src/import/loader.cpp
  src/import/maps.cpp
  src/import/png.cpp

  # Game-independent disc and archive readers.
  src/import/containers/disc.cpp
  src/import/containers/iso9660.cpp
  src/import/containers/filesystem.cpp
  src/import/containers/big.cpp
  src/import/containers/pak.cpp
  src/import/containers/refpack.cpp
  src/import/containers/rvz.cpp
  src/import/containers/gamecube.cpp

  # 1080 Avalanche.
  src/import/avalanche/importer.cpp
  src/import/avalanche/course.cpp
  src/import/avalanche/music.cpp
  src/import/avalanche/lighting.cpp
  src/import/avalanche/props.cpp

  # Jonny Moseley Mad Trix.
  src/import/madtrix/importer.cpp
  src/import/madtrix/audio.cpp
  src/import/madtrix/music.cpp
  src/import/madtrix/props.cpp

  # SSX family registration and per-game conversion.
  src/import/ssx/importer.cpp
  src/import/ssx/original/course.cpp
  src/import/ssx/tricky/course.cpp
  src/import/ssx/streamed/course.cpp
  src/import/ssx/streamed/materials.cpp
  src/import/ssx/streamed/riding_audio.cpp
  src/import/ssx/streamed/ambient_audio.cpp
  src/import/ssx/streamed/playtest.cpp

  # Formats shared within the SSX family.
  src/import/ssx/common/patches.cpp
  src/import/ssx/common/textures.cpp
  src/import/ssx/common/crowd_import.cpp
  src/import/ssx/common/prop_import.cpp
  src/import/ssx/common/path_import.cpp
  src/import/ssx/common/collision_import.cpp
  src/import/ssx/common/logic_import.cpp
  src/import/ssx/common/rail_import.cpp
  src/import/ssx/common/audio_import.cpp
  src/import/ssx/common/world_import.cpp
  src/import/ssx/common/executable.cpp
  src/import/ssx/common/audio_resolver.cpp
)
target_include_directories(openslope_core PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_libraries(openslope_core PRIVATE openslope_zstd)
