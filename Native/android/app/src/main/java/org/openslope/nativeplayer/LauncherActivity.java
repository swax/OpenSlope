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
    static native String nativeCourseDisplayName(String name);
    private static final int PICK_MAPS = 1, PICK_ISO = 2, PICK_AVATAR = 3;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled, busy;
    private boolean destroyed;
    private LauncherUi screen;
    private LinearLayout courses;
    private TextView location, status;
    private Button chooseFolder, useLocal, importIso, refresh, cancel;
    private MapLibrary library;
    private Spinner runMode;
    private Spinner renderScale,targetRefreshRate,antialiasing;
    private String libraryNotice;
    private boolean noticeError;
    private long lastProgress;
    private native String nativeAvatars(String preferences);
    private native void nativeChooseAvatar(String preferences, String id);
    private native void nativeValidateAvatar(String path);
    private boolean updatingAvatar;
    private String avatarSelected;
    private String avatarPreferences() { return new File(getFilesDir(), "avatar-preferences.json").getAbsolutePath(); }
    private void refreshAvatars() {
        try {
            JSONObject catalog = new JSONObject(nativeAvatars(avatarPreferences()));
            JSONArray options = catalog.getJSONArray("options");
            List<String> labels = new ArrayList<>(), ids = new ArrayList<>();
            avatarSelected = catalog.getString("selected"); int selected = 0;
            for (int i = 0; i < options.length(); ++i) {
                JSONObject option = options.getJSONObject(i); labels.add(option.getString("label")); ids.add(option.getString("id"));
                if (ids.get(i).equals(avatarSelected)) selected = i;
            }
            updatingAvatar = true;
            ArrayAdapter<String> adapter = new ArrayAdapter<>(this, R.layout.launcher_choice, labels);
            adapter.setDropDownViewResource(R.layout.launcher_choice_item); screen.avatar.setAdapter(adapter); screen.avatar.setSelection(selected);
            updatingAvatar = false;
            screen.avatar.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
                public void onNothingSelected(AdapterView<?> parent) {}
                public void onItemSelected(AdapterView<?> parent, View view, int position, long row) {
                    if (updatingAvatar || ids.get(position).equals(avatarSelected)) return;
                    final String id = ids.get(position); state(true, false);
                    worker.execute(() -> {
                        try { nativeChooseAvatar(avatarPreferences(), id); ui(() -> avatarSelected = id); }
                        catch (Exception error) { failure(error); }
                        finally { ui(() -> { state(false); refreshAvatars(); }); }
                    });
                }
            });
        } catch (Exception error) { failure(error); }
    }
    private void pickAvatar() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT); intent.setType("*/*"); intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(intent, PICK_AVATAR); } catch (ActivityNotFoundException error) { failure(error); }
    }
    private void importAvatar(Uri uri) {
        state(true, false);
        worker.execute(() -> {
            File staging = null;
            try {
                staging = File.createTempFile("avatar-", ".glb", getCacheDir());
                try (InputStream input = getContentResolver().openInputStream(uri); OutputStream output = new FileOutputStream(staging)) {
                    if (input == null) throw new IOException("The avatar file could not be opened.");
                    byte[] buffer = new byte[65536]; int count; long size = 0;
                    while ((count = input.read(buffer)) != -1) { size += count; if (size > 32L * 1024 * 1024) throw new IOException("Avatars must be smaller than 32 MiB."); output.write(buffer, 0, count); }
                }
                nativeValidateAvatar(staging.getAbsolutePath());
                String label = "Custom avatar";
                try (android.database.Cursor cursor = getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) label = cursor.getString(0);
                } catch (Exception ignored) { /* A provider may omit the display name. */ }
                label = label.replaceAll("(?i)\\.glb$", "").replaceAll("[^a-zA-Z0-9 _-]", "_");
                if (label.length() > 80) label = label.substring(0, 80);
                File library = new File(getFilesDir(), "characters"); if (!library.isDirectory() && !library.mkdirs()) throw new IOException("Cannot create avatar library.");
                File destination = new File(library, label + "-" + UUID.randomUUID().toString().substring(0, 8) + ".glb");
                java.nio.file.Files.move(staging.toPath(), destination.toPath()); staging = null;
                nativeChooseAvatar(avatarPreferences(), destination.getName());
                setStatus("Custom avatar added.");
            } catch (Exception error) { failure(error); }
            finally { if (staging != null) staging.delete(); ui(() -> { state(false); refreshAvatars(); }); }
        });
    }
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
        runMode = screen.runMode; renderScale = screen.renderScale; targetRefreshRate = screen.targetRefreshRate; antialiasing = screen.antialiasing;
        chooseFolder = screen.chooseFolder; useLocal = screen.useLocal; importIso = screen.importIso; refresh = screen.refresh; cancel = screen.cancel;
        String savedMode=getPreferences(0).getString("run_mode","freeride");runMode.setSelection(savedMode.equals("race")?1:savedMode.equals("showoff")?2:0);
        runMode.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener(){public void onNothingSelected(AdapterView<?> parent){}public void onItemSelected(AdapterView<?> parent,View view,int position,long id){String mode=new String[]{"freeride","race","showoff"}[position];if(!mode.equals(getPreferences(0).getString("run_mode","freeride")))getPreferences(0).edit().putString("run_mode",mode).apply();screen.modeHint.setText(new int[]{R.string.mode_freeride_hint,R.string.mode_race_hint,R.string.mode_showoff_hint}[position]);}});
        choice(renderScale,"render_scale",2); choice(targetRefreshRate,"target_refresh_rate",3); choice(antialiasing,"antialiasing",2);
        screen.importAvatar.setOnClickListener(v -> pickAvatar());
        refreshAvatars();
        chooseFolder.setOnClickListener(v -> pickMaps());
        useLocal.setOnClickListener(v -> { getPreferences(0).edit().remove("maps_tree").apply(); loadLibrary(); refreshMaps(null); });
        importIso.setOnClickListener(v -> pickIso()); refresh.setOnClickListener(v -> refreshMaps(null));
        cancel.setOnClickListener(v -> { cancelled = true; cancel.setEnabled(false); setStatus(getString(R.string.cancelling)); });
        screen.close.setOnClickListener(v -> finishAndRemoveTask());
        try { loadLibrary(); refreshMaps(getIntent().getStringExtra("map_error")); }
        catch (Exception e) { screen.libraryError(); failure(e); }
    }
    @Override public void onResume() { super.onResume(); if (library != null && !busy) { refreshMaps(); refreshAvatars(); } }
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
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { startActivityForResult(intent, PICK_ISO); } catch (ActivityNotFoundException e) { setStatus(getString(R.string.iso_picker_missing)); }
    }
    static List<Uri> selectedIsoUris(Intent data) {
        LinkedHashSet<Uri> sources = new LinkedHashSet<>();
        ClipData clips = data.getClipData();
        if (clips != null) for (int i = 0; i < clips.getItemCount(); ++i) {
            Uri uri = clips.getItemAt(i).getUri(); if (uri != null) sources.add(uri);
        }
        if (data.getData() != null) sources.add(data.getData());
        return new ArrayList<>(sources);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null) return;
        if (request == PICK_AVATAR) { if (data.getData() != null) importAvatar(data.getData()); }
        else if (request == PICK_MAPS) {
            Uri uri = data.getData(); if (uri == null) return;
            try {
                if ((data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) throw new IOException("The selected folder did not grant read access.");
                if ((data.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0)
                    getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                else getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getPreferences(0).edit().putString("maps_tree", uri.toString()).apply(); loadLibrary(); refreshMaps(null);
            } catch (Exception e) { failure(e); }
        } else if (request == PICK_ISO) {
            List<Uri> sources = selectedIsoUris(data); if (!sources.isEmpty()) scanIsos(sources);
        }
    }
    private void refreshMaps() { refreshMaps(libraryNotice); }
    private void refreshMaps(String notice) {
        if (busy) return; final boolean error = notice != null && ((notice.equals(libraryNotice) && noticeError) || notice.equals(getIntent().getStringExtra("map_error")));
        libraryNotice = notice; noticeError = error; state(true, false); setStatus(getString(R.string.reading_maps)); final MapLibrary selected = library;
        worker.execute(() -> {
            try { List<MapLibrary.Entry> maps = selected.maps(); ui(() -> {
                screen.maps(maps, this::play, this::confirmUnload); state(false); screen.status(notice == null ? "" : notice, error);
            }); } catch (Exception e) { ui(() -> { state(false); screen.libraryError(); failure(e); }); }
        });
    }
    private void confirmUnload(MapLibrary.Entry map) {
        if (busy) return;
        new AlertDialog.Builder(this).setTitle("Unload " + nativeCourseDisplayName(map.name) + "?")
            .setMessage("This deletes this course's files from the selected Maps folder, including any local edits. Other courses are kept. You can import it again from your ISO or restore a copy of a custom map.")
            .setPositiveButton("Unload course", (dialog, which) -> unload(map))
            .setNegativeButton("Cancel", null).show();
    }
    private void unload(MapLibrary.Entry map) {
        if (busy) return;
        state(true, false); setStatus("Unloading " + nativeCourseDisplayName(map.name) + "…"); final MapLibrary selected = library;
        worker.execute(() -> {
            String result;
            try { selected.unload(map); result = "Unloaded " + nativeCourseDisplayName(map.name) + ". Import it again to reload its course data."; }
            catch (Exception e) { result = e.getMessage() == null ? e.toString() : e.getMessage(); }
            final String notice = result; ui(() -> { state(false); refreshMaps(notice); });
        });
    }
    private long discLength(ParcelFileDescriptor file) throws IOException {
        if (file == null) throw new IOException("Cannot open the selected ISO.");
        try { long length = Os.lseek(file.getFileDescriptor(), 0, OsConstants.SEEK_END); if (length < 17L * 2048) throw new IOException("The selected file is too small to be an ISO."); return length; }
        catch (android.system.ErrnoException e) { throw new IOException("This ISO provider is not seekable. Copy the ISO to the headset's local storage and select that copy.", e); }
    }
    static final class IsoCourse {
        final Uri uri;
        final String name, source;
        IsoCourse(Uri uri, String name, String source) { this.uri = uri; this.name = name; this.source = source; }
        @Override public String toString() { return nativeCourseDisplayName(name) + " · " + source; }
    }
    private String sourceName(Uri uri) {
        try (android.database.Cursor cursor = getContentResolver().query(uri, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0); if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) { }
        return uri.getLastPathSegment() == null ? uri.toString() : uri.getLastPathSegment();
    }
    private void scanIsos(List<Uri> sources) {
        if (busy) return;
        state(true); setStatus(getString(R.string.reading_iso));
        worker.execute(() -> {
            LinkedHashMap<String, IsoCourse> found = new LinkedHashMap<>(); ArrayList<String> errors = new ArrayList<>();
            for (Uri uri : sources) {
                if (cancelled) break;
                String source = sourceName(uri); setStatus(getString(R.string.reading_iso) + " " + source);
                try (ParcelFileDescriptor file = getContentResolver().openFileDescriptor(uri, "r")) {
                    long length = discLength(file); JSONArray rows = new JSONArray(nativeCourses(file.getFd(), length)); checkCancelled();
                    if (rows.length() == 0) throw new IOException(getString(R.string.no_iso_courses));
                    for (int i = 0; i < rows.length(); ++i) {
                        String name = rows.getString(i); found.putIfAbsent(name, new IsoCourse(uri, name, source));
                    }
                } catch (Exception e) { errors.add(source + ": " + (e.getMessage() == null ? e.toString() : e.getMessage())); }
            }
            ui(() -> {
                state(false);
                if (cancelled) { screen.status(getString(R.string.import_cancelled), false); return; }
                showImportChoices(new ArrayList<>(found.values()), String.join("\n", errors));
            });
        });
    }
    private AlertDialog showImportChoices(List<IsoCourse> choices, String warnings) {
        if (choices.isEmpty()) {
            libraryNotice = warnings.isEmpty() ? getString(R.string.no_iso_courses) : warnings; noticeError = true;
            screen.status(libraryNotice, true); return null;
        }
        boolean[] selected = new boolean[choices.size()];
        LinearLayout heading = new LinearLayout(this); heading.setOrientation(LinearLayout.VERTICAL); heading.setPadding(screen.dp(24), screen.dp(20), screen.dp(24), screen.dp(8));
        TextView title = new TextView(this); title.setText(R.string.import_title); title.setTextSize(22); title.setTypeface(null, android.graphics.Typeface.BOLD); title.setAccessibilityHeading(true); heading.addView(title);
        TextView hint = new TextView(this); hint.setText(R.string.import_scope); hint.setTextSize(18); hint.setTextColor(getColor(R.color.launcher_secondary)); hint.setPadding(0, screen.dp(12), 0, screen.dp(4)); heading.addView(hint);
        if (!warnings.isEmpty()) hint.append("\n\n" + warnings);
        Button selectAll = screen.dialogButton(heading, R.id.launcher_select_all, R.string.select_all);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(R.string.import_title).setCustomTitle(heading)
            .setMultiChoiceItems(choices.stream().map(IsoCourse::toString).toArray(String[]::new), selected, (choice, which, checked) -> { selected[which] = checked; updateImportChoice((AlertDialog) choice, selected, selectAll); })
            .setPositiveButton(R.string.import_action, (choice, which) -> { ArrayList<IsoCourse> chosen = new ArrayList<>(); for (int i = 0; i < choices.size(); ++i) if (selected[i]) chosen.add(choices.get(i)); if (!chosen.isEmpty()) importCourses(chosen); })
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
    private void importCourses(List<IsoCourse> choices) {
        if (busy) return;
        state(true); final MapLibrary destination = library;
        worker.execute(() -> {
            int imported = 0, skipped = 0; ArrayList<String> errors = new ArrayList<>();
            for (IsoCourse choice : choices) {
                if (cancelled) break;
                String name = choice.name;
                String label = nativeCourseDisplayName(name);
                try {
                    if (destination.exists(name)) { ++skipped; continue; }
                    setStatus("Importing " + label + " · " + choice.source + "…");
                    try (ParcelFileDescriptor file = getContentResolver().openFileDescriptor(choice.uri, "r")) {
                        long length = discLength(file);
                        File staging = destination.importPath(getCacheDir());
                        try { nativeExtract(file.getFd(), length, name, staging.getAbsolutePath()); checkCancelled(); setStatus("Writing " + label + " into Maps…"); destination.publishImport(name, staging, this::checkCancelled); ++imported; }
                        finally { MapLibrary.deleteLocal(staging); }
                    }
                } catch (Exception e) { if (!cancelled) errors.add(label + " · " + choice.source + ": " + (e.getMessage() == null ? e.toString() : e.getMessage())); }
            }
            String outcome = "Imported " + imported + " courses. Kept " + skipped + " existing maps.";
            if (cancelled) outcome += " " + getString(R.string.import_cancelled);
            if (!errors.isEmpty()) outcome += "\n" + String.join("\n", errors);
            final boolean failed = !errors.isEmpty();
            final String message = outcome; ui(() -> { libraryNotice = message; noticeError = failed; state(false); refreshMaps(message); });
        });
    }
    private void play(MapLibrary.Entry map) {
        if (busy) return;
        libraryNotice = null; noticeError = false;
        final String mode=new String[]{"freeride","race","showoff"}[runMode.getSelectedItemPosition()];
        final double scale=1+renderScale.getSelectedItemPosition()*.25;final int samples=1<<antialiasing.getSelectedItemPosition();
        final double refreshRate=new double[]{72,80,90,120}[targetRefreshRate.getSelectedItemPosition()];
        state(true); setStatus(getString(R.string.loading_course, nativeCourseDisplayName(map.name))); final MapLibrary selected = library;
        worker.execute(() -> {
            File prepared = null;
            try { prepared = selected.prepare(map, getCacheDir(), this::checkCancelled); nativeValidate(prepared.getAbsolutePath()); checkCancelled(); final File path = prepared;
                ui(() -> { if (cancelled) { if (selected.tree != null) MapLibrary.deleteLocal(path); state(false); setStatus(getString(R.string.loading_cancelled)); return; } state(false); Intent intent = new Intent(this, GameActivity.class); intent.setAction(Intent.ACTION_MAIN); intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); intent.addCategory("com.oculus.intent.category.VR"); intent.addCategory("org.khronos.openxr.intent.category.IMMERSIVE_HMD"); intent.putExtra("map_path", path.getAbsolutePath()); intent.putExtra("map_name", map.name); intent.putExtra("map_cache", selected.tree != null);intent.putExtra("run_mode",mode);intent.putExtra("render_scale",scale);intent.putExtra("target_refresh_rate",refreshRate);intent.putExtra("msaa",samples); startActivity(intent); finishAndRemoveTask(); });
            } catch (Exception e) { if (prepared != null && selected.tree != null) MapLibrary.deleteLocal(prepared); ui(() -> { state(false); failure(e); }); }
        });
    }
}
