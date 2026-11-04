#!/usr/bin/env bash
# Run from the repository root after building the complete Unix desktop player.
set -euo pipefail
player="$(cd "$1" && pwd)/openslope_player"
display=()
render=true
if [[ "$(uname -s)" == Darwin ]]; then
  player="$player.app/Contents/MacOS/openslope_player"
  # Standard hosted Mac VMs can lack a Metal device. Other failures remain fatal.
  status=0
  swift -e 'import CoreGraphics; import Metal; import Darwin; exit(MTLCreateSystemDefaultDevice() == nil ? 77 : 0)' || status=$?
  if [[ "$status" == 77 && "${GITHUB_ACTIONS:-}" == true ]]; then
    render=false
    echo '::notice::No Metal GPU on this Mac runner; graphics smoke needs a GPU-equipped Mac.'
  elif [[ "$status" != 0 ]]; then
    exit "$status"
  fi
else
  display=(xvfb-run -a)
fi
"$player" --help
if [[ "$render" == true ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf -- "$work"' EXIT
  cd "$work"
  "${display[@]}" "$player" --smoke-window --seconds 1 --no-audio --no-ray-tracing --render-scale 100 --msaa 1 --snow 0
  "${display[@]}" "$player" --library-empty-smoke --library-root "$work" --no-audio --no-ray-tracing --render-scale 100 --msaa 1 --snow 0
fi
SDL_AUDIODRIVER=dummy "$player" --audio-smoke
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "graphics_smoke=$render" >> "$GITHUB_OUTPUT"
fi
