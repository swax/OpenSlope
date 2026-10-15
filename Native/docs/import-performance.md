# ISO import performance

The native importer now avoids repeated audio buffer copies, unnecessary archive
decompression during discovery, slow PNG checksum loops, duplicate instance-table
parsing during validation, and the second complete asset copy when publishing an
import into the app's local Maps folder.

Course A and Course B are anonymous labels for the two measured samples. Command
examples use generic course, ISO, and audio-member placeholders; substitute values
from your own local inputs.

## Windows measurements — October 14, 2026

These are Windows x64 Release measurements of the production native importer,
using a user-supplied compatible ISO. Subsequent on-device Quest measurements are
reported separately below.

The baseline is `d40212c` with only the benchmark target added. Both binaries use
MSVC 19.44 with `/O2 /Ob2 /DNDEBUG`. Five baseline/candidate runs alternate order
for each operation on the same host and ISO, without builds running concurrently.
These are warm filesystem-cache measurements, not controlled cold-storage tests.
Extraction includes all audio, source sidecars, and final production validation.
It excludes the Android host's publication step. Output inventory and hashing run
after the measured interval.

| Operation | Baseline median | Optimized median | Time reduction |
| --- | ---: | ---: | ---: |
| Discover all 11 courses | 194.4 ms | 83.2 ms | 57.2% |
| Extract Course A | 7.513 s | 5.624 s | 25.1% |
| Extract Course B | 5.261 s | 4.340 s | 17.5% |

Observed extraction ranges were 6.733–7.727 s versus 5.490–6.948 s for Course A,
and 4.887–6.546 s versus 3.847–4.835 s for Course B. Host scheduling and filesystem
work cause variation; the comparison uses medians of the alternating runs.

Discovery reads fell from **42,948,722 to 14,386,443 bytes**. Extraction reads and
outputs are unchanged:

| Course | Output files | Output bytes | Verification |
| --- | ---: | ---: | --- |
| Course A | 3,062 | 381,613,845 | All SHA-256 hashes match in every baseline/candidate run |
| Course B | 2,003 | 320,844,946 | All SHA-256 hashes match in every baseline/candidate run |

Local Android imports now extract into a hidden directory on the Maps filesystem
and publish with one rename. This removes an additional 381.6 MB / 320.8 MB copy
for these courses. That saving is outside the native timings above. A folder
selected through SAF continues to use provider copying and publication checks.

Private raw timings, output manifests, and extracted assets remain in the ignored
`temp/import-performance/` folder. No disc-derived files are part of this report.

## Quest 3 measurements — October 14, 2026

The same baseline and optimized source were built for Android ARM64 with NDK
28.1.13356709, API 29, and Release `-O3 -DNDEBUG`. Both binaries ran directly on
the connected Quest 3 (Android 14), using the same user-supplied ISO already on
the headset. Five runs per version alternate order,
with output hashing outside the measured interval. Outputs use fresh isolated
directories on the app's external-files filesystem, beside its Maps folder.
Android reported thermal status 0 before and after the native measurements.

| Native operation | Baseline median | Optimized median | Time reduction |
| --- | ---: | ---: | ---: |
| Discover all 11 courses | 322.6 ms | 118.8 ms | 63.2% |
| Extract Course A | 11.315 s | 6.655 s | 41.2% |
| Extract Course B | 8.403 s | 5.066 s | 39.7% |

Course A ranged from 10.358–11.497 s before and 6.210–7.154 s after; Course B ranged
from 7.881–8.997 s before and 4.864–5.136 s after. All 3,062 Course A files and 2,003
Course B files match the ARM64 baseline byte for byte in every pair. The optimized
first Course A probe, before the paired series, took 6.830 s.

Music conversion accounts for most of the improvement: its Course A median fell from
6.920 to 3.247 s, and Course B from 5.645 to 2.779 s. Final map validation fell from
2.058 to 1.601 s for Course A and 1.165 to 0.910 s for Course B.

The production local publication methods were also timed separately under Android
ART using `tools/ImportPublicationBenchmark.java`, without updating the installed
app. For the full Course A sample, five alternating runs measured:

| Local publication method | Median | Range |
| --- | ---: | ---: |
| Existing copy from internal staging to external Maps | 872.7 ms | 866.6–939.7 ms |
| Publish an already extracted external staging folder by rename | 0.373 ms | 0.354–0.398 ms |

Publication fixture setup is outside that interval: the optimized importer writes
directly into the destination filesystem during extraction. Every publication run
checks file count and byte size; the first copy and rename outputs also match all
3,062 SHA-256 hashes. The 16 local publication correctness checks passed on the
Quest's ART runtime as well as the host JVM.

These native and publication measurements do **not** include the picker, JNI
callbacks, UI scheduling, or SAF provider calls, and should not be added together
as a measured full-app total. The installed launcher was v0.22.0; the native
comparison uses the source baseline at `d40212c` and the optimized working tree.
Existing installed code, preferences, and courses were kept. Generated device
benchmark folders are removed after collecting evidence.

Private raw data is in `temp/import-performance/quest/summary.json`,
`publication.json`, per-run stage timings and hash manifests, and thermal snapshots.

## Iterations and remaining cost

1. **Audio allocation:** geometric capacity growth replaces an exact `reserve`
   for every streamed block. This removes quadratic copying while retaining the
   existing decoded clip capacity limit.
2. **Discovery:** validate the complete BIG index and duplicate leaf names, then
   decode only the course PBD for format validation. Full extraction still decodes
   and validates every member.
