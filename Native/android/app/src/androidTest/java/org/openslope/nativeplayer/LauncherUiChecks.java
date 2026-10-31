package org.openslope.nativeplayer;

import android.app.*;
import android.content.*;
import android.content.res.Configuration;
import android.graphics.*;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.lang.reflect.*;
import java.util.*;

/** Real panel views and worker-driven library states; never changes saved preferences or user maps. */
final class LauncherUiChecks {

    private final Instrumentation test;
    private int checks;

    private LauncherUiChecks(Instrumentation test) {
        this.test = test;
    }

    private void require(boolean value, String message) {
        ++checks;
        if (!value) throw new AssertionError(message);
    }

    private void main(Runnable action) {
        Throwable[] error = { null };
        test.runOnMainSync(() -> {
            try {
                action.run();
            } catch (Throwable failure) {
                error[0] = failure;
            }
        });
        if (error[0] != null) throw new AssertionError(error[0]);
    }

    private void select(Spinner spinner, String label) {
        for (int i = 0; i < spinner.getCount(); ++i) if (spinner.getItemAtPosition(i).toString().equals(label)) {
            spinner.setSelection(i);
            return;
        }
        throw new AssertionError("Missing game: " + label);
    }

    private void gameGroups(LauncherActivity activity, LauncherUi ui) {
        ArrayList<MapLibrary.Entry> maps = new ArrayList<>();
        for (int g = 0; g < 10; ++g) for (int m = 0; m < 10; ++m) {
            MapLibrary.Entry map = new MapLibrary.Entry(
                "BANK" + g + "_" + m,
                Uri.parse("file:///bank" + g + "/map" + m),
                true
            );
            map.game = "game " + g;
            map.displayName = "Run " + m;
            maps.add(map);
        }
        MapLibrary.Entry[] played = { null },
            unloaded = { null };
        main(() -> {
            ui.maps(maps, map -> played[0] = map, map -> unloaded[0] = map);
            require(
                ui.game.getCount() == 10 && ui.map.getCount() == 10,
                "100 maps become ten games with ten maps each"
            );
            require(ui.courses.getChildCount() == 2, "Only the selected map has Play and Unload actions");
            select(ui.game, "game 4");
        });
        laidOut(activity);
        test.waitForIdleSync();
        main(() -> {
            require(ui.map.getCount() == 10 && played[0] == null, "Changing game only filters its ten maps");
            ui.map.setSelection(7);
        });
        laidOut(activity);
        test.waitForIdleSync();
        main(() -> {
            require(played[0] == null && unloaded[0] == null, "Changing map never plays or unloads it");
            ui.courses.findViewById(R.id.launcher_play).performClick();
            ui.courses.findViewById(R.id.launcher_unload).performClick();
            require(
                played[0] == maps.get(47) && unloaded[0] == maps.get(47),
                "Explicit actions retain the selected map and source URI"
            );
            ui.maps(maps, map -> played[0] = map, map -> unloaded[0] = map);
            require(
                ui.game.getSelectedItem().equals("game 4") && ui.map.getSelectedItemPosition() == 7,
                "Refresh retains game and map selection"
            );
            select(ui.game, "game 5");
        });
        laidOut(activity);
        test.waitForIdleSync();
        main(() -> select(ui.game, "game 4"));
        laidOut(activity);
        test.waitForIdleSync();
        main(() -> {
            require(ui.map.getSelectedItemPosition() == 7, "Returning to a game remembers its last map");
            ui.maps(maps.subList(90, 100), map -> played[0] = map);
            require(
                ui.game.getCount() == 1 && ui.game.getSelectedItem().equals("game 9"),
                "Removing a game clears stale selections"
            );
        });
    }

    private Object get(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }

    private Object invoke(LauncherActivity activity, String name, Class<?>[] types, Object... values) throws Exception {
        Method method = LauncherActivity.class.getDeclaredMethod(name, types);
        method.setAccessible(true);
        return method.invoke(activity, values);
    }

