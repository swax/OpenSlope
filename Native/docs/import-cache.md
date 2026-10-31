# Import sessions and converted music

`ImportSession` owns one normalized, seekable disc reader, a cached course/title catalogue,
and a bounded cache of source reads. ISO, BIN, GCM and RVZ use the same interface. Keeping the
logical reader alive also retains the RVZ decompression cache. The session serializes its
operations; its source-read cache holds at most 32 MiB or 2,048 extents.

Desktop libraries share up to two sessions across scans and queued imports. File size and
modification time invalidate an existing desktop session. Android retains up to two readers
using duplicated, owned file descriptors; descriptor identity, size and modification time
distinguish sources. The launcher closes them after outstanding work finishes when it is destroyed.
Browser imports retain up to two workers per page and serialize requests. Cancelling an active
request terminates its worker; a retry starts a clean session.

All six supported games use sessions. Music conversion is currently implemented for Tricky,
1080 Avalanche and Mad Trix. Original SSX, SSX 3 and On Tour retain their existing deferred music
status; they still benefit from reader, catalogue and browser write reuse.

## Music identity and publication

Each converted track has a SHA-256 key containing a versioned converter identity, conversion
settings and its complete source inputs. Tricky includes graph, stream, loop bank and song
settings; Avalanche includes ADP bytes and title metadata; Mad Trix includes its VAG resource
and voice identity. Filenames or disc size alone never identify reusable converted audio.
Change the converter version whenever its output policy changes.

A cache entry contains a manifest and its converted track files. The manifest lists each
relative path, length and SHA-256 digest. Reads verify every file and reject missing files,
extra files, links, invalid paths or modified bytes. Damaged entries are rebuilt from the disc.
Publishing uses a new staging directory and a completed manifest; cancelled or failed writes
cannot become cache hits. Cache write failures leave normal map import available.

Cache hits copy files into each map. Maps and exports remain self-contained, so deleting or
evicting a cache entry cannot change an installed map. The desktop cache lives under
`.openslope-cache/music-v1` beside the application; the import CLI places it under its chosen
Maps root. Android uses its private files directory under `import-cache/music-v1`.
Native caches retain up to 4 GiB of completed entries, evicting old entries first. Recently
used entries are protected while another process may be copying them. Abandoned staging
directories older than one hour are cleaned on the next publication.

## Browser storage

The worker asks for the selected map's track keys before conversion. It restores only those
entries from `slopesmith-import-music` into its temporary filesystem. Validated track files
are moved into the new map without a second filesystem copy; unchanged Blob data is reused
when saving that map. Newly converted music is persisted for future maps and page visits.

Map and music files are written in batches of up to 64 files or roughly 8 MiB; a larger file
uses its own batch. Completion records are committed last. Music publications use distinct
generations so an interrupted write never replaces a complete entry. Old generations are
removed after publication, and abandoned generations expire after one hour. The music store
retains at most 2 GiB or 128 completed entries. Unloading one map keeps the reusable music;
clearing all ISO maps also clears the music store and closes importer sessions.

`native_import_cache` checks hashing, corruption, cancellation, eviction and unavailable caches.
`native_import_sessions` exercises every game with authored fixtures and compares fresh,
warm and reopened output. Browser checks cover the same six families, worker reuse, fewer
write transactions, source changes with identical file metadata and same-size cache corruption.
