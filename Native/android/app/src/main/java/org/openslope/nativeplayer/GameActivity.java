package org.openslope.nativeplayer;

import android.app.NativeActivity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.ComponentName;
import android.widget.Toast;
import java.io.File;

public final class GameActivity extends NativeActivity {
    private volatile String error;
    private boolean returning;
    public String getMapPath() { return getIntent().getStringExtra("map_path"); }
    public String getRunMode() { String mode=getIntent().getStringExtra("run_mode");return mode==null?"freeride":mode; }
    public double getRenderScale(){return getIntent().getDoubleExtra("render_scale",1.0);}
    public int getMsaa(){return getIntent().getIntExtra("msaa",4);}
    public void reportError(String message) { error = message; runOnUiThread(() -> Toast.makeText(this, message, Toast.LENGTH_LONG).show()); }
    @Override public void finish() {
        if (!returning) {
            returning = true;
            // Horizon OS's documented immersive -> Home panel transition.
            Intent panel = new Intent(this, LauncherActivity.class).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (error != null) panel.putExtra("map_error", error);
            PendingIntent pending = PendingIntent.getActivity(this, 0, panel, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            home.putExtra("extra_launch_in_home_pending_intent", pending);
            ComponentName destination = home.resolveActivity(getPackageManager());
            if (destination != null) startActivity(new Intent(home).setComponent(destination));
            else startActivity(panel);
        }
        super.finishAndRemoveTask();
    }
    @Override protected void onDestroy() {
        super.onDestroy();
        if (getIntent().getBooleanExtra("map_cache", false)) {
            String path = getMapPath(); if (path != null) { File file = new File(path); if (file.getParentFile().equals(getCacheDir()) && file.getName().startsWith("play-")) MapLibrary.deleteLocal(file); }
        }
    }
}