    private void idle(LauncherActivity activity) throws Exception {
        for (int i = 0; i < 150; ++i) {
            test.waitForIdleSync();
            if (!((boolean) get(activity, "busy"))) {
                laidOut(activity);
                return;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("Library worker did not finish");
    }

    private void laidOut(LauncherActivity activity) {
        // Settle spinner callbacks even when Horizon suspends panel frames while unworn.
        for (int pass = 0; pass < 2; ++pass) {
            main(() -> {
                View root = activity.findViewById(R.id.launcher_root);
                // Horizon can suspend panel frames when unworn; exercise the real Android layout directly.
                require(root.getWidth() > 0 && root.getHeight() > 0, "System supplied panel bounds");
                root.forceLayout();
                root.measure(
                    View.MeasureSpec.makeMeasureSpec(root.getWidth(), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(root.getHeight(), View.MeasureSpec.EXACTLY)
                );
                root.layout(root.getLeft(), root.getTop(), root.getRight(), root.getBottom());
            });
            test.waitForIdleSync();
        }
    }

    private void library(LauncherActivity activity, File root) throws Exception {
        Field field = LauncherActivity.class.getDeclaredField("library");
        field.setAccessible(true);
        main(() -> {
            try {
                field.set(activity, new MapLibrary(activity.getContentResolver(), root, null));
                invoke(activity, "refreshMaps", new Class<?>[] { String.class }, (Object) null);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        idle(activity);
    }

    private void snapshot(View root, File folder, String name) throws IOException {
        root.measure(
            View.MeasureSpec.makeMeasureSpec(root.getWidth(), View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(root.getHeight(), View.MeasureSpec.EXACTLY)
        );
        root.layout(root.getLeft(), root.getTop(), root.getRight(), root.getBottom());
        Bitmap image = Bitmap.createBitmap(root.getWidth(), root.getHeight(), Bitmap.Config.ARGB_8888);
        root.draw(new Canvas(image));
        try (OutputStream file = new FileOutputStream(new File(folder, name + ".png"))) {
            image.compress(Bitmap.CompressFormat.PNG, 100, file);
        } finally {
            image.recycle();
        }
    }

    private void controls(View view, float density) {
        if (view.getVisibility() != View.VISIBLE) return;
        if (view instanceof Button || view instanceof Spinner) {
            require(
                view.getMeasuredHeight() >= Math.round(60 * density),
                "Control has a 60dp target: " +
                    view.getClass().getSimpleName() +
                    " " +
                    (view instanceof TextView ? ((TextView) view).getText() : view.getId()) +
                    " height=" +
                    view.getMeasuredHeight()
            );
            require(view.isFocusable(), "Control supports keyboard/controller focus");
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); ++i) controls(
            ((ViewGroup) view).getChildAt(i),
            density
        );
    }

    private void textFits(View view) {
        if (view.getVisibility() != View.VISIBLE) return;
        if (view instanceof TextView) {
            TextView text = (TextView) view;
            if (text.getLayout() != null) {
                require(
                    text.getLayout().getHeight() <=
                        text.getHeight() - text.getCompoundPaddingTop() - text.getCompoundPaddingBottom(),
                    "Scaled text fits vertically: " + text.getText()
                );
                for (int i = 0; i < text.getLayout().getLineCount(); ++i) require(
                    text.getLayout().getEllipsisCount(i) == 0,
                    "Scaled text is not truncated"
                );
            }
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); ++i) textFits(
            ((ViewGroup) view).getChildAt(i)
        );
    }

    private void run() {
        Bundle result = new Bundle();
        LauncherActivity activity = null;
        File temporary = null;
        int code = Activity.RESULT_OK;
        try {
            Context context = test.getTargetContext();
            Uri firstDisc = Uri.parse("content://fixture/first.iso"),
                secondDisc = Uri.parse("content://fixture/second.bin");
            require(
                LauncherActivity.selectedIsoUris(new Intent().setData(firstDisc)).equals(Arrays.asList(firstDisc)),
                "Single-disc picker results remain supported"
            );
            ClipData clips = ClipData.newRawUri("Discs", firstDisc);
            clips.addItem(new ClipData.Item(secondDisc));
            clips.addItem(new ClipData.Item(firstDisc));
            Intent multiple = new Intent();
            multiple.setClipData(clips);
            require(
                LauncherActivity.selectedIsoUris(multiple).equals(Arrays.asList(firstDisc, secondDisc)),
                "ClipData-only results retain every disc once and preserve selection order"
            );
            multiple.setData(secondDisc);
            require(
                LauncherActivity.selectedIsoUris(multiple).equals(Arrays.asList(firstDisc, secondDisc)),
                "Picker data and ClipData cannot duplicate a source"
            );
            require(LauncherActivity.selectedIsoUris(new Intent()).isEmpty(), "Empty picker results have no sources");
            temporary = new File(context.getCacheDir(), "launcher-fixture-" + UUID.randomUUID());
            require(temporary.mkdir(), "Private library fixture created");
            File pictures = new File(context.getCacheDir(), "launcher-ui-checks");
            require(pictures.isDirectory() || pictures.mkdir(), "Panel capture folder ready");
            Intent intent = new Intent(context, LauncherActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("show_library", true)
                .putExtra("map_error", "Course could not open. Choose another course or try again.");
            activity = (LauncherActivity) test.startActivitySync(intent);
            idle(activity);
            LauncherActivity launched = activity;
            LauncherUi ui = (LauncherUi) get(activity, "screen");
            main(() -> {
                require(
                    ui.settings.getVisibility() == View.GONE &&
                        ui.help.getVisibility() == View.GONE &&
                        ui.details.getVisibility() == View.GONE,
                    "Optional panels start collapsed"
                );
                require(
                    ui.status.getText().toString().contains("Course could not open"),
                    "Launch failure survives initial refresh and resume"
                );
                require(
                    ui.status.getAccessibilityLiveRegion() == View.ACCESSIBILITY_LIVE_REGION_POLITE,
                    "Status uses polite accessibility announcements"
                );
                require(
                    ui.root.findViewById(R.id.launcher_title).isAccessibilityHeading(),
                    "Page title is an accessibility heading"
                );
                require(
                    ((TextView) ui.root.findViewById(R.id.launcher_version))
                        .getText()
                        .toString()
                        .equals("Version " + BuildConfig.VERSION_NAME),
                    "Visible version matches the installed package"
                );
                require(ui.targetRefreshRate.getCount() == 4, "Four target frame rates are available");
                require(
                    ui.targetRefreshRate.getSelectedItemPosition() ==
                        launched.getPreferences(0).getInt("target_refresh_rate", 3),
                    "Saved refresh target or 120 fps default is selected"
                );
                require(
                    ui.renderScale.getSelectedItemPosition() == launched.getPreferences(0).getInt("render_scale", 2),
                    "Saved render scale or 150 percent default is selected"
                );
            });
            File empty = new File(temporary, "empty");
            library(activity, empty);
            main(() -> {
                require(
                    ui.empty.getVisibility() == View.VISIBLE && ui.courses.getChildCount() == 0,
                    "Empty library explains first use"
                );
                require(
                    ui.emptyBody.getText().toString().contains("custom"),
                    "Existing custom maps do not require an ISO"
                );
                require(ui.importIso.isEnabled() && ui.chooseFolder.isEnabled(), "Both first-use paths are actionable");
                Rect folder = new Rect();
                ui.chooseFolder.getDrawingRect(folder);
                ui.root.offsetDescendantRectToMyCoords(ui.chooseFolder, folder);
                require(folder.bottom <= ui.root.getHeight(), "Both first-use actions fit the initial panel viewport");
                require(ui.runMode.getVisibility() == View.GONE, "Empty state avoids irrelevant ride settings");
                try {
                    snapshot(ui.root, pictures, "empty");
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            });
            File populated = new File(temporary, "populated");
            require(populated.mkdir(), "Populated library fixture created");
            for (String name : new String[] { "ALASKA", "AVALANCHE_CRS01_00", "My custom course" }) {
                File map = new File(populated, name);
                require(map.mkdir(), "Course fixture created");
                try (Writer file = new FileWriter(new File(map, "Patches.json"))) {
                    file.write("{}");
                }
            }
            try (Writer file = new FileWriter(new File(populated, "ALASKA/Import.json"))) {
                file.write("{\"DisplayName\":\"Disc Alaska\"}");
            }
            library(activity, populated);
            main(() -> {
                try {
                    invoke(
                        launched,
                        "failure",
                        new Class<?>[] { Exception.class },
                        new IOException("Folder access was not granted. Choose the folder again.")
                    );
                    invoke(launched, "refreshMaps", new Class<?>[] {});
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            idle(activity);
            main(() ->
                require(
                    ui.status.getText().toString().contains("Folder access was not granted"),
                    "Picker failure survives an automatic resume refresh"
                )
            );
            main(() -> {
                require(ui.game.getCount() == 3 && ui.map.getCount() == 1, "Installed maps are grouped by game");
                require(
                    ((Button) ui.courses.getChildAt(0)).getText().toString().equals("Play Tenderfoot Pass"),
                    "Game selection displays recovered Avalanche names"
                );
                select(ui.game, "SSX Tricky");
            });
            laidOut(activity);
            test.waitForIdleSync();
            main(() -> {
                require(
                    ui.courses.getChildCount() == 2 && ui.empty.getVisibility() == View.GONE,
                    "Discovered courses replace empty guidance"
                );
                require(
                    ((Button) ui.courses.getChildAt(0)).getText().toString().equals("Play Disc Alaska"),
                    "Play action reads Import.json titles"
                );
                require(ui.courses.getChildAt(0).getTag().equals("ALASKA"), "Metadata labels retain the map ID");
                require(
                    ui.courses.getChildAt(1).getContentDescription().toString().equals("Unload Disc Alaska"),
                    "Unload action reads Import.json titles"
                );
                require(
                    LauncherActivity.nativeCourseDisplayName("My custom course").equals("My custom course"),
                    "Custom map names remain unchanged through JNI"
                );
                String unicodeName = "My custom course \uD83C\uDFC2";
                require(
                    LauncherActivity.nativeCourseDisplayName(unicodeName).equals(unicodeName),
                    "Custom Unicode course names retain their original UTF-16"
                );
                Rect first = new Rect();
                ui.courses.getChildAt(0).getDrawingRect(first);
                ui.root.offsetDescendantRectToMyCoords(ui.courses.getChildAt(0), first);
                require(
                    first.top >= 0 && first.bottom <= ui.root.getHeight(),
                    "First Play action fits the initial viewport without scrolling"
                );
                require(ui.add.getVisibility() == View.GONE, "Existing libraries keep import details folded away");
                ui.addToggle.performClick();
                require(ui.add.getVisibility() == View.VISIBLE, "Add courses remains one action away");
                ui.addToggle.performClick();
                controls(ui.root, context.getResources().getDisplayMetrics().density);
                ui.settingsToggle.performClick();
                require(ui.settings.getVisibility() == View.VISIBLE, "Ride settings expand");
                require(
                    ui.settingsToggle.getContentDescription().toString().contains("expanded"),
                    "Expansion has a spoken state"
                );
                launched.onBackPressed();
                require(ui.settings.getVisibility() == View.GONE, "Back closes settings before exiting");
                ui.helpToggle.performClick();
                require(ui.help.getVisibility() == View.VISIBLE, "Controls help expands");
                launched.onBackPressed();
                require(ui.help.getVisibility() == View.GONE, "Back closes help before exiting");
                try {
                    invoke(launched, "state", new Class<?>[] { boolean.class }, true);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
                require(
                    !ui.courses.getChildAt(0).isEnabled() && !ui.importIso.isEnabled(),
                    "Busy state blocks duplicate launch/import"
                );
                require(
                    !ui.courses.getChildAt(0).isEnabled() && !ui.courses.getChildAt(1).isEnabled(),
                    "Busy state blocks play and unload together"
                );
                require(ui.cancel.isEnabled() && ui.close.isEnabled(), "Long operations retain cancel and exit");
                ui.cancel.performClick();
                try {
                    require((boolean) get(launched, "cancelled"), "Cancel reaches the import cancellation flag");
                    invoke(launched, "state", new Class<?>[] { boolean.class }, false);
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            test.waitForIdleSync();
            AlertDialog[] choice = { null };
            main(() -> {
                ui.status("", false);
                ui.root.scrollTo(0, 0);
                try {
                    snapshot(ui.root, pictures, "courses");
                    List<LauncherActivity.IsoCourse> choices = Arrays.asList(
                        new LauncherActivity.IsoCourse(firstDisc, "AVALANCHE_CRS06_03", "avalanche.rvz", "Disc Forest"),
                        new LauncherActivity.IsoCourse(secondDisc, "SSX_SNOW", "second.bin")
                    );
                    AlertDialog dialog = (AlertDialog) invoke(
                        launched,
                        "showImportChoices",
                        new Class<?>[] { List.class, String.class },
                        choices,
                        "broken.iso: Could not read this disc."
                    );
                    choice[0] = dialog;
                    require(
                        dialog.getListView().getCount() == 1 &&
                            dialog
                                .getListView()
                                .getAdapter()
                                .getItem(0)
                                .toString()
                                .equals("Disc Forest · avalanche.rvz"),
                        "Combined discs filter to the selected game and retain disc metadata"
                    );
                    require(
                        choices.get(0).name.equals("AVALANCHE_CRS06_03"),
                        "Friendly import choices preserve the extraction ID"
                    );
                    require(
                        choices.get(0).uri.equals(firstDisc) && choices.get(1).uri.equals(secondDisc),
                        "Course selections retain their own source URI"
                    );
                    require(
                        !dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled(),
                        "Import requires an explicit course selection"
                    );
                    dialog.findViewById(R.id.launcher_select_all).performClick();
                    require(
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString().contains("1"),
                        "Select all updates import count"
                    );
                    dialog.findViewById(R.id.launcher_select_all).performClick();
                    require(
                        !dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled(),
                        "Clear selection prevents an empty import"
                    );
                    select(dialog.findViewById(R.id.launcher_import_game), "SSX");
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            test.waitForIdleSync();
            main(() -> {
                require(
                    choice[0].getListView().getCount() == 1 &&
                        choice[0].getListView().getAdapter().getItem(0).toString().equals("SSX_SNOW · second.bin"),
                    "Import game selector exposes only that game's courses"
                );
                require(
                    !choice[0].getButton(AlertDialog.BUTTON_POSITIVE).isEnabled(),
                    "Changing import game never imports implicitly"
                );
                choice[0].getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
            });
            test.waitForIdleSync();
            main(() -> require(!choice[0].isShowing(), "Import has an explicit Back action"));
            main(() -> {
                try {
                    ArrayList<LauncherActivity.IsoCourse> runs = new ArrayList<>();
                    for (int i = 0; i < 17; ++i) runs.add(
                        new LauncherActivity.IsoCourse(firstDisc, "SSX3_RUN_" + i, "ssx3.iso", "Disc run " + i, "run")
                    );
                    runs.add(new LauncherActivity.IsoCourse(firstDisc, "SSX3_A", "ssx3.iso", "Station", "hub"));
                    runs.add(
                        new LauncherActivity.IsoCourse(firstDisc, "SSX3_A_ARA1", "ssx3.iso", "Connector", "connector")
                    );
                    runs.add(new LauncherActivity.IsoCourse(firstDisc, "SSX3_PEAK1", "ssx3.iso", "Peak", "run-chain"));
                    runs.add(
                        new LauncherActivity.IsoCourse(firstDisc, "SSX3_ALL", "ssx3.iso", "Mountain", "full-mountain")
                    );
                    AlertDialog dialog = (AlertDialog) invoke(
                        launched,
                        "showImportChoices",
                        new Class<?>[] { List.class, String.class },
                        runs,
                        ""
                    );
                    CheckBox advanced = dialog.findViewById(R.id.launcher_all_map_types);
                    Button select = dialog.findViewById(R.id.launcher_select_all);
                    require(
                        dialog.getListView().getCount() == 17 && !advanced.isChecked(),
                        "Quest defaults to 17 named runs from source metadata"
                    );
                    require(
                        dialog.getListView().getAdapter().getItem(0).toString().equals("Disc run 0 · ssx3.iso"),
                        "Run names retain their source label"
                    );
                    select.performClick();
                    require(
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString().contains("17"),
                        "Select all selects the visible named runs"
                    );
                    advanced.setChecked(true);
                    require(
                        dialog.getListView().getCount() == 21 &&
                            dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString().contains("17"),
                        "Advanced rows preserve selections by ID"
                    );
                    select.performClick();
                    advanced.setChecked(false);
                    require(
                        dialog.getListView().getCount() == 17 &&
                            dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString().contains("17"),
                        "Hidden structural maps are excluded from the import count"
                    );
                    select.performClick();
                    advanced.setChecked(true);
                    require(
                        dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString().contains("4"),
                        "Clearing visible runs preserves independent advanced selections"
                    );
                    require(
                        runs.get(0).name.equals("SSX3_RUN_0") && runs.get(0).uri.equals(firstDisc),
                        "Filtering never changes the extraction ID or URI"
                    );
                    dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
            File unreadable = new File(temporary, "not-a-folder");
            require(unreadable.createNewFile(), "Unavailable library fixture created");
            library(activity, unreadable);
            main(() -> {
                require(
                    ui.courses.getChildCount() == 0 && ui.empty.getVisibility() == View.VISIBLE,
                    "Read failure never leaves stale Play buttons"
                );
                require(
                    !ui.importIso.isEnabled() && ui.chooseFolder.isEnabled(),
                    "Read failure offers folder recovery before import"
                );
                require(
                    ui.details.getVisibility() == View.VISIBLE && ui.refresh.isEnabled(),
                    "Recovery and refresh controls are exposed"
                );
                require(!ui.status.getText().toString().isEmpty(), "Read failure is described in text");
                try {
                    snapshot(ui.root, pictures, "folder-error");
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
                Configuration config = new Configuration(context.getResources().getConfiguration());
                config.fontScale = 1.5f;
                config.screenWidthDp = 360;
                Context scaled = new ContextThemeWrapper(
                    context.createConfigurationContext(config),
                    R.style.Theme_OpenSlope_Launcher
                );
                LauncherUi large = new LauncherUi(scaled);
                large.maps(
                    Arrays.asList(
                        new MapLibrary.Entry("A long custom course name with several words", Uri.EMPTY, true)
                    ),
                    map -> {}
                );
                large.settingsToggle.performClick();
                large.helpToggle.performClick();
                large.detailsToggle.performClick();
                large.root.measure(
                    View.MeasureSpec.makeMeasureSpec(large.dp(360), View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(large.dp(640), View.MeasureSpec.EXACTLY)
                );
                large.root.layout(0, 0, large.root.getMeasuredWidth(), large.root.getMeasuredHeight());
                controls(large.root, scaled.getResources().getDisplayMetrics().density);
                textFits(large.root);
                try {
                    snapshot(large.root, pictures, "large-text-narrow");
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            });
            gameGroups(activity, ui);
            result.putString(
                "stream",
                "PASS: " +
                    checks +
                    " launcher flow, target, font-scaling and accessibility checks; captures in cache/launcher-ui-checks\n"
            );
        } catch (Throwable error) {
            result.putString("stream", "FAIL: " + error + "\n");
            code = Activity.RESULT_CANCELED;
        } finally {
            if (temporary != null) MapLibrary.deleteLocal(temporary);
            if (activity != null) {
                LauncherActivity launched = activity;
                test.runOnMainSync(launched::finish);
            }
            test.finish(code, result);
        }
    }

    static void run(Instrumentation test) {
        new LauncherUiChecks(test).run();
    }
}
