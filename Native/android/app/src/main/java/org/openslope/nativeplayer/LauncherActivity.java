package org.openslope.nativeplayer;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import android.system.Os;
import android.system.OsConstants;
import android.view.View;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

public final class LauncherActivity extends Activity {
    static { System.loadLibrary("openslope_player"); }
    private static final int PICK_MAPS = 1, PICK_ISO = 2;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled, busy;
    private boolean destroyed;
    private LauncherUi screen;
    private LinearLayout courses;
    private TextView location, status;
    private Button chooseFolder, useLocal, importIso, refresh, cancel;
    private MapLibrary library;
    private Spinner runMode;
    private Spinner renderScale,targetRefreshRate,antialiasing,steeringMode;
    private String libraryNotice;
    private boolean noticeError;
    private long lastProgress;
    private native String nativeCourses(int descriptor, long length);
    private native void nativeExtract(int descriptor, long length, String course, String output);
    private native void nativeValidate(String path);

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        GameActivity game = GameActivity.running();
        if (game != null && !getIntent().getBooleanExtra("show_library", false)) {
            startActivity(new Intent(game.getIntent()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            finishAndRemoveTask(); return;
        }
        screen = new LauncherUi(this); setContentView(screen.root);
        location = screen.location; status = screen.status; courses = screen.courses;
        runMode = screen.runMode; renderScale = screen.renderScale; targetRefreshRate = screen.targetRefreshRate; antialiasing = screen.antialiasing; steeringMode = screen.steeringMode;
        chooseFolder = screen.chooseFolder; useLocal = screen.useLocal; importIso = screen.importIso; refresh = screen.refresh; cancel = screen.cancel;
        String savedMode=getPreferences(0).getString("run_mode","freeride");runMode.setSelection(savedMode.equals("race")?1:savedMode.equals("showoff")?2:0);
        runMode.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> parent){}public void onItemSelected(AdapterView<?> parent,View view,int position,long id){String mode=new String[]{"freeride","race","showoff"}[position];if(!mode.equals(getPreferences(0).getString("run_mode","freeride")))getPreferences(0).edit().putString("run_mode",mode).apply();screen.modeHint.setText(new int[]{R.string.mode_freeride_hint,R.string.mode_race_hint,R.string.mode_showoff_hint}[position]);}});
        choice(renderScale,"render_scale",2); choice(targetRefreshRate,"target_refresh_rate",3); choice(antialiasing,"antialiasing",2); choice(steeringMode,"steering_mode",0);
        chooseFolder.setOnClickListener(v -> pickMaps());
        useLocal.setOnClickListener(v -> { getPreferences(0).edit().remove("maps_tree").apply(); loadLibrary(); refreshMaps(null); });
        importIso.setOnClickListener(v -> pickIso()); refresh.setOnClickListener(v -> refreshMaps(null));
        cancel.setOnClickListener(v -> { cancelled = true; cancel.setEnabled(false); setStatus(getString(R.string.cancelling)); });
        screen.close.setOnClickListener(v -> finishAndRemoveTask());
        try { loadLibrary(); refreshMaps(getIntent().getStringExtra("map_error")); }
        catch (Exception e) { screen.libraryError(); failure(e); }
    }
    @Override public void onResume() { super.onResume(); if (library != null && !busy) refreshMaps(); }
    @Override public void onDestroy() { destroyed = true; cancelled = true; worker.shutdown(); super.onDestroy(); }
    @Override public void onBackPressed() { if (!busy && screen.collapse()) return; finishAndRemoveTask(); }
    private void choice(Spinner view,String preference,int fallback){int saved=getPreferences(0).getInt(preference,fallback);view.setSelection(saved>=0&&saved<view.getCount()?saved:fallback);view.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> parent){}public void onItemSelected(AdapterView<?> parent,View selected,int position,long id){if(position!=getPreferences(0).getInt(preference,fallback))getPreferences(0).edit().putInt(preference,position).apply();}});}
    private void ui(Runnable action) { runOnUiThread(() -> { if (!destroyed) action.run(); }); }
    private void setStatus(String message) { ui(() -> screen.status(message, false)); }
    // Native callbacks run on the import worker, including cancellation probes.
    public boolean isImportCancelled() { return cancelled; }
    public void onImportProgress(String message) { long now = SystemClock.uptimeMillis(); if (!cancelled && now - lastProgress >= 750) { lastProgress = now; ui(() -> { if (!cancelled) screen.status(message, false); }); } }
    private void checkCancelled() throws IOException { if (cancelled) throw new IOException("Import cancelled."); }
    private void state(boolean importing) { state(importing, true); }
    private void state(boolean importing, boolean cancellable) {
        busy = importing; if (importing) cancelled = false;
        screen.busy(importing, cancellable);
    }
    private void failure(Exception exception) { ui(() -> { libraryNotice = exception.getMessage() == null ? getString(R.string.operation_failed) : exception.getMessage(); noticeError = true; screen.status(libraryNotice, true); }); }
    private void loadLibrary() {
        String saved = getPreferences(0).getString("maps_tree", null);
        File base = getExternalFilesDir(null); if (base == null) base = getFilesDir();
        library = new MapLibrary(getContentResolver(), new File(base, "Maps"), saved == null ? null : Uri.parse(saved));
        screen.source.setText(saved == null ? R.string.app_maps_source : R.string.selected_maps_source);
        location.setText(saved == null ? library.localRoot.toString() : android.provider.DocumentsContract.getTreeDocumentId(library.tree));
        useLocal.setVisibility(saved == null ? View.GONE : View.VISIBLE);
    }
    private void pickMaps() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_MAPS); } catch (ActivityNotFoundException e) { setStatus(getString(R.string.folder_picker_missing)); }
    }
    private void pickIso() {
        libraryNotice = null; noticeError = false;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.setType("*/*"); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_ISO); } catch (ActivityNotFoundException e) { setStatus(getString(R.string.iso_picker_missing)); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        if (request == PICK_MAPS) {
            try {
                if ((data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) throw new IOException("The selected folder did not grant read access.");
                if ((data.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0)
                    getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                else getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getPreferences(0).edit().putString("maps_tree", uri.toString()).apply(); loadLibrary(); refreshMaps(null);
            } catch (Exception e) { failure(e); }
        } else if (request == PICK_ISO) scanIso(uri);
    }
    private void refreshMaps() { refreshMaps(libraryNotice); }
    private void refreshMaps(String notice) {
        if (busy) return; final boolean error = notice != null && ((notice.equals(libraryNotice) && noticeError) || notice.equals(getIntent().getStringExtra("map_error")));
        libraryNotice = notice; noticeError = error; state(true, false); setStatus(getString(R.string.reading_maps)); final MapLibrary selected = library;
        worker.execute(() -> {
            try { List<MapLibrary.Entry> maps = selected.maps(); ui(() -> {
                screen.maps(maps, this::play); state(false); screen.status(notice == null ? "" : notice, error);
            }); } catch (Exception e) { ui(() -> { state(false); screen.libraryError(); failure(e); }); }
        });
    }
    private long discLength(ParcelFileDescriptor file) throws IOException {
        if (file == null) throw new IOException("Cannot open the selected ISO.");
        try { long length = Os.lseek(file.getFileDescriptor(), 0, OsConstants.SEEK_END); if (length < 17L * 2048) throw new IOException("The selected file is too small to be an ISO."); return length; }
        catch (android.system.ErrnoException e) { throw new IOException("This ISO provider is not seekable. Copy the ISO to the headset's local storage and select that copy.", e); }
    }
    private void scanIso(Uri uri) {
        state(true, false); setStatus(getString(R.string.reading_iso));
        worker.execute(() -> {
            try (ParcelFileDescriptor file = getContentResolver().openFileDescriptor(uri, "r")) {
                long length = discLength(file); JSONArray rows = new JSONArray(nativeCourses(file.getFd(), length)); ArrayList<String> names = new ArrayList<>();
                for (int i = 0; i < rows.length(); ++i) names.add(rows.getString(i));
                ui(() -> { state(false); showImportChoices(uri, names); });
            } catch (Exception e) { ui(() -> { state(false); failure(e); }); }
        });
    }
    private AlertDialog showImportChoices(Uri uri, List<String> names) {
        if (names.isEmpty()) { screen.status(getString(R.string.no_iso_courses), true); return null; }
        boolean[] selected = new boolean[names.size()];
        LinearLayout heading = new LinearLayout(this); heading.setOrientation(LinearLayout.VERTICAL); heading.setPadding(screen.dp(24), screen.dp(20), screen.dp(24), screen.dp(8));
        TextView title = new TextView(this); title.setText(R.string.import_title); title.setTextSize(22); title.setTypeface(null, android.graphics.Typeface.BOLD); title.setAccessibilityHeading(true); heading.addView(title);
        TextView hint = new TextView(this); hint.setText(R.string.import_scope); hint.setTextSize(18); hint.setTextColor(getColor(R.color.launcher_secondary)); hint.setPadding(0, screen.dp(12), 0, screen.dp(4)); heading.addView(hint);
        Button selectAll = screen.dialogButton(heading, R.id.launcher_select_all, R.string.select_all);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(R.string.import_title).setCustomTitle(heading)
            .setMultiChoiceItems(names.toArray(new String[0]), selected, (choice, which, checked) -> { selected[which] = checked; updateImportChoice((AlertDialog) choice, selected, selectAll); })
            .setPositiveButton(R.string.import_action, (choice, which) -> { ArrayList<String> chosen = new ArrayList<>(); for (int i = 0; i < names.size(); ++i) if (selected[i]) chosen.add(names.get(i)); if (!chosen.isEmpty()) importCourses(uri, chosen); })
            .setNegativeButton(R.string.back, null).create();
        dialog.show();
        for (int which : new int[]{AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE}) { Button button = dialog.getButton(which); button.setMinHeight(screen.dp(60)); button.setTextSize(18); button.setAllCaps(false); }
        selectAll.setOnClickListener(v -> { boolean all = true; for (boolean value : selected) all &= value; Arrays.fill(selected, !all); for (int i = 0; i < selected.length; ++i) dialog.getListView().setItemChecked(i, !all); updateImportChoice(dialog, selected, selectAll); });
        updateImportChoice(dialog, selected, selectAll); screen.status(getString(R.string.import_scope), false);
        return dialog;
    }
    private void updateImportChoice(AlertDialog dialog, boolean[] selected, Button selectAll) {
        int count = 0; for (boolean value : selected) if (value) ++count;
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(count > 0);
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setText(count == 0 ? getString(R.string.import_action) : getString(R.string.import_selected, count));
        selectAll.setText(count == selected.length ? R.string.select_none : R.string.select_all);
    }
    private void importCourses(Uri uri, List<String> names) {
        state(true); final MapLibrary destination = library;
        worker.execute(() -> {
            int imported = 0, skipped = 0; String outcome;
            try (ParcelFileDescriptor file = getContentResolver().openFileDescriptor(uri, "r")) {
                long length = discLength(file);
                for (String name : names) {
                    checkCancelled(); if (destination.exists(name)) { ++skipped; continue; }
                    File staging = destination.importPath(getCacheDir());
                    try { nativeExtract(file.getFd(), length, name, staging.getAbsolutePath()); checkCancelled(); setStatus("Writing " + name + " into Maps…"); destination.publishImport(name, staging, this::checkCancelled); ++imported; }
                    finally { MapLibrary.deleteLocal(staging); }
                }
                outcome = "Imported " + imported + " courses. Kept " + skipped + " existing maps.";
            } catch (Exception e) { outcome = "Imported " + imported + " courses. " + (e.getMessage() == null ? e.toString() : e.getMessage()); }
            final String message = outcome; ui(() -> { state(false); refreshMaps(message); });
        });
    }
    private void play(MapLibrary.Entry map) {
        libraryNotice = null; noticeError = false;
        final String mode=new String[]{"freeride","race","showoff"}[runMode.getSelectedItemPosition()];
        final double scale=1+renderScale.getSelectedItemPosition()*.25;final int samples=1<<antialiasing.getSelectedItemPosition();
        final double refreshRate=new double[]{72,80,90,120}[targetRefreshRate.getSelectedItemPosition()];
        final boolean headSteering=steeringMode.getSelectedItemPosition()==1;
        state(true); setStatus(getString(R.string.loading_course, map.name)); final MapLibrary selected = library;
        worker.execute(() -> {
            File prepared = null;
            try { prepared = selected.prepare(map, getCacheDir(), this::checkCancelled); nativeValidate(prepared.getAbsolutePath()); checkCancelled(); final File path = prepared;
                ui(() -> { if (cancelled) { if (selected.tree != null) MapLibrary.deleteLocal(path); state(false); setStatus(getString(R.string.loading_cancelled)); return; } state(false); Intent intent = new Intent(this, GameActivity.class); intent.setAction(Intent.ACTION_MAIN); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); intent.addCategory("com.oculus.intent.category.VR"); intent.addCategory("org.khronos.openxr.intent.category.IMMERSIVE_HMD"); intent.putExtra("map_path", path.getAbsolutePath()); intent.putExtra("map_name", map.name); intent.putExtra("map_cache", selected.tree != null);intent.putExtra("run_mode",mode);intent.putExtra("render_scale",scale);intent.putExtra("target_refresh_rate",refreshRate);intent.putExtra("msaa",samples);intent.putExtra("head_steering",headSteering); startActivity(intent); finishAndRemoveTask(); });
            } catch (Exception e) { if (prepared != null && selected.tree != null) MapLibrary.deleteLocal(prepared); ui(() -> { state(false); failure(e); }); }
        });
    }
}