3. **PNG writing:** table-based CRC, bounded batched Adler sums, and one output
   reservation retain identical PNG bytes. Median terrain texture writing fell
   from 153 to 87 ms for Course A and 289 to 140 ms for Course B.
4. **Audio conversion:** fill sized channel/interleaved buffers directly and use
   bounded halfway-away-from-zero WAV quantization. An alternating song benchmark
   over 40,352,130 samples measured roughly 20% less decoder time and 14% less WAV
   writing time for these changes individually. In the complete final runs, median
   music conversion fell from 3.640 to 2.460 s for Course A and 2.913 to 2.148 s for Course B.
5. **Validation:** collision and world logic reuse their already parsed instance
   rows when computing placements. World logic also retains its parsed document
   instead of copying the instance subtree.
6. **Android publication:** consume only owned staging folders inside the local
   Maps root. Cancellation and existing destinations leave staging unpublished;
   the caller removes it in its existing cleanup path. The general `publish`
   method retains its reusable-source behavior.

The remaining native time is spread across required audio decoding/writing,
object conversion, and validation. The next useful measurements are the complete
app's JNI/UI progress traffic, SAF publication when that destination is selected,
and peak memory. Parallel conversion or a different on-disk format would trade
memory, CPU, and I/O and should be evaluated with those device measurements.

## Repeat the benchmark

`openslope_import_benchmark` builds alongside the core tools. Each extraction
requires a new destination directory. The Python driver preserves output hashes,
raw stage timings, ISO read counts/bytes, output size/count, and summary medians:

```powershell
python Native/tools/benchmark_import.py temp/native-core/Release/openslope_import_benchmark.exe "discs/disc.iso" temp/import-measurement --courses COURSE_NAME_1 COURSE_NAME_2 --runs 5
```

To compare versions, retain a benchmark executable before changing the importer
and pass `--reference-executable <baseline.exe>`. The driver alternates versions
and fails if course lists or any output hash differ. The local comparison for
this report used `temp/import-performance/baseline.exe` and
`temp/import-performance/final.exe`; its report is
`temp/import-performance/final-paired/summary.json`.

For a single native run or narrower profiling:

```powershell
temp/native-core/Release/openslope_import_benchmark.exe "discs/disc.iso"
temp/native-core/Release/openslope_import_benchmark.exe "discs/disc.iso" COURSE_NAME temp/new-course-import
temp/native-core/Release/openslope_import_benchmark.exe --validate temp/new-course-import
temp/native-core/Release/openslope_import_benchmark.exe --music "discs/disc.iso" data/audio/SONG_NAME.mpf data/audio/SONG_NAME.mus temp/new-song-profile
```

The same target builds with the Android NDK (`ANDROID_ABI=arm64-v8a`, API 29+,
`OPENSLOPE_BUILD_PLAYER=OFF`, `OPENSLOPE_BUILD_TESTS=OFF`). With a local, shell-readable
ISO on the headset, run that binary through ADB:

```text
adb push <arm64-build>/openslope_import_benchmark /data/local/tmp/openslope_import_benchmark
adb shell chmod 755 /data/local/tmp/openslope_import_benchmark
adb shell /data/local/tmp/openslope_import_benchmark /sdcard/Download/disc.iso
adb shell /data/local/tmp/openslope_import_benchmark /sdcard/Download/disc.iso COURSE_NAME /data/local/tmp/new-course-import
```

This measures the native core. Measuring the complete picker/JNI/SAF path requires
an instrumented app run.

For the local publication benchmark, compile `MapLibrary.java` and
`tools/ImportPublicationBenchmark.java` against `android.jar`, package their class
files with `jar`, then use the SDK's `lib/d8.jar` to generate `classes.dex` with
minimum API 29. Push the DEX to a fresh device work folder, make it read-only,
and invoke:

```text
adb shell CLASSPATH=<device-work>/classes.dex app_process /system/bin org.openslope.nativeplayer.ImportPublicationBenchmark <extracted-course> <new-internal-work> <new-external-Maps>
```

It runs five alternating copy/rename timings using production `MapLibrary`
methods. Source fixture copying is excluded from publication time. All three
paths should point to private benchmark assets, and both work directories must
be new.

## Verification

- All 34 portable Release CTest checks pass, including multi-block audio,
  independently checked PNG CRC/zlib output, malformed input, cancellation,
  existing-course protection, and collision/world-logic behavior.
- The discovery fixture includes a 4 MiB unrelated member and requires actual
  production ISO reads below 32 KiB. Duplicate basename rejection is retained.
- WAV checks cover all 65,536 PCM16 values, clipping, signed zero, half ties, and
  buffer boundaries. PNG checks include worst-case Adler sums and multiple stored
  DEFLATE blocks. A 1,031-block audio fixture checks capacity growth and WAV buffers.
- Android ARM64 core and benchmark build with the NDK and warnings as errors.
- Both ARM64 source versions ran on Quest 3; all five paired course-output hash
  comparisons passed.
- Main and instrumentation Java sources compile against Android API 35. The host
  JVM executes 16 local-publication checks covering rename consumption, byte
  preservation, cancellation, existing destinations, and staging ownership.
- The same 16 filesystem checks pass under Android ART on the Quest, and timed
  copy/rename publication outputs have matching hashes.
- Added headset instrumentation checks compile; they have not been run on Quest
  in this session. The SAF publication path retains its existing device
  instrumentation; those checks also await a rerun on the headset.

The host filesystem check can run with `MapLibrary.java` and
`tests/LocalImportPublicationTest.java` compiled against `android.jar`, followed by
`java -cp <classes><path-separator><android.jar> org.openslope.nativeplayer.LocalImportPublicationTest <new-test-directory>`.
