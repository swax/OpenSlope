package org.openslope.nativeplayer;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import java.io.File;
import java.io.FileOutputStream;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Launches an existing local course through the app UID for a bounded headset smoke check. */
public final class NativeVrSmoke {

    private NativeVrSmoke() {}

    public static void run(Instrumentation host, Bundle arguments) {
        String course = arguments == null ? "GARI" : arguments.getString("course", "GARI");
        Bundle results = new Bundle();
        GameActivity activity = null;
        File temporary = null;
        int code = Activity.RESULT_OK;
        try {
            int seconds = arguments == null ? 12 : Integer.parseInt(arguments.getString("seconds", "12"));
            if (
                !course.matches("[A-Za-z0-9_-]{1,64}") || seconds < 2 || seconds > 300
            ) throw new IllegalArgumentException("Invalid VR smoke arguments");
            Context context = host.getTargetContext();
            File base = context.getExternalFilesDir(null);
            if (base == null) base = context.getFilesDir();
            File map = new File(new File(base, "Maps"), course);
            if (!new File(map, "Patches.json").isFile()) {
                File internal = new File(new File(context.getFilesDir(), "Maps"), course);
                if (new File(internal, "Patches.json").isFile()) map = internal;
                else {
                    map = new File(context.getCacheDir(), "play-vr-smoke-" + UUID.randomUUID());
                    temporary = map;
                    if (!map.mkdir()) throw new IllegalStateException("Cannot create authored test floor");
                    JSONArray points = new JSONArray();
                    for (int u = 0; u < 4; ++u) for (int v = 0; v < 4; ++v) points.put(
                        new JSONArray(new double[] { (u / 3.0 - .5) * 20000, (v / 3.0 - .5) * 20000, 0 })
                    );
                    JSONObject patch = new JSONObject()
                        .put("PatchName", "Authored VR test floor")
                        .put("SurfaceType", 1)
                        .put("TrickOnlyPatch", false)
                        .put("Points", points)
                        .put("TexturePath", "")
                        .put("LightmapID", -1)
                        .put("UVPoints", new JSONArray("[[0,0],[0,1],[1,0],[1,1]]"))
                        .put("LightMapPoint", new JSONArray("[0,0,0,0]"));
                    try (FileOutputStream output = new FileOutputStream(new File(map, "Patches.json"))) {
                        output.write(
                            new JSONObject()
                                .put("Patches", new JSONArray().put(patch))
                                .toString()
                                .getBytes(java.nio.charset.StandardCharsets.UTF_8)
                        );
                    }
                    course = "authored VR test floor (local course absent)";
                }
            }
            Intent intent = new Intent(context, GameActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .addCategory("com.oculus.intent.category.VR")
                .addCategory("org.khronos.openxr.intent.category.IMMERSIVE_HMD");
            intent.putExtra("map_path", map.getAbsolutePath());
            intent.putExtra("map_cache", map.getName().startsWith("play-vr-smoke-"));
            intent.putExtra("map_name", course);
            intent.putExtra("run_mode", arguments == null ? "freeride" : arguments.getString("mode", "freeride"));
            intent.putExtra(
                "render_scale",
                Double.parseDouble(arguments == null ? "1.0" : arguments.getString("scale", "1.0"))
            );
            intent.putExtra("msaa", Integer.parseInt(arguments == null ? "4" : arguments.getString("msaa", "4")));
            activity = (GameActivity) host.startActivitySync(intent);
            Thread.sleep(seconds * 1000L);
            if (activity.isFinishing()) throw new IllegalStateException("VR activity ended during smoke check");
            results.putString(
                "stream",
                "PASS: " +
                    course +
                    " launched for " +
                    seconds +
                    " seconds; inspect OpenSlopeNative logs for tracking/frame evidence\n"
            );
        } catch (Throwable error) {
            results.putString("stream", "FAIL: " + error + "\n");
            code = Activity.RESULT_CANCELED;
        } finally {
            if (activity != null) {
                GameActivity launched = activity;
                host.runOnMainSync(launched::finish);
            }
            if (temporary != null) MapLibrary.deleteLocal(temporary);
            host.finish(code, results);
        }
    }
}
