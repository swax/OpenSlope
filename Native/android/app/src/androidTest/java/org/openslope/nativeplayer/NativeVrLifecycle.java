package org.openslope.nativeplayer;

import android.app.*;
import android.content.*;
import android.os.Bundle;
import java.io.*;
import java.util.UUID;
import org.json.*;

/** Exercise real Android tasks and the same exit request used by Android Back. */
final class NativeVrLifecycle {
    private static volatile int gameResumes, gamePauses, launcherResumes;
    private static volatile LauncherActivity picker;
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static void waitFor(java.util.function.BooleanSupplier ready, String message) throws Exception {
        long until = android.os.SystemClock.uptimeMillis() + 12000;
        while (!ready.getAsBoolean() && android.os.SystemClock.uptimeMillis() < until) Thread.sleep(50);
        require(ready.getAsBoolean(), message);
    }
    static void run(Instrumentation host) {
        Bundle results = new Bundle(); int code = Activity.RESULT_OK; File map = null;
        Context context = host.getTargetContext(); Application application = (Application) context.getApplicationContext();
        File preferences = new File(context.getFilesDir(), "audio-preferences.json"); byte[] previousPreferences = null; boolean preferencesRead = false;
        Application.ActivityLifecycleCallbacks observer = new Application.ActivityLifecycleCallbacks() {
            public void onActivityCreated(Activity a, Bundle b) {}
            public void onActivityStarted(Activity a) {}
            public void onActivityResumed(Activity a) { if (a instanceof GameActivity) ++gameResumes; if (a instanceof LauncherActivity) { picker = (LauncherActivity) a; ++launcherResumes; } }
            public void onActivityPaused(Activity a) { if (a instanceof GameActivity) ++gamePauses; }
            public void onActivityStopped(Activity a) {}
            public void onActivitySaveInstanceState(Activity a, Bundle b) {}
            public void onActivityDestroyed(Activity a) {}
        };
        application.registerActivityLifecycleCallbacks(observer);
        try {
            previousPreferences = preferences.isFile() ? java.nio.file.Files.readAllBytes(preferences.toPath()) : null; preferencesRead = true;
            byte[] fixturePreferences = new JSONObject().put("schema", "openslope-audio-preferences/v1").put("musicEnabled", false)
                .put("volume", .4).put("audibleVolume", .4).put("songs", new JSONObject().put("Lifecycle Music", "alpha"))
                .toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            java.nio.file.Files.write(preferences.toPath(), fixturePreferences);
            gameResumes = gamePauses = launcherResumes = 0;
            map = new File(context.getCacheDir(), "lifecycle-" + UUID.randomUUID()); require(map.mkdir(), "create synthetic lifecycle floor");
            JSONArray points = new JSONArray();
            for (int u = 0; u < 4; ++u) for (int v = 0; v < 4; ++v) points.put(new JSONArray(new double[]{(u/3.0-.5)*20000,(v/3.0-.5)*20000,0}));
            JSONObject patch = new JSONObject().put("PatchName","Lifecycle floor").put("SurfaceType",1).put("TrickOnlyPatch",false)
                .put("Points",points).put("TexturePath","").put("LightmapID",-1).put("UVPoints",new JSONArray("[[0,0],[0,1],[1,0],[1,1]]")).put("LightMapPoint",new JSONArray("[0,0,0,0]"));
            try (OutputStream out = new FileOutputStream(new File(map,"Patches.json"))) { out.write(new JSONObject().put("Patches",new JSONArray().put(patch)).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
            File music = new File(map, "Audio/Music"); require(music.mkdirs(), "create synthetic playlist folder");
            java.nio.file.Files.write(new File(music, "playlist.json").toPath(), "[\"alpha\"]".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            Intent gameIntent = new Intent(context, GameActivity.class).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .addCategory("com.oculus.intent.category.VR").addCategory("org.khronos.openxr.intent.category.IMMERSIVE_HMD")
                .putExtra("map_path",map.getAbsolutePath()).putExtra("map_name", "Lifecycle Music").putExtra("msaa",4).putExtra("render_scale",1.0);
            Intent pickerIntent = new Intent(context, LauncherActivity.class).setAction(Intent.ACTION_MAIN)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK).putExtra("show_library", true);
            LauncherActivity initialPicker = (LauncherActivity) host.startActivitySync(pickerIntent);
            host.runOnMainSync(initialPicker::finishAndRemoveTask);
            waitFor(initialPicker::isDestroyed, "normal play removes the picker task");
            GameActivity game = (GameActivity) host.startActivitySync(gameIntent); host.waitForIdleSync();
            waitFor(() -> gameResumes > 0, "immersive activity resumes"); Thread.sleep(2000);
            int initialResumes = gameResumes;
            Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            host.runOnMainSync(() -> context.startActivity(home));
            waitFor(() -> gamePauses > 0, "Horizon Home pauses the immersive activity");
            Thread.sleep(700);
            // Launching the app icon should return to the live course, without making a second game.
            Intent icon = new Intent(context, LauncherActivity.class).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            host.runOnMainSync(() -> context.startActivity(icon));
            waitFor(() -> gameResumes > initialResumes, "app icon resumes the immersive task");
            require(GameActivity.running() == game && !game.isFinishing(), "app switching preserves the same course activity");
            require("Lifecycle Music".equals(game.getMapName()), "cache-folder playback retains the selected course identity");
            require(java.util.Arrays.equals(fixturePreferences, java.nio.file.Files.readAllBytes(preferences.toPath())), "app switching retains private audio settings");
            Thread.sleep(700);
            int beforeQuit = launcherResumes;
            host.runOnMainSync(game::onBackPressed);
            waitFor(() -> game.isDestroyed(), "Android Back gracefully closes the XR activity");
            Thread.sleep(700);
            require(launcherResumes == beforeQuit, "Exit app does not reopen the map picker");
            require(GameActivity.running() == null, "closed game is removed from the live activity reference");
            GameActivity second = (GameActivity) host.startActivitySync(gameIntent); host.waitForIdleSync(); Thread.sleep(2000);
            int beforeMaps = launcherResumes;
            host.runOnMainSync(() -> second.requestExit(true));
            waitFor(second::isDestroyed, "map-library exit releases the immersive activity");
            waitFor(() -> launcherResumes > beforeMaps, "Horizon Home opens the map picker panel");
            require(GameActivity.running() == null, "map return does not leave an immersive task alive");
            LauncherActivity returnedPicker = picker;
            require(returnedPicker != null, "map picker panel was observed");
            host.runOnMainSync(returnedPicker::finishAndRemoveTask);
            waitFor(returnedPicker::isDestroyed, "choosing another course removes the picker task");
            GameActivity third = (GameActivity) host.startActivitySync(gameIntent); host.waitForIdleSync(); Thread.sleep(2000);
            host.runOnMainSync(() -> third.requestExit(false));
            waitFor(third::isDestroyed, "repeated launch and app exit release XR resources");
            require(java.util.Arrays.equals(fixturePreferences, java.nio.file.Files.readAllBytes(preferences.toPath())), "repeated app exit preserves audio preferences");
            results.putString("stream", "PASS: Horizon startup, Home pause, app-icon resume, same course instance, Android Back/app exit, map-picker return and repeat launch/exit; resumes=" + gameResumes + ", pauses=" + gamePauses + "\n");
        } catch (Throwable error) { results.putString("stream", "FAIL: " + error + "\n"); code = Activity.RESULT_CANCELED; }
        finally {
            GameActivity game = GameActivity.running(); if (game != null) host.runOnMainSync(game::finish);
            application.unregisterActivityLifecycleCallbacks(observer);
            if (preferencesRead) try { if (previousPreferences == null) java.nio.file.Files.deleteIfExists(preferences.toPath()); else java.nio.file.Files.write(preferences.toPath(), previousPreferences); }
            catch (Exception error) { code = Activity.RESULT_CANCELED; results.putString("stream", "FAIL: cannot restore prior audio settings: " + error + "\n"); }
            if (map != null) MapLibrary.deleteLocal(map);
            host.finish(code, results);
        }
    }
}
