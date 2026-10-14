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
    private int checks;
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    private void require(boolean condition, String message) { ++checks; if (!condition) throw new AssertionError(message); }
    private Object invoke(LauncherActivity activity, String name, Class<?>[] types, Object... values) throws Exception {
        Method method = LauncherActivity.class.getDeclaredMethod(name, types); method.setAccessible(true);
        try { return method.invoke(activity, values); } catch (InvocationTargetException e) { throw new IOException(e.getCause().getMessage(), e.getCause()); }
    }
    @Override public void onStart() {
        Bundle results = new Bundle(); LauncherActivity activity = null; File temporary = null;
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
            require(new File(extracted, "Skybox/Meshes/0.obj").isFile() && new File(extracted, "Skybox/Textures/0000.png").isFile(), "JNI imports separate sky geometry and texture bank");
            try (OutputStream file = new FileOutputStream(new File(extracted, "World.json"))) { file.write("{\"Schema\":\"openslope-world/v1\",\"SkyColor\":[90,110,130],\"Fog\":{\"Enabled\":false}}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            try (OutputStream file = new FileOutputStream(new File(extracted, "RiderAnimations.json"))) { file.write("{\"Schema\":\"openslope-rider-animation/v1\",\"GetUp\":[{\"Time\":0,\"Standing\":0,\"Crouch\":1,\"Height\":0.3},{\"Time\":1,\"Standing\":1,\"Crouch\":0,\"Height\":0,\"Event\":\"get-up-finished\"}]}".getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            File local = new File(temporary, "Maps"); local.mkdir();
            MapLibrary direct = new MapLibrary(context.getContentResolver(), local, null); direct.publish("Custom course", extracted, () -> {});
            require(direct.maps().size() == 1, "Custom maps discovered without ISO selection");
            boolean rejected = false; try { direct.publish("Custom course", extracted, () -> {}); } catch (IOException e) { rejected = true; }
            require(rejected && direct.maps().size() == 1, "Existing local map is preserved");
            Uri tree = DocumentsContract.buildTreeDocumentUri(FixtureDocumentsProvider.AUTHORITY, "root");
            MapLibrary documents = new MapLibrary(getContext().getContentResolver(), local, tree);
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
            require(new File(prepared, "Collision/0.obj").isFile() && new File(prepared, "Collision/1.obj").isFile(), "SAF cache includes every collision payload");
            require(new File(prepared, "Physics.json").isFile(), "SAF cache includes independent physics metadata");
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
            int before = temporary.list().length; final int[] playProbes = {0}; rejected = false;
            try { documents.prepare(selected, temporary, () -> { if (++playProbes[0] > 4) throw new IOException("cancelled"); }); } catch (IOException e) { rejected = true; }
            require(rejected && temporary.list().length == before, "Cancelled play preparation removes partial image cache");
            rejected = false; try { documents.publish(name, extracted, () -> {}); } catch (IOException e) { rejected = true; }
            require(rejected, "Existing SAF map is preserved");
            final int[] probes = {0}; rejected = false; String cancelled = "Cancelled " + UUID.randomUUID();
            try { documents.publish(cancelled, extracted, () -> { if (++probes[0] > 3) throw new IOException("cancelled"); }); } catch (IOException e) { rejected = true; }
            require(rejected && !documents.exists(cancelled), "Cancelled SAF import is not published");
            DocumentsContract.deleteDocument(getContext().getContentResolver(), selected.uri);
            results.putString("stream", "PASS: " + checks + " device-side JNI, custom-library and SAF checks\n"); finish(Activity.RESULT_OK, results);
        } catch (Throwable e) { results.putString("stream", "FAIL: " + e + "\n"); finish(Activity.RESULT_CANCELED, results); }
        finally { if (temporary != null) MapLibrary.deleteLocal(temporary); if (activity != null) { LauncherActivity launched = activity; runOnMainSync(launched::finish); } }
    }
}
