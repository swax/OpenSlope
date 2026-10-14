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
    private LinearLayout layout, courses;
    private TextView location, status;
    private Button chooseFolder, useLocal, importIso, refresh, cancel;
    private MapLibrary library;
    private Spinner runMode;
    private Spinner renderScale,antialiasing;
    private native String nativeCourses(int descriptor, long length);
    private native void nativeExtract(int descriptor, long length, String course, String output);
    private native void nativeValidate(String path);

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        ScrollView scroll = new ScrollView(this); layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(32, 24, 32, 24); scroll.addView(layout); setContentView(scroll);
        text("OpenSlope", 28); text("Choose a course from your Maps folder. Importing an ISO adds courses to the same library.", 18);
        location = text("", 14);
        text("Event", 16);runMode=new Spinner(this);ArrayAdapter<String> modes=new ArrayAdapter<>(this,android.R.layout.simple_spinner_item,new String[]{"Freeride","Race","Showoff"});modes.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);runMode.setAdapter(modes);layout.addView(runMode);
        String savedMode=getPreferences(0).getString("run_mode","freeride");runMode.setSelection(savedMode.equals("race")?1:savedMode.equals("showoff")?2:0);
        runMode.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> parent){}public void onItemSelected(AdapterView<?> parent,View view,int position,long id){getPreferences(0).edit().putString("run_mode",new String[]{"freeride","race","showoff"}[position]).apply();}});
        renderScale=choice("VR resolution",new String[]{"100% (runtime recommendation)","125% (sharper)","150% (sharpest)"},"render_scale",0);
        antialiasing=choice("Edge smoothing",new String[]{"Off","2x","4x"},"antialiasing",2);
        chooseFolder = button("Choose Maps folder", this::pickMaps);
        useLocal = button("Use app Maps folder", () -> { getPreferences(0).edit().remove("maps_tree").apply(); loadLibrary(); refreshMaps(); });
        importIso = button("Import SSX Tricky ISO", this::pickIso);
        refresh = button("Refresh courses", this::refreshMaps);
        cancel = button("Cancel", () -> { cancelled = true; cancel.setEnabled(false); setStatus("Cancelling…"); }); cancel.setVisibility(View.GONE);
        status = text("", 16); courses = new LinearLayout(this); courses.setOrientation(LinearLayout.VERTICAL); layout.addView(courses);
        loadLibrary(); refreshMaps(getIntent().getStringExtra("map_error"));
    }
    @Override public void onResume() { super.onResume(); if (library != null && !busy) refreshMaps(); }
    @Override public void onDestroy() { destroyed = true; cancelled = true; worker.shutdown(); super.onDestroy(); }
    private TextView text(String value, int size) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setPadding(0, 8, 0, 8); layout.addView(view); return view; }
    private Spinner choice(String label,String[] labels,String preference,int fallback){text(label,16);Spinner view=new Spinner(this);ArrayAdapter<String> adapter=new ArrayAdapter<>(this,android.R.layout.simple_spinner_item,labels);adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);view.setAdapter(adapter);layout.addView(view);int saved=getPreferences(0).getInt(preference,fallback);view.setSelection(saved>=0&&saved<labels.length?saved:fallback);view.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> parent){}public void onItemSelected(AdapterView<?> parent,View selected,int position,long id){getPreferences(0).edit().putInt(preference,position).apply();}});return view;}
    private Button button(String label, Runnable action) { Button view = new Button(this); view.setText(label); view.setOnClickListener(v -> action.run()); layout.addView(view); return view; }
    private void ui(Runnable action) { runOnUiThread(() -> { if (!destroyed) action.run(); }); }
    private void setStatus(String message) { ui(() -> status.setText(message)); }
    // Native callbacks run on the import worker, including cancellation probes.
    public boolean isImportCancelled() { return cancelled; }
    public void onImportProgress(String message) { setStatus(message); }
    private void checkCancelled() throws IOException { if (cancelled) throw new IOException("Import cancelled."); }
    private void state(boolean importing) {
        busy = importing; if (importing) cancelled = false;
        runMode.setEnabled(!importing);
        renderScale.setEnabled(!importing);antialiasing.setEnabled(!importing);
        chooseFolder.setEnabled(!importing); useLocal.setEnabled(!importing); importIso.setEnabled(!importing); refresh.setEnabled(!importing);
        cancel.setVisibility(importing ? View.VISIBLE : View.GONE); cancel.setEnabled(importing);
        for (int i = 0; i < courses.getChildCount(); ++i) courses.getChildAt(i).setEnabled(!importing);
    }
    private void failure(Exception exception) { setStatus(exception.getMessage() == null ? exception.toString() : exception.getMessage()); }
    private void loadLibrary() {
        String saved = getPreferences(0).getString("maps_tree", null);
        File base = getExternalFilesDir(null); if (base == null) base = getFilesDir();
        library = new MapLibrary(getContentResolver(), new File(base, "Maps"), saved == null ? null : Uri.parse(saved));
        location.setText(saved == null ? "Maps folder: " + library.localRoot : "Maps folder: " + android.provider.DocumentsContract.getTreeDocumentId(library.tree));
    }
    private void pickMaps() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_MAPS); } catch (ActivityNotFoundException e) { setStatus("A system folder picker is unavailable. Use the app Maps folder, or install a document provider."); }
    }
    private void pickIso() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.setType("*/*"); intent.addCategory(Intent.CATEGORY_OPENABLE); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_ISO); } catch (ActivityNotFoundException e) { setStatus("A system file picker is unavailable on this headset."); }
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
                getPreferences(0).edit().putString("maps_tree", uri.toString()).apply(); loadLibrary(); refreshMaps();
            } catch (Exception e) { failure(e); }
        } else if (request == PICK_ISO) scanIso(uri);
    }
    private void refreshMaps() { refreshMaps(null); }
    private void refreshMaps(String notice) {
        if (busy) return; state(true); setStatus("Reading Maps folder…"); final MapLibrary selected = library;
        worker.execute(() -> {
            try { List<MapLibrary.Entry> maps = selected.maps(); ui(() -> {
                courses.removeAllViews(); for (MapLibrary.Entry map : maps) { Button play = new Button(this); play.setText(getString(R.string.play_course, map.name)); play.setOnClickListener(v -> play(map)); courses.addView(play); }
                state(false); status.setText(notice != null ? notice + "\n" + maps.size() + " courses available." : maps.isEmpty() ? "No courses yet. Choose a populated Maps folder or import an ISO." : maps.size() + " courses available.");
            }); } catch (Exception e) { ui(() -> { state(false); failure(e); }); }
        });
    }
    private long discLength(ParcelFileDescriptor file) throws IOException {
        if (file == null) throw new IOException("Cannot open the selected ISO.");
        try { long length = Os.lseek(file.getFileDescriptor(), 0, OsConstants.SEEK_END); if (length < 17L * 2048) throw new IOException("The selected file is too small to be an ISO."); return length; }
        catch (android.system.ErrnoException e) { throw new IOException("This ISO provider is not seekable. Copy the ISO to the headset's local storage and select that copy.", e); }
    }
    private void scanIso(Uri uri) {
        state(true); setStatus("Reading disc courses…");
        worker.execute(() -> {
            try (ParcelFileDescriptor file = getContentResolver().openFileDescriptor(uri, "r")) {
                long length = discLength(file); JSONArray rows = new JSONArray(nativeCourses(file.getFd(), length)); ArrayList<String> names = new ArrayList<>();
                for (int i = 0; i < rows.length(); ++i) names.add(rows.getString(i));
                ui(() -> { state(false); boolean[] selected = new boolean[names.size()]; Arrays.fill(selected, true);
                    new AlertDialog.Builder(this).setTitle("Import courses into Maps")
                        .setMessage(null).setMultiChoiceItems(names.toArray(new String[0]), selected, (dialog, which, checked) -> selected[which] = checked)
                        .setPositiveButton("Import", (dialog, which) -> { ArrayList<String> chosen = new ArrayList<>(); for (int i = 0; i < names.size(); ++i) if (selected[i]) chosen.add(names.get(i)); if (!chosen.isEmpty()) importCourses(uri, chosen); })
                        .setNegativeButton("Cancel", null).show();
                    status.setText(R.string.import_scope);
                });
            } catch (Exception e) { ui(() -> { state(false); failure(e); }); }
        });
    }
    private void importCourses(Uri uri, List<String> names) {
        state(true); final MapLibrary destination = library;
        worker.execute(() -> {
            int imported = 0, skipped = 0; String outcome;
            try (ParcelFileDescriptor file = getContentResolver().openFileDescriptor(uri, "r")) {
                long length = discLength(file);
                for (String name : names) {
                    checkCancelled(); if (destination.exists(name)) { ++skipped; continue; }
                    File staging = new File(getCacheDir(), "import-" + UUID.randomUUID());
                    try { nativeExtract(file.getFd(), length, name, staging.getAbsolutePath()); checkCancelled(); setStatus("Writing " + name + " into Maps…"); destination.publish(name, staging, this::checkCancelled); ++imported; }
                    finally { MapLibrary.deleteLocal(staging); }
                }
                outcome = "Imported " + imported + " courses. Kept " + skipped + " existing maps.";
            } catch (Exception e) { outcome = "Imported " + imported + " courses. " + (e.getMessage() == null ? e.toString() : e.getMessage()); }
            final String message = outcome; ui(() -> { state(false); refreshMaps(message); });
        });
    }
    private void play(MapLibrary.Entry map) {
        final String mode=new String[]{"freeride","race","showoff"}[runMode.getSelectedItemPosition()];
        final double scale=1+renderScale.getSelectedItemPosition()*.25;final int samples=1<<antialiasing.getSelectedItemPosition();
        state(true); setStatus("Loading " + map.name + "…"); final MapLibrary selected = library;
        worker.execute(() -> {
            File prepared = null;
            try { prepared = selected.prepare(map, getCacheDir(), this::checkCancelled); nativeValidate(prepared.getAbsolutePath()); checkCancelled(); final File path = prepared;
                ui(() -> { if (cancelled) { if (selected.tree != null) MapLibrary.deleteLocal(path); state(false); setStatus("Loading cancelled."); return; } state(false); Intent intent = new Intent(this, GameActivity.class); intent.setAction(Intent.ACTION_MAIN); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); intent.addCategory("com.oculus.intent.category.VR"); intent.addCategory("org.khronos.openxr.intent.category.IMMERSIVE_HMD"); intent.putExtra("map_path", path.getAbsolutePath()); intent.putExtra("map_cache", selected.tree != null);intent.putExtra("run_mode",mode);intent.putExtra("render_scale",scale);intent.putExtra("msaa",samples); startActivity(intent); finishAndRemoveTask(); });
            } catch (Exception e) { if (prepared != null && selected.tree != null) MapLibrary.deleteLocal(prepared); ui(() -> { state(false); failure(e); }); }
        });
    }
}
