package org.openslope.nativeplayer;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import android.provider.DocumentsContract;
import org.json.*;
import java.io.*;
import java.lang.reflect.*;
import java.util.*;

/** No test-framework dependency; run with adb shell am instrument -w <test-package>/<runner>. */
public final class NativeImportInstrumentation extends Instrumentation {
    private int checks;private Bundle arguments;
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); this.arguments=arguments; start(); }
    private void require(boolean condition, String message) { ++checks; if (!condition) throw new AssertionError(message); }
    private Object invoke(LauncherActivity activity, String name, Class<?>[] types, Object... values) throws Exception {
        Method method = LauncherActivity.class.getDeclaredMethod(name, types); method.setAccessible(true);
        try { return method.invoke(activity, values); } catch (InvocationTargetException e) { throw new IOException(e.getCause().getMessage(), e.getCause()); }
    }
    @Override public void onStart() {
        if(arguments!=null&&"true".equals(arguments.getString("vr"))){NativeVrSmoke.run(this,arguments);return;}
        Bundle results = new Bundle(); LauncherActivity activity = null; File temporary = null; int code=Activity.RESULT_OK;
        try {
            Intent intent = new Intent(getTargetContext(), LauncherActivity.class); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = (LauncherActivity) startActivitySync(intent); waitForIdleSync();
            Context context = getTargetContext(); temporary = new File(context.getCacheDir(), "instrumentation-" + UUID.randomUUID()); require(temporary.mkdir(), "Create private fixture");
            File image = new File(temporary, "fixture.iso");
            try (InputStream input = getContext().getAssets().open("fixture.iso"); OutputStream output = new FileOutputStream(image)) { MapLibrary.copy(input, output, MapLibrary.FILE_LIMIT, () -> {}); }
            File extracted = new File(temporary, "extracted");
            try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(image, ParcelFileDescriptor.MODE_READ_ONLY)) {
                String courses = (String) invoke(activity, "nativeCourses", new Class<?>[]{int.class, long.class}, descriptor.getFd(), image.length());
                require(new JSONArray(courses).getString(0).equals("FIXTURE"), "JNI reads course list from seekable descriptor");
                invoke(activity, "nativeExtract", new Class<?>[]{int.class, long.class, String.class, String.class}, descriptor.getFd(), image.length(), "FIXTURE", extracted.getAbsolutePath());
            }
            invoke(activity, "nativeValidate", new Class<?>[]{String.class}, extracted.getAbsolutePath());
            require(new File(extracted, "Audio/SFX/tone/000.wav").isFile(), "JNI imports audio from the selected ISO");
            require(new File(extracted, "Audio/Music/song/chunk_000.wav").isFile(), "JNI imports graph-addressed music chunks");
            require(new File(extracted, "Audio/Intro/Quiet-A.wav").isFile(), "JNI imports configured intro stems");
            require(new File(extracted, "RidingEffects.json").isFile() && new File(extracted, "Textures/particle-part.png").isFile(), "JNI imports the riding sprite profile and art");
            require(new File(extracted, "Textures/particle-tral.png").isFile(), "JNI imports named wake art");
            require(new File(extracted, "Textures/particle-spry.png").isFile(), "JNI imports named spray sheet art");
            require(new File(extracted, "Patches.json").isFile() && new File(extracted, "Textures/0000.png").isFile(), "JNI writes canonical map files");
            require(new File(extracted, "Splines.json").isFile(), "JNI imports spline geometry and behavior candidacy");
            require(new File(extracted, "Effects.json").isFile(), "JNI imports portable effect graphs and instance bindings");
            require(new File(extracted, "Skybox/Meshes/0.obj").isFile() && new File(extracted, "Skybox/Textures/0000.png").isFile(), "JNI imports separate sky geometry and texture bank");
            try (OutputStream file = new FileOutputStream(new File(extracted, "World.json"))) { file.write("{\"Schema\":\"openslope-world/v1\",\"SkyColor\":[90,110,130],\"Fog\":{\"Enabled\":false}}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            try (OutputStream file = new FileOutputStream(new File(extracted, "RiderAnimations.json"))) { file.write("{\"Schema\":\"openslope-rider-animation/v1\",\"GetUp\":[{\"Time\":0,\"Standing\":0,\"Crouch\":1,\"Height\":0.3},{\"Time\":1,\"Standing\":1,\"Crouch\":0,\"Height\":0,\"Event\":\"get-up-finished\"}]}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            try(OutputStream file=new FileOutputStream(new File(extracted,"Slopesmith.json"))){file.write("{\"schema\":1,\"kind\":\"slopesmith-export\",\"laps\":3,\"showoffSeconds\":180}".getBytes(java.nio.charset.StandardCharsets.UTF_8));}
            File local = new File(temporary, "Maps"); local.mkdir();
            MapLibrary direct = new MapLibrary(context.getContentResolver(), local, null); direct.publish("Custom course", extracted, () -> {});
            require(direct.maps().size() == 1, "Custom maps discovered without ISO selection");
            boolean rejected = false; try { direct.publish("Custom course", extracted, () -> {}); } catch (IOException e) { rejected = true; }
            require(rejected && direct.maps().size() == 1, "Existing local map is preserved");
            File moved = direct.importPath(context.getCacheDir()); require(!moved.exists() && moved.getParentFile().equals(local), "Local extraction stages on the Maps filesystem");
            moved.mkdir(); MapLibrary.copyLocal(extracted, moved, () -> {});
            direct.publishImport("Moved course", moved, () -> {});
            require(!moved.exists() && new File(local, "Moved course/Patches.json").isFile(), "Owned local import publishes by consuming its staging directory");
            File interrupted = direct.importPath(context.getCacheDir()); interrupted.mkdir();
            rejected = false; try { direct.publishImport("Cancelled local", interrupted, () -> { throw new IOException("cancelled"); }); } catch (IOException e) { rejected = true; }
            require(rejected && interrupted.isDirectory() && !direct.exists("Cancelled local"), "Cancellation before local rename keeps the course unpublished");
            rejected = false; try { direct.publishImport("Custom course", interrupted, () -> {}); } catch (IOException e) { rejected = true; }
            require(rejected && interrupted.isDirectory(), "Existing local course does not consume import staging");
            MapLibrary.deleteLocal(interrupted);
            rejected = false; try { direct.publishImport("Outside staging", extracted, () -> {}); } catch (IOException e) { rejected = true; }
            require(rejected && extracted.isDirectory(), "Local import cannot consume a source outside its staging root");
            Uri tree = DocumentsContract.buildTreeDocumentUri(FixtureDocumentsProvider.AUTHORITY, "root");
            // Instrumentation executes in the target UID; bootstrap in the test APK's owner process.
            java.util.concurrent.CountDownLatch providerReady = new java.util.concurrent.CountDownLatch(1);
            final int[] providerCode = {Activity.RESULT_CANCELED}; final String[] providerError = {""};
            Intent bootstrap = new Intent().setClassName(getContext().getPackageName(), FixtureBootstrapReceiver.class.getName());
            context.sendOrderedBroadcast(bootstrap, null, new BroadcastReceiver() {
                @Override public void onReceive(Context received, Intent intent) {
                    providerCode[0] = getResultCode(); providerError[0] = getResultData(); providerReady.countDown();
                }
            }, null, Activity.RESULT_CANCELED, null, null);
            require(providerReady.await(10, java.util.concurrent.TimeUnit.SECONDS), "Fixture provider bootstrap completes");
            require(providerCode[0] == Activity.RESULT_OK, "Fixture owner grants its tree after APK updates: " + providerError[0]);
            MapLibrary documents = new MapLibrary(context.getContentResolver(), local, tree);
            String name = "Authored " + UUID.randomUUID(); documents.publish(name, extracted, () -> {});
            MapLibrary.Entry selected = null; for (MapLibrary.Entry row : documents.maps()) if (row.name.equals(name)) selected = row;
            require(selected != null, "Published SAF map discovered under opaque tree URI");
            File prepared = documents.prepare(selected, temporary, () -> {}); invoke(activity, "nativeValidate", new Class<?>[]{String.class}, prepared.getAbsolutePath());
            JSONArray references = new JSONArray(MapLibrary.nativeAssetFiles(extracted.getAbsolutePath()));
            require(references.length() >= 4, "Native manifest includes diffuse, lightmap and shared-mesh references");
            for (String metadata : new String[]{"Models.json", "Instances.json", "Materials.json"}) require(new File(prepared, metadata).isFile(), "SAF cache includes prop metadata " + metadata);
            for (String metadata : new String[]{"AIP.json", "SOP.json"}) require(new File(prepared, metadata).isFile(), "SAF cache includes authored start and course paths " + metadata);
            require(new File(prepared, "Meshes/0.obj").isFile(), "SAF cache includes imported prop geometry");
            for (String metadata : new String[]{"Models.json", "Materials.json"}) require(new File(prepared, "Skybox/" + metadata).isFile(), "SAF cache includes model-only sky metadata");
            require(new File(prepared, "World.json").isFile() && new File(prepared, "Skybox/Meshes/0.obj").isFile() && new File(prepared, "Skybox/Textures/0000.png").isFile(), "SAF cache retains authored world settings and nested sky assets");
            require(new File(prepared, "RiderAnimations.json").isFile(), "SAF cache retains authored pose tracks and completion events");
            require(new File(prepared, "Splines.json").isFile(), "SAF cache preserves analytic rail metadata");
            require(new File(prepared,"Origin.json").isFile(),"SAF cache preserves course identity for slot run settings");
            require(new File(prepared,"Slopesmith.json").isFile(),"SAF cache preserves authored lap and showoff settings");
            require(new File(prepared, "Collision/0.obj").isFile() && new File(prepared, "Collision/1.obj").isFile(), "SAF cache includes every collision payload");
            require(new File(prepared, "Physics.json").isFile(), "SAF cache includes independent physics metadata");
            require(new File(prepared, "Effects.json").isFile(), "SAF cache preserves the playable effect graphs");
            require(new File(prepared, "Crowd.json").isFile() && new File(prepared, "Textures/crowd-cd00.png").isFile() && new File(prepared, "Textures/crowd-cd15.png").isFile(), "SAF cache includes shared crowd profile and frame art");
            require(new File(prepared, "RidingEffects.json").isFile() && new File(prepared, "Textures/particle-part.png").isFile(), "SAF cache includes referenced riding sprite assets");
            require(new File(prepared, "Textures/particle-tral.png").isFile(), "SAF cache includes the referenced wake texture");
            require(new File(prepared, "Textures/particle-spry.png").isFile(), "SAF cache includes the referenced spray sheet texture");
            require(new File(prepared, "Audio/SFX/tone/000.wav").isFile(), "SAF cache includes nested audio clips");
            require(new File(prepared, "Audio/SoundIndex.json").isFile(), "SAF cache includes audio routing metadata");
            require(new File(prepared, "Audio/Music/song/loops/loop/000.loop.wav").isFile(), "SAF cache includes configured async-bank assets");
            for (int i = 0; i < references.length(); ++i) {
                String relative = references.getString(i);
                require(new File(prepared, relative).isFile(), "SAF play cache includes " + relative);
            }
            require(!new File(prepared, "Source").exists(), "Play cache excludes unreferenced import sidecars");
            File authoredParticles = new File(temporary, "authored-particles");
            require(authoredParticles.mkdir(), "Create an authored particle map without ISO metadata");
            JSONObject authoredPatches = new JSONObject(new String(java.nio.file.Files.readAllBytes(new File(extracted, "Patches.json").toPath()), java.nio.charset.StandardCharsets.UTF_8));
            JSONArray authoredRows = authoredPatches.getJSONArray("Patches");
            for (int i = 0; i < authoredRows.length(); ++i) {
                authoredRows.getJSONObject(i).put("TexturePath", "").put("LightmapID", -1).put("LightMapPoint", new JSONArray("[0,0,0,0]"));
            }
            java.nio.file.Files.write(new File(authoredParticles, "Patches.json").toPath(), authoredPatches.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            File particleFolder = new File(authoredParticles, "Textures/Particles");
            require(particleFolder.mkdirs(), "Create nested authored particle art");
            java.nio.file.Files.copy(new File(extracted, "Textures/particle-part.png").toPath(), new File(particleFolder, "part.png").toPath());
            String particleName = "Particles " + UUID.randomUUID(); documents.publish(particleName, authoredParticles, () -> {});
            MapLibrary.Entry particleMap = null; for (MapLibrary.Entry row : documents.maps()) if (row.name.equals(particleName)) particleMap = row;
            require(particleMap != null, "Discover authored particles through the opaque SAF provider");
            File particleCache = documents.prepare(particleMap, temporary, () -> {});
            require(new File(particleCache, "Textures/Particles/part.png").isFile(), "SAF plan copies optional named art before it exists in the play cache");
            require(!new File(particleCache, "RidingEffects.json").exists() && !new File(particleCache, "Origin.json").exists(), "Authored particle art requires no imported profile or origin");
            invoke(activity, "nativeValidate", new Class<?>[]{String.class}, particleCache.getAbsolutePath());
            DocumentsContract.deleteDocument(getContext().getContentResolver(), particleMap.uri);
            int before = temporary.list().length; final int[] playProbes = {0}; rejected = false;
            try { documents.prepare(selected, temporary, () -> { if (++playProbes[0] > 4) throw new IOException("cancelled"); }); } catch (IOException e) { rejected = true; }
            require(rejected && temporary.list().length == before, "Cancelled play preparation removes partial image cache");
            rejected = false; try { documents.publish(name, extracted, () -> {}); } catch (IOException e) { rejected = true; }
            require(rejected, "Existing SAF map is preserved");
            final int[] probes = {0}; rejected = false; String cancelled = "Cancelled " + UUID.randomUUID();
            try { documents.publish(cancelled, extracted, () -> { if (++probes[0] > 3) throw new IOException("cancelled"); }); } catch (IOException e) { rejected = true; }
            require(rejected && !documents.exists(cancelled), "Cancelled SAF import is not published");
            MapLibrary.Entry effects = documents.child(selected.uri, "Effects.json");
            require(effects != null && DocumentsContract.deleteDocument(getContext().getContentResolver(), effects.uri), "Remove authored graph fixture to exercise old-import fallback");
            File oldPrepared = documents.prepare(selected, temporary, () -> {});
            require(new File(oldPrepared, "Source/FIXTURE.SSF").isFile() && new File(oldPrepared, "Source").list().length == 1, "Old SAF import caches only its bounded behavior sidecar");
            invoke(activity, "nativeValidate", new Class<?>[]{String.class}, oldPrepared.getAbsolutePath());
            MapLibrary.Entry materialEntry = documents.child(selected.uri, "Materials.json");
            JSONObject oldMaterials = new JSONObject(new String(java.nio.file.Files.readAllBytes(new File(extracted, "Materials.json").toPath()), java.nio.charset.StandardCharsets.UTF_8));
            JSONArray oldRows = oldMaterials.getJSONArray("Materials");
            for (int i = 0; i < oldRows.length(); ++i) oldRows.getJSONObject(i).remove("TextureFlipbook");
            try (OutputStream stream = getContext().getContentResolver().openOutputStream(materialEntry.uri, "wt")) { stream.write(oldMaterials.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            File oldFrames = documents.prepare(selected, temporary, () -> {});
            require(new File(oldFrames, "Source/FIXTURE.PBD").isFile() && new File(oldFrames, "Source/FIXTURE.SSH").isFile() && new File(oldFrames, "Source").list().length == 3, "Old SAF import caches only paired material and behavior sidecars");
            require(new File(oldFrames, "Textures/0001.png").isFile(), "Legacy flipbook frame art is referenced and cached");
            invoke(activity, "nativeValidate", new Class<?>[]{String.class}, oldFrames.getAbsolutePath());
            DocumentsContract.deleteDocument(getContext().getContentResolver(), selected.uri);
            results.putString("stream", "PASS: " + checks + " device-side JNI, custom-library and SAF checks\n");
        } catch (Throwable e) { results.putString("stream", "FAIL: " + e + "\n"); code=Activity.RESULT_CANCELED; }
        finally { if (temporary != null) MapLibrary.deleteLocal(temporary); if (activity != null) { LauncherActivity launched = activity; runOnMainSync(launched::finish); } finish(code, results); }
    }
}
