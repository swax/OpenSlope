package org.openslope.nativeplayer;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import android.provider.DocumentsContract;
import java.io.*;
import java.lang.reflect.*;
import java.util.*;
import org.json.*;

/** No test-framework dependency; run with adb shell am instrument -w <test-package>/<runner>. */
public final class NativeImportInstrumentation extends Instrumentation {

    private int checks;
    private Bundle arguments;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        this.arguments = arguments;
        start();
    }

    private void require(boolean condition, String message) {
        ++checks;
        if (!condition) throw new AssertionError(message);
    }

    private Object invoke(LauncherActivity activity, String name, Class<?>[] types, Object... values) throws Exception {
        Method method = LauncherActivity.class.getDeclaredMethod(name, types);
        method.setAccessible(true);
        try {
            return method.invoke(activity, values);
        } catch (InvocationTargetException e) {
            throw new IOException(e.getCause().getMessage(), e.getCause());
        }
    }

    private void libraryIdle(LauncherActivity activity) throws Exception {
        Field busy = LauncherActivity.class.getDeclaredField("busy");
        busy.setAccessible(true);
        for (int i = 0; i < 300; ++i) {
            waitForIdleSync();
            if (!busy.getBoolean(activity)) return;
            Thread.sleep(100);
        }
        throw new IOException("Library worker did not finish");
    }

    private void multiDiscImport(LauncherActivity activity, File temporary, File tricky) throws Exception {
        libraryIdle(activity);
        File ssx = new File(temporary, "ssx-fixture.bin"),
            broken = new File(temporary, "broken.iso");
        try (
            InputStream input = getContext().getAssets().open("ssx-fixture.bin");
            OutputStream output = new FileOutputStream(ssx)
        ) {
            MapLibrary.copy(input, output, MapLibrary.FILE_LIMIT, () -> {});
        }
        require(broken.createNewFile(), "Unreadable batch source created");
        File root = new File(temporary, "multi-disc-maps"),
            existing = new File(root, "GARI");
        require(existing.mkdirs(), "Isolated multi-disc library created");
        try (Writer file = new FileWriter(new File(existing, "Patches.json"))) {
            file.write("{}");
        }
        try (Writer file = new FileWriter(new File(existing, "keep-local.txt"))) {
            file.write("local edits");
        }
        MapLibrary batch = new MapLibrary(getTargetContext().getContentResolver(), root, null);
        Field field = LauncherActivity.class.getDeclaredField("library");
        field.setAccessible(true);
        Object previous = field.get(activity);
        List<LauncherActivity.IsoCourse> choices = Arrays.asList(
            new LauncherActivity.IsoCourse(Uri.fromFile(broken), "BROKEN", broken.getName()),
            new LauncherActivity.IsoCourse(Uri.fromFile(tricky), "FIXTURE", tricky.getName()),
            new LauncherActivity.IsoCourse(Uri.fromFile(ssx), "SSX_FIXTURE", ssx.getName()),
            new LauncherActivity.IsoCourse(Uri.fromFile(broken), "GARI", broken.getName())
        );
        try {
            runOnMainSync(() -> {
                try {
                    field.set(activity, batch);
                    invoke(activity, "importCourses", new Class<?>[] { List.class }, choices);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            libraryIdle(activity);
            require(
                batch.exists("FIXTURE") && batch.exists("SSX_FIXTURE"),
                "Batch imports courses from distinct ISO and BIN sources after an unreadable disc"
            );
            invoke(
                activity,
                "nativeValidate",
                new Class<?>[] { String.class },
                new File(root, "FIXTURE").getAbsolutePath()
            );
            invoke(
                activity,
                "nativeValidate",
                new Class<?>[] { String.class },
                new File(root, "SSX_FIXTURE").getAbsolutePath()
            );
            require(
                !batch.exists("BROKEN") && new File(existing, "keep-local.txt").isFile(),
                "Failed batch course stays unpublished and existing maps retain local edits"
            );
            for (File entry : root.listFiles())
                require(!entry.getName().startsWith(".openslope-import-"), "Batch import cleans every staging folder");
        } finally {
            runOnMainSync(() -> {
                try {
                    field.set(activity, previous);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        }
    }

    @Override
    public void onStart() {
        if (arguments != null && "true".equals(arguments.getString("launcher"))) {
            LauncherUiChecks.run(this);
            return;
        }
        if (arguments != null && "true".equals(arguments.getString("lifecycle"))) {
            NativeVrLifecycle.run(this);
            return;
        }
        if (arguments != null && "true".equals(arguments.getString("vr"))) {
            NativeVrSmoke.run(this, arguments);
            return;
        }
        Bundle results = new Bundle();
        LauncherActivity activity = null;
        File temporary = null;
        int code = Activity.RESULT_OK;
        try {
            Intent intent = new Intent(getTargetContext(), LauncherActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = (LauncherActivity) startActivitySync(intent);
            waitForIdleSync();
            Context context = getTargetContext();
            temporary = new File(context.getCacheDir(), "instrumentation-" + UUID.randomUUID());
            require(temporary.mkdir(), "Create private fixture");
            File image = new File(temporary, "fixture.iso");
            try (
                InputStream input = getContext().getAssets().open("fixture.iso");
                OutputStream output = new FileOutputStream(image)
            ) {
                MapLibrary.copy(input, output, MapLibrary.FILE_LIMIT, () -> {});
            }
            File extracted = new File(temporary, "extracted");
            try (
                ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(image, ParcelFileDescriptor.MODE_READ_ONLY)
            ) {
                String courses = (String) invoke(
                    activity,
                    "nativeCourses",
                    new Class<?>[] { int.class, long.class },
                    descriptor.getFd(),
                    image.length()
                );
                require(
                    new JSONArray(courses).getString(0).equals("FIXTURE"),
                    "JNI reads course list from seekable descriptor"
                );
                invoke(
                    activity,
                    "nativeExtract",
                    new Class<?>[] { int.class, long.class, String.class, String.class },
                    descriptor.getFd(),
                    image.length(),
                    "FIXTURE",
                    extracted.getAbsolutePath()
                );
                File worldCourse = new File(temporary, "world-course");
                invoke(
                    activity,
                    "nativeExtract",
                    new Class<?>[] { int.class, long.class, String.class, String.class },
                    descriptor.getFd(),
                    image.length(),
                    "GARI",
                    worldCourse.getAbsolutePath()
                );
                JSONObject world = new JSONObject(
                    new String(
                        java.nio.file.Files.readAllBytes(new File(worldCourse, "World.json").toPath()),
                        java.nio.charset.StandardCharsets.UTF_8
                    )
                );
                require(
                    world.getString("Course").equals("GARI") && world.getJSONArray("SkyColor").getInt(0) == 20,
                    "JNI automatically recovers authored course and sky settings from the ISO executable"
                );
                require(
                    world.getJSONObject("Glare").getBoolean("Enabled") &&
                        world.getJSONObject("Glare").getDouble("DistanceUnits") == 20000,
                    "JNI automatically imports the independent sun profile"
                );
                JSONObject sounds = new JSONObject(
                    new String(
                        java.nio.file.Files.readAllBytes(new File(worldCourse, "Audio/SoundIndex.json").toPath()),
                        java.nio.charset.StandardCharsets.UTF_8
                    )
                );
                require(
                    sounds.getString("SourceExecutable").equals("BOOT.ELF") &&
                        sounds.getJSONObject("CollisionEvents").getJSONObject("17").getInt("Slot") == 0,
                    "JNI automatically recovers collision routes from the authored executable"
                );
                require(
                    !sounds.getJSONObject("CollisionEvents").has("0") &&
                        sounds.getJSONObject("CollisionEvents").getJSONObject("7").getInt("Group") == 3,
                    "JNI retains silent events and crowd-group overrides"
                );
                JSONObject board = new JSONObject(
                    new String(
                        java.nio.file.Files.readAllBytes(new File(worldCourse, "Audio/BoardSoundIndex.json").toPath()),
                        java.nio.charset.StandardCharsets.UTF_8
                    )
                );
                require(
                    board.getString("SourceExecutable").equals("BOOT.ELF") &&
                        board.getJSONArray("SurfaceGroups").length() == 20,
                    "JNI automatically recovers the contract-sized board surface map"
                );
                require(
                    board.getJSONArray("SurfaceGroups").getInt(1) == 4,
                    "JNI retains the decoded selector normalization and family values"
                );
            }
            invoke(activity, "nativeValidate", new Class<?>[] { String.class }, extracted.getAbsolutePath());
            multiDiscImport(activity, temporary, image);
            require(new File(extracted, "Audio/SFX/tone/000.wav").isFile(), "JNI imports audio from the selected ISO");
            require(
                new File(extracted, "Audio/Music/song/chunk_000.wav").isFile(),
                "JNI imports graph-addressed music chunks"
            );
            require(new File(extracted, "Audio/Intro/Quiet-A.wav").isFile(), "JNI imports configured intro stems");
            require(
                new File(extracted, "RidingEffects.json").isFile() &&
                    new File(extracted, "Textures/particle-part.png").isFile(),
                "JNI imports the riding sprite profile and art"
            );
            require(new File(extracted, "Textures/particle-tral.png").isFile(), "JNI imports named wake art");
            require(new File(extracted, "Textures/particle-spry.png").isFile(), "JNI imports named spray sheet art");
            require(
                new File(extracted, "Patches.json").isFile() && new File(extracted, "Textures/0000.png").isFile(),
                "JNI writes canonical map files"
            );
            require(new File(extracted, "Splines.json").isFile(), "JNI imports spline geometry and behavior candidacy");
            require(
                new File(extracted, "Effects.json").isFile(),
                "JNI imports portable effect graphs and instance bindings"
            );
            require(
                new File(extracted, "Skybox/Meshes/0.obj").isFile() &&
                    new File(extracted, "Skybox/Textures/0000.png").isFile(),
                "JNI imports separate sky geometry and texture bank"
            );
            try (OutputStream file = new FileOutputStream(new File(extracted, "World.json"))) {
                file.write(
                    "{\"Schema\":\"openslope-world/v1\",\"SkyColor\":[90,110,130],\"Fog\":{\"Enabled\":false},\"Glare\":{\"Enabled\":true,\"AzimuthDegrees\":90,\"ElevationDegrees\":0}}".getBytes(
                        java.nio.charset.StandardCharsets.UTF_8
                    )
                );
            }
            try (OutputStream file = new FileOutputStream(new File(extracted, "RiderAnimations.json"))) {
                file.write(
                    "{\"Schema\":\"openslope-rider-animation/v1\",\"GetUp\":[{\"Time\":0,\"Standing\":0,\"Crouch\":1,\"Height\":0.3},{\"Time\":1,\"Standing\":1,\"Crouch\":0,\"Height\":0,\"Event\":\"get-up-finished\"}]}".getBytes(
                        java.nio.charset.StandardCharsets.UTF_8
                    )
                );
            }
            try (OutputStream file = new FileOutputStream(new File(extracted, "Slopesmith.json"))) {
                file.write(
                    "{\"schema\":1,\"kind\":\"slopesmith-export\",\"laps\":3,\"showoffSeconds\":180}".getBytes(
                        java.nio.charset.StandardCharsets.UTF_8
                    )
                );
            }
            File local = new File(temporary, "Maps");
            local.mkdir();
            MapLibrary direct = new MapLibrary(context.getContentResolver(), local, null);
            direct.publish("Custom course", extracted, () -> {});
            require(direct.maps().size() == 1, "Custom maps discovered without ISO selection");
            boolean rejected = false;
            try {
                direct.publish("Custom course", extracted, () -> {});
            } catch (IOException e) {
                rejected = true;
            }
            require(rejected && direct.maps().size() == 1, "Existing local map is preserved");
            File moved = direct.importPath(context.getCacheDir());
            require(
                !moved.exists() && moved.getParentFile().equals(local),
                "Local extraction stages on the Maps filesystem"
            );
            moved.mkdir();
            MapLibrary.copyLocal(extracted, moved, () -> {});
            direct.publishImport("Moved course", moved, () -> {});
            require(
                !moved.exists() && new File(local, "Moved course/Patches.json").isFile(),
                "Owned local import publishes by consuming its staging directory"
            );
            File interrupted = direct.importPath(context.getCacheDir());
            interrupted.mkdir();
            rejected = false;
            try {
                direct.publishImport("Cancelled local", interrupted, () -> {
                    throw new IOException("cancelled");
                });
            } catch (IOException e) {
                rejected = true;
            }
            require(
                rejected && interrupted.isDirectory() && !direct.exists("Cancelled local"),
                "Cancellation before local rename keeps the course unpublished"
            );
            rejected = false;
            try {
                direct.publishImport("Custom course", interrupted, () -> {});
            } catch (IOException e) {
                rejected = true;
            }
            require(rejected && interrupted.isDirectory(), "Existing local course does not consume import staging");
            MapLibrary.deleteLocal(interrupted);
            rejected = false;
            try {
                direct.publishImport("Outside staging", extracted, () -> {});
            } catch (IOException e) {
                rejected = true;
            }
            require(
                rejected && extracted.isDirectory(),
                "Local import cannot consume a source outside its staging root"
            );
            MapLibrary.Entry localCourse = null;
            for (MapLibrary.Entry row : direct.maps()) if (row.name.equals("Moved course")) localCourse = row;
            require(localCourse != null, "Find local course for unload");
            direct.unload(localCourse);
            require(
                !direct.exists("Moved course") && direct.exists("Custom course"),
                "Local unload preserves other courses"
            );
            File replacement = direct.importPath(context.getCacheDir());
            replacement.mkdir();
            MapLibrary.copyLocal(extracted, replacement, () -> {});
            direct.publishImport("Moved course", replacement, () -> {});
            require(direct.exists("Moved course"), "Unloaded local course can be imported again");
            Uri tree = DocumentsContract.buildTreeDocumentUri(FixtureDocumentsProvider.AUTHORITY, "root");
            // Instrumentation executes in the target UID; bootstrap in the test APK's owner process.
            java.util.concurrent.CountDownLatch providerReady = new java.util.concurrent.CountDownLatch(1);
            final int[] providerCode = { Activity.RESULT_CANCELED };
            final String[] providerError = { "" };
            Intent bootstrap = new Intent().setClassName(
                getContext().getPackageName(),
                FixtureBootstrapReceiver.class.getName()
            );
            context.sendOrderedBroadcast(
                bootstrap,
                null,
                new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context received, Intent intent) {
                        providerCode[0] = getResultCode();
                        providerError[0] = getResultData();
                        providerReady.countDown();
                    }
                },
                null,
                Activity.RESULT_CANCELED,
                null,
                null
            );
            require(
                providerReady.await(10, java.util.concurrent.TimeUnit.SECONDS),
                "Fixture provider bootstrap completes"
            );
            require(
                providerCode[0] == Activity.RESULT_OK,
                "Fixture owner grants its tree after APK updates: " + providerError[0]
            );
            MapLibrary documents = new MapLibrary(context.getContentResolver(), local, tree);
            String name = "Authored " + UUID.randomUUID();
            documents.publish(name, extracted, () -> {});
            MapLibrary.Entry selected = null;
            for (MapLibrary.Entry row : documents.maps()) if (row.name.equals(name)) selected = row;
            require(selected != null, "Published SAF map discovered under opaque tree URI");
            rejected = false;
            try {
                documents.unload(new MapLibrary.Entry(name, documents.root, true));
            } catch (IOException e) {
                rejected = true;
            }
            require(
                rejected && documents.exists(name),
                "SAF unload rejects an entry whose URI is not the selected child"
            );
            File prepared = documents.prepare(selected, temporary, () -> {});
            invoke(activity, "nativeValidate", new Class<?>[] { String.class }, prepared.getAbsolutePath());
            JSONArray references = new JSONArray(MapLibrary.nativeAssetFiles(extracted.getAbsolutePath()));
            require(references.length() >= 4, "Native manifest includes diffuse, lightmap and shared-mesh references");
            for (String metadata : new String[] { "Models.json", "Instances.json", "Materials.json" })
                require(new File(prepared, metadata).isFile(), "SAF cache includes prop metadata " + metadata);
            for (String metadata : new String[] { "AIP.json", "SOP.json" })
                require(
                    new File(prepared, metadata).isFile(),
                    "SAF cache includes authored start and course paths " + metadata
                );
            require(new File(prepared, "Meshes/0.obj").isFile(), "SAF cache includes imported prop geometry");
            for (String metadata : new String[] { "Models.json", "Materials.json" })
                require(
                    new File(prepared, "Skybox/" + metadata).isFile(),
                    "SAF cache includes model-only sky metadata"
                );
            require(
                new File(prepared, "World.json").isFile() &&
                    new File(prepared, "Skybox/Meshes/0.obj").isFile() &&
                    new File(prepared, "Skybox/Textures/0000.png").isFile(),
                "SAF cache retains authored world settings and nested sky assets"
            );
            require(
                new JSONObject(
                    new String(
                        java.nio.file.Files.readAllBytes(new File(prepared, "World.json").toPath()),
                        java.nio.charset.StandardCharsets.UTF_8
                    )
                )
                    .getJSONObject("Glare")
                    .getDouble("AzimuthDegrees") == 90,
                "SAF cache retains enabled celestial parameters with fog disabled"
            );
            require(
                new File(prepared, "RiderAnimations.json").isFile(),
                "SAF cache retains authored pose tracks and completion events"
            );
            require(new File(prepared, "Splines.json").isFile(), "SAF cache preserves analytic rail metadata");
            require(
                new File(prepared, "Origin.json").isFile(),
                "SAF cache preserves course identity for slot run settings"
            );
            require(
                new File(prepared, "Slopesmith.json").isFile(),
                "SAF cache preserves authored lap and showoff settings"
            );
            require(
                new File(prepared, "Collision/0.obj").isFile() && new File(prepared, "Collision/1.obj").isFile(),
                "SAF cache includes every collision payload"
            );
            require(new File(prepared, "Physics.json").isFile(), "SAF cache includes independent physics metadata");
            require(new File(prepared, "Effects.json").isFile(), "SAF cache preserves the playable effect graphs");
            require(
                new File(prepared, "Crowd.json").isFile() &&
                    new File(prepared, "Textures/crowd-cd00.png").isFile() &&
                    new File(prepared, "Textures/crowd-cd15.png").isFile(),
                "SAF cache includes shared crowd profile and frame art"
            );
            require(
                new File(prepared, "RidingEffects.json").isFile() &&
                    new File(prepared, "Textures/particle-part.png").isFile(),
                "SAF cache includes referenced riding sprite assets"
            );
            require(
                new File(prepared, "Textures/particle-tral.png").isFile(),
                "SAF cache includes the referenced wake texture"
            );
            require(
                new File(prepared, "Textures/particle-spry.png").isFile(),
                "SAF cache includes the referenced spray sheet texture"
            );
            require(new File(prepared, "Audio/SFX/tone/000.wav").isFile(), "SAF cache includes nested audio clips");
            require(new File(prepared, "Audio/SoundIndex.json").isFile(), "SAF cache includes audio routing metadata");
            require(
                new File(prepared, "Audio/Music/song/loops/loop/000.loop.wav").isFile(),
                "SAF cache includes configured async-bank assets"
            );
            for (int i = 0; i < references.length(); ++i) {
                String relative = references.getString(i);
                require(new File(prepared, relative).isFile(), "SAF play cache includes " + relative);
            }
            require(!new File(prepared, "Source").exists(), "Play cache excludes unreferenced import sidecars");
            File authoredParticles = new File(temporary, "authored-particles");
            require(authoredParticles.mkdir(), "Create an authored particle map without ISO metadata");
            JSONObject authoredPatches = new JSONObject(
                new String(
                    java.nio.file.Files.readAllBytes(new File(extracted, "Patches.json").toPath()),
                    java.nio.charset.StandardCharsets.UTF_8
                )
            );
            JSONArray authoredRows = authoredPatches.getJSONArray("Patches");
            for (int i = 0; i < authoredRows.length(); ++i) {
                authoredRows
                    .getJSONObject(i)
                    .put("TexturePath", "")
                    .put("LightmapID", -1)
                    .put("LightMapPoint", new JSONArray("[0,0,0,0]"));
            }
            java.nio.file.Files.write(
                new File(authoredParticles, "Patches.json").toPath(),
                authoredPatches.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)
            );
            File particleFolder = new File(authoredParticles, "Textures/Particles");
            require(particleFolder.mkdirs(), "Create nested authored particle art");
            java.nio.file.Files.copy(
                new File(extracted, "Textures/particle-part.png").toPath(),
                new File(particleFolder, "part.png").toPath()
            );
            java.nio.file.Files.copy(
                new File(extracted, "Textures/particle-part.png").toPath(),
                new File(particleFolder, "lens.png").toPath()
            );
            java.nio.file.Files.copy(
                new File(extracted, "World.json").toPath(),
                new File(authoredParticles, "World.json").toPath()
            );
            File commonAudio = new File(temporary, "common-audio");
            require(new File(commonAudio, "Audio/SFX/ZBOARD").mkdirs(), "Create synthetic common bank");
            java.nio.file.Files.copy(
                new File(authoredParticles, "Patches.json").toPath(),
                new File(commonAudio, "Patches.json").toPath()
            );
            java.nio.file.Files.copy(
                new File(extracted, "Audio/SFX/tone/000.wav").toPath(),
                new File(commonAudio, "Audio/SFX/ZBOARD/004.WAV").toPath()
            );
            java.nio.file.Files.copy(
                new File(extracted, "Audio/SFX/tone/000.wav").toPath(),
                new File(commonAudio, "Audio/SFX/ZBOARD/004.loop.wav").toPath()
            );
            File boardRouting = new File(extracted, "Audio/BoardSoundIndex.json");
            if (boardRouting.isFile()) java.nio.file.Files.copy(
                boardRouting.toPath(),
                new File(commonAudio, "Audio/BoardSoundIndex.json").toPath()
            );
            String commonName = "Common " + UUID.randomUUID();
            documents.publish(commonName, commonAudio, () -> {});
            File authoredSounds = new File(authoredParticles, "Sounds");
            require(authoredSounds.mkdir(), "Create authored sound folder without an Audio folder");
            java.nio.file.Files.copy(
                new File(extracted, "Audio/SFX/tone/000.wav").toPath(),
                new File(authoredSounds, "custom.wav").toPath()
            );
            File authoredMusic = new File(authoredParticles, "Music");
            require(authoredMusic.mkdir(), "Create authored master music folder");
            java.nio.file.Files.copy(
                new File(extracted, "Audio/SFX/tone/000.wav").toPath(),
                new File(authoredMusic, "track.wav").toPath()
            );
            java.nio.file.Files.write(
                new File(authoredMusic, "arrangement.json").toPath(),
                "{\"version\":1,\"mode\":\"linear-loop\",\"bpm\":120,\"loopStartSeconds\":0,\"loopEndSeconds\":0}".getBytes(
                    java.nio.charset.StandardCharsets.UTF_8
                )
            );
            String particleName = "Particles " + UUID.randomUUID();
            documents.publish(particleName, authoredParticles, () -> {});
            MapLibrary.Entry particleMap = null;
            for (MapLibrary.Entry row : documents.maps()) if (row.name.equals(particleName)) particleMap = row;
            require(particleMap != null, "Discover authored particles through the opaque SAF provider");
            File particleCache = documents.prepare(particleMap, temporary, () -> {});
            require(
                new File(particleCache, "Textures/Particles/part.png").isFile(),
                "SAF plan copies optional named art before it exists in the play cache"
            );
            require(
                new File(particleCache, "Textures/Particles/lens.png").isFile(),
                "SAF plan retains authored corona art without an imported profile"
            );
            require(
                new JSONObject(
                    new String(
                        java.nio.file.Files.readAllBytes(new File(particleCache, "World.json").toPath()),
                        java.nio.charset.StandardCharsets.UTF_8
                    )
                )
                    .getJSONObject("Glare")
                    .getBoolean("Enabled"),
                "Authored celestial settings reach the native play cache"
            );
            require(
                new File(particleCache, "Music/track.wav").isFile() &&
                    new File(particleCache, "Music/arrangement.json").isFile(),
                "SAF cache preserves authored master music and loop arrangement outside Audio"
            );
            require(
                new File(particleCache, "Sounds/custom.wav").isFile(),
                "SAF cache retains authored WAVs outside Audio"
            );
            require(
                new File(particleCache, "Audio/SFX/zboard/004.WAV").isFile(),
                "Map without Audio borrows a common bank from an older import with case-insensitive names"
            );
            require(
                new File(particleCache, "Audio/SFX/zboard/004.loop.wav").isFile(),
                "Borrowed full and sustain WAVs stay paired"
            );
            require(
                !new File(particleCache, "Audio/SFX/tone").exists(),
                "SAF fallback does not copy another map's course bank"
            );
            for (MapLibrary.Entry row : documents.maps())
                if (row.name.equals(commonName)) DocumentsContract.deleteDocument(
                    getContext().getContentResolver(),
                    row.uri
                );
            require(
                !new File(particleCache, "RidingEffects.json").exists() &&
                    !new File(particleCache, "Origin.json").exists(),
                "Authored particle art requires no imported profile or origin"
            );
            invoke(activity, "nativeValidate", new Class<?>[] { String.class }, particleCache.getAbsolutePath());
            Uri sharedRoot = fixtureFolder(documents, documents.root, "Shared");
            Uri sharedAudio = fixtureFolder(documents, sharedRoot, "Audio");
            Uri sharedBank = fixtureFolder(documents, fixtureFolder(documents, sharedAudio, "SFX"), "ZBOARD");
            byte[] commonClip = java.nio.file.Files.readAllBytes(
                new File(extracted, "Audio/SFX/tone/000.wav").toPath()
            );
            for (String filename : new String[] { "004.wav", "004.loop.wav", "005.wav" }) {
                MapLibrary.Entry existing = documents.child(sharedBank, filename);
                Uri clip =
                    existing == null
                        ? DocumentsContract.createDocument(
                              documents.resolver,
                              sharedBank,
                              "application/octet-stream",
                              filename
                          )
                        : existing.uri;
                try (OutputStream stream = documents.resolver.openOutputStream(clip, "wt")) {
                    stream.write(commonClip);
                }
            }
            File sharedCache = documents.prepare(particleMap, temporary, () -> {});
            require(
                new File(sharedCache, "Audio/SFX/zboard/005.wav").isFile(),
                "SAF cache discovers Shared without a Patches file"
            );
            require(
                new File(sharedCache, "Audio/SFX/zboard/004.loop.wav").isFile(),
                "Shared sustain region accompanies its full clip"
            );
            File localBank = new File(authoredParticles, "Audio/SFX/zboard");
            require(localBank.mkdirs(), "Create a local common-bank override");
            byte[] overrideClip = commonClip.clone();
            overrideClip[overrideClip.length - 1] ^= 1;
            java.nio.file.Files.write(new File(localBank, "004.wav").toPath(), overrideClip);
            String overrideName = "Override " + UUID.randomUUID();
            documents.publish(overrideName, authoredParticles, () -> {});
            MapLibrary.Entry overrideMap = null;
            for (MapLibrary.Entry row : documents.maps()) if (row.name.equals(overrideName)) overrideMap = row;
            require(overrideMap != null, "Discover the local override test map");
            File overrideCache = documents.prepare(overrideMap, temporary, () -> {});
            require(
                java.util.Arrays.equals(
                    overrideClip,
                    java.nio.file.Files.readAllBytes(new File(overrideCache, "Audio/SFX/zboard/004.wav").toPath())
                ),
                "Local WAV overrides Shared bytes"
            );
            require(
                !new File(overrideCache, "Audio/SFX/zboard/004.loop.wav").exists(),
                "A local full clip never borrows an unrelated sustain region"
            );
            require(
                new File(overrideCache, "Audio/SFX/zboard/005.wav").isFile(),
                "Shared still fills another missing slot beside a local override"
            );
            DocumentsContract.deleteDocument(documents.resolver, overrideMap.uri);
            DocumentsContract.deleteDocument(documents.resolver, sharedRoot);

            DocumentsContract.deleteDocument(getContext().getContentResolver(), particleMap.uri);
            int before = temporary.list().length;
            final int[] playProbes = { 0 };
            rejected = false;
            try {
                documents.prepare(selected, temporary, () -> {
                    if (++playProbes[0] > 4) throw new IOException("cancelled");
                });
            } catch (IOException e) {
                rejected = true;
            }
            require(
                rejected && temporary.list().length == before,
                "Cancelled play preparation removes partial image cache"
            );
            rejected = false;
            try {
                documents.publish(name, extracted, () -> {});
            } catch (IOException e) {
                rejected = true;
            }
            require(rejected, "Existing SAF map is preserved");
            final int[] probes = { 0 };
            rejected = false;
            String cancelled = "Cancelled " + UUID.randomUUID();
            try {
                documents.publish(cancelled, extracted, () -> {
                    if (++probes[0] > 3) throw new IOException("cancelled");
                });
            } catch (IOException e) {
                rejected = true;
            }
            require(rejected && !documents.exists(cancelled), "Cancelled SAF import is not published");
            MapLibrary.Entry effects = documents.child(selected.uri, "Effects.json");
            require(
                effects != null && DocumentsContract.deleteDocument(getContext().getContentResolver(), effects.uri),
                "Remove authored graph fixture to exercise old-import fallback"
            );
            File oldPrepared = documents.prepare(selected, temporary, () -> {});
            require(
                new File(oldPrepared, "Source/FIXTURE.SSF").isFile() &&
                    new File(oldPrepared, "Source").list().length == 1,
                "Old SAF import caches only its bounded behavior sidecar"
            );
            invoke(activity, "nativeValidate", new Class<?>[] { String.class }, oldPrepared.getAbsolutePath());
            MapLibrary.Entry materialEntry = documents.child(selected.uri, "Materials.json");
            JSONObject oldMaterials = new JSONObject(
                new String(
                    java.nio.file.Files.readAllBytes(new File(extracted, "Materials.json").toPath()),
                    java.nio.charset.StandardCharsets.UTF_8
                )
            );
            JSONArray oldRows = oldMaterials.getJSONArray("Materials");
            for (int i = 0; i < oldRows.length(); ++i) oldRows.getJSONObject(i).remove("TextureFlipbook");
            try (OutputStream stream = getContext().getContentResolver().openOutputStream(materialEntry.uri, "wt")) {
                stream.write(oldMaterials.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            File oldFrames = documents.prepare(selected, temporary, () -> {});
            require(
                new File(oldFrames, "Source/FIXTURE.PBD").isFile() &&
                    new File(oldFrames, "Source/FIXTURE.SSH").isFile() &&
                    new File(oldFrames, "Source").list().length == 3,
                "Old SAF import caches only paired material and behavior sidecars"
            );
            require(
                new File(oldFrames, "Textures/0001.png").isFile(),
                "Legacy flipbook frame art is referenced and cached"
            );
            invoke(activity, "nativeValidate", new Class<?>[] { String.class }, oldFrames.getAbsolutePath());
            documents.unload(selected);
            require(!documents.exists(name), "SAF unload removes the selected source course");
            documents.publish(name, extracted, () -> {});
            require(documents.exists(name), "Unloaded SAF course can be imported again");
            MapLibrary.Entry reloaded = documents.child(documents.root, name);
            documents.unload(reloaded);
            results.putString("stream", "PASS: " + checks + " device-side JNI, custom-library and SAF checks\n");
        } catch (Throwable e) {
            results.putString("stream", "FAIL: " + e + "\n");
            code = Activity.RESULT_CANCELED;
        } finally {
            if (temporary != null) MapLibrary.deleteLocal(temporary);
            if (activity != null) {
                LauncherActivity launched = activity;
                runOnMainSync(launched::finish);
            }
            finish(code, results);
        }
    }

    private Uri fixtureFolder(MapLibrary library, Uri parent, String name) throws IOException {
        MapLibrary.Entry existing = library.child(parent, name);
        if (existing != null) {
            if (!existing.directory) throw new IOException("Fixture folder is a file");
            return existing.uri;
        }
        Uri folder = DocumentsContract.createDocument(library.resolver, parent, MapLibrary.DIRECTORY, name);
        if (folder == null) throw new IOException("Cannot create audio fixture folder");
        return folder;
    }
}
