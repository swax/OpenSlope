#!/usr/bin/env bash
# Run from the repository root after building the complete Unix desktop player.
set -euo pipefail
complete=false
work=
cleanup() {
  status=$?
  if [[ -n "$work" ]]; then rm -rf -- "$work"; fi
  if [[ "$complete" != true && "$status" == 0 ]]; then
    echo 'Desktop smoke did not finish.' >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
player="$(cd "$1" && pwd)/openslope_player"
# Bash 3.2 on macOS treats an empty array as unset under nounset.
display=(env)
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
  cd "$work"
  "${display[@]}" "$player" --smoke-window --seconds 1 --no-audio --no-ray-tracing --render-scale 100 --msaa 1 --snow 0
  "${display[@]}" "$player" --library-empty-smoke --library-root "$work" --no-audio --no-ray-tracing --render-scale 100 --msaa 1 --snow 0
fi
SDL_AUDIODRIVER=dummy "$player" --audio-smoke
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "graphics_smoke=$render" >> "$GITHUB_OUTPUT"
fi
complete=true
