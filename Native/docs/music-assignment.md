# Music assignment for game-wide catalogues

SSX 3, its preview, On Tour, Mad Trix and 1080 Avalanche import a stable share
of their game-wide catalogue for each map. This is OpenSlope playback policy;
it does not claim to recover original per-course music scheduling.

Maps are ordered by their source identifiers, independently of discovery or
import order. Songs retain their catalogue order. On Tour day/night variants
count as one base map and share the same songs.

For `N` songs and `M` maps, map index `i` receives song indices from
`floor(i*N/M)` through `floor((i+1)*N/M)-1`. This partitions the catalogue
evenly, with each song assigned once and playlist sizes differing by at most
one. When there are more maps than songs, each map instead gets song `i % N`.
For example, On Tour's 41 songs across 15 base routes give two or three songs
per route, while Mad Trix's twelve songs across eleven maps give one or two.

Assignment happens before audio conversion and cache restoration. Unassigned
songs are not decoded or copied into the map. Song cache identities remain
independent of map assignment, so repeated songs and variants reuse existing
conversions. Imported maps remain self-contained.

SSX songs with unsupported codecs remain reported as deferred. The importer
tries subsequent catalogue entries to fill the map's share with playable
music. Malformed data still fails conversion. `MusicImport.json` records the
assignment mode, base map, zero-based map/song indices and catalogue/map
counts; SSX also records the successfully imported song indices.

Tricky keeps its source course playlists. The explicit Avalanche soundtrack
export command still exports the complete catalogue.

Reload existing browser maps from their ISO to get the smaller playlists;
re-upload the refreshed reference to update a hosted map. Previously converted
songs can be reused from the shared cache. During playback, Random loads only
the chosen song for the run, with two-chunk lookahead for segmented music.

PC and Quest use the same assignment in their shared C++ importer. Existing
installed folders are preserved: import into a fresh native Maps folder to
receive the smaller playlists and updated effect assets. Native playback reads
only the chosen song's graph and current/next chunks; it does not preload the
other songs' decoded audio.
