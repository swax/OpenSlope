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
    private LauncherUiChecks(Instrumentation test) { this.test = test; }
    private void require(boolean value, String message) { ++checks; if (!value) throw new AssertionError(message); }
    private void main(Runnable action) {
        Throwable[] error = {null};
        test.runOnMainSync(() -> { try { action.run(); } catch (Throwable failure) { error[0] = failure; } });
        if (error[0] != null) throw new AssertionError(error[0]);
    }
    private Object get(Object target, String name) throws Exception { Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target); }
    private Object invoke(LauncherActivity activity, String name, Class<?>[] types, Object... values) throws Exception {
        Method method = LauncherActivity.class.getDeclaredMethod(name, types); method.setAccessible(true); return method.invoke(activity, values);
    }
    private void idle(LauncherActivity activity) throws Exception {
        for (int i = 0; i < 150; ++i) { test.waitForIdleSync(); if (!(boolean) get(activity, "busy")) { laidOut(activity); return; } Thread.sleep(100); }
        throw new AssertionError("Library worker did not finish");
    }
    private void laidOut(LauncherActivity activity) {
        main(() -> {
            View root = activity.findViewById(R.id.launcher_root);
            // Horizon can suspend panel frames when unworn; exercise the real Android layout directly.
            require(root.getWidth() > 0 && root.getHeight() > 0, "System supplied panel bounds");
            root.forceLayout();
            root.measure(View.MeasureSpec.makeMeasureSpec(root.getWidth(), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(root.getHeight(), View.MeasureSpec.EXACTLY));
            root.layout(root.getLeft(), root.getTop(), root.getRight(), root.getBottom());
        });
    }
    private void library(LauncherActivity activity, File root) throws Exception {
        Field field = LauncherActivity.class.getDeclaredField("library"); field.setAccessible(true);
        main(() -> { try { field.set(activity, new MapLibrary(activity.getContentResolver(), root, null)); invoke(activity, "refreshMaps", new Class<?>[]{String.class}, (Object) null); } catch (Exception e) { throw new RuntimeException(e); } });
        idle(activity);
    }
    private void snapshot(View root, File folder, String name) throws IOException {
        root.measure(View.MeasureSpec.makeMeasureSpec(root.getWidth(), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(root.getHeight(), View.MeasureSpec.EXACTLY));
        root.layout(root.getLeft(), root.getTop(), root.getRight(), root.getBottom());
        Bitmap image = Bitmap.createBitmap(root.getWidth(), root.getHeight(), Bitmap.Config.ARGB_8888);
        root.draw(new Canvas(image));
        try (OutputStream file = new FileOutputStream(new File(folder, name + ".png"))) { image.compress(Bitmap.CompressFormat.PNG, 100, file); }
        finally { image.recycle(); }
    }
    private void controls(View view, float density) {
        if (view.getVisibility() != View.VISIBLE) return;
        if (view instanceof Button || view instanceof Spinner) {
            require(view.getMeasuredHeight() >= Math.round(60 * density), "Control has a 60dp target: " + view.getClass().getSimpleName());
            require(view.isFocusable(), "Control supports keyboard/controller focus");
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); ++i) controls(((ViewGroup) view).getChildAt(i), density);
    }
    private void textFits(View view) {
        if (view.getVisibility() != View.VISIBLE) return;
        if (view instanceof TextView) {
            TextView text = (TextView) view;
            if (text.getLayout() != null) {
                require(text.getLayout().getHeight() <= text.getHeight() - text.getCompoundPaddingTop() - text.getCompoundPaddingBottom(), "Scaled text fits vertically: " + text.getText());
                for (int i = 0; i < text.getLayout().getLineCount(); ++i) require(text.getLayout().getEllipsisCount(i) == 0, "Scaled text is not truncated");
            }
        }
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); ++i) textFits(((ViewGroup) view).getChildAt(i));
    }
    private void run() {
        Bundle result = new Bundle(); LauncherActivity activity = null; File temporary = null; int code = Activity.RESULT_OK;
        try {
            Context context = test.getTargetContext();
            temporary = new File(context.getCacheDir(), "launcher-fixture-" + UUID.randomUUID()); require(temporary.mkdir(), "Private library fixture created");
            File pictures = new File(context.getCacheDir(), "launcher-ui-checks"); require(pictures.isDirectory() || pictures.mkdir(), "Panel capture folder ready");
            Intent intent = new Intent(context, LauncherActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("show_library", true).putExtra("map_error", "Course could not open. Choose another course or try again.");
            activity = (LauncherActivity) test.startActivitySync(intent); idle(activity);
            LauncherActivity launched = activity; LauncherUi ui = (LauncherUi) get(activity, "screen");
            main(() -> {
                require(ui.settings.getVisibility() == View.GONE && ui.help.getVisibility() == View.GONE && ui.details.getVisibility() == View.GONE, "Optional panels start collapsed");
                require(ui.status.getText().toString().contains("Course could not open"), "Launch failure survives initial refresh and resume");
                require(ui.status.getAccessibilityLiveRegion() == View.ACCESSIBILITY_LIVE_REGION_POLITE, "Status uses polite accessibility announcements");
                require(ui.root.findViewById(R.id.launcher_title).isAccessibilityHeading(), "Page title is an accessibility heading");
                require(((TextView) ui.root.findViewById(R.id.launcher_version)).getText().toString().equals("Version " + BuildConfig.VERSION_NAME), "Visible version matches the installed package");
                require(ui.targetRefreshRate.getCount() == 4, "Four target frame rates are available");
                require(ui.targetRefreshRate.getSelectedItemPosition() == launched.getPreferences(0).getInt("target_refresh_rate", 3), "Saved refresh target or 120 fps default is selected");
                require(ui.renderScale.getSelectedItemPosition() == launched.getPreferences(0).getInt("render_scale", 2), "Saved render scale or 150 percent default is selected");
            });
            File empty = new File(temporary, "empty"); library(activity, empty);
            main(() -> {
                require(ui.empty.getVisibility() == View.VISIBLE && ui.courses.getChildCount() == 0, "Empty library explains first use");
                require(ui.emptyBody.getText().toString().contains("custom"), "Existing custom maps do not require an ISO");
                require(ui.importIso.isEnabled() && ui.chooseFolder.isEnabled(), "Both first-use paths are actionable");
                Rect folder = new Rect(); ui.chooseFolder.getDrawingRect(folder); ui.root.offsetDescendantRectToMyCoords(ui.chooseFolder, folder);
                require(folder.bottom <= ui.root.getHeight(), "Both first-use actions fit the initial panel viewport");
                require(ui.runMode.getVisibility() == View.GONE, "Empty state avoids irrelevant ride settings");
                try { snapshot(ui.root, pictures, "empty"); } catch (IOException e) { throw new RuntimeException(e); }
            });
            File populated = new File(temporary, "populated"); require(populated.mkdir(), "Populated library fixture created");
            for (String name : new String[]{"ALASKA", "My custom course"}) { File map = new File(populated, name); require(map.mkdir(), "Course fixture created"); try (Writer file = new FileWriter(new File(map, "Patches.json"))) { file.write("{}"); } }
            library(activity, populated);
            main(() -> { try { invoke(launched, "failure", new Class<?>[]{Exception.class}, new IOException("Folder access was not granted. Choose the folder again.")); invoke(launched, "refreshMaps", new Class<?>[]{}); } catch (Exception e) { throw new RuntimeException(e); } });
            idle(activity);
            main(() -> require(ui.status.getText().toString().contains("Folder access was not granted"), "Picker failure survives an automatic resume refresh"));
            main(() -> {
                require(ui.courses.getChildCount() == 2 && ui.empty.getVisibility() == View.GONE, "Discovered courses replace empty guidance");
                require(((Button) ui.courses.getChildAt(0)).getText().toString().equals("Play ALASKA"), "Play action names its course");
                Rect first = new Rect(); ui.courses.getChildAt(0).getDrawingRect(first); ui.root.offsetDescendantRectToMyCoords(ui.courses.getChildAt(0), first);
                require(first.top >= 0 && first.bottom <= ui.root.getHeight(), "First Play action fits the initial viewport without scrolling");
                require(ui.add.getVisibility() == View.GONE, "Existing libraries keep import details folded away");
                ui.addToggle.performClick(); require(ui.add.getVisibility() == View.VISIBLE, "Add courses remains one action away");
                ui.addToggle.performClick();
                controls(ui.root, context.getResources().getDisplayMetrics().density);
                ui.settingsToggle.performClick(); require(ui.settings.getVisibility() == View.VISIBLE, "Ride settings expand");
                require(ui.settingsToggle.getContentDescription().toString().contains("expanded"), "Expansion has a spoken state");
                launched.onBackPressed(); require(ui.settings.getVisibility() == View.GONE, "Back closes settings before exiting");
                ui.helpToggle.performClick(); require(ui.help.getVisibility() == View.VISIBLE, "Controls help expands");
                launched.onBackPressed(); require(ui.help.getVisibility() == View.GONE, "Back closes help before exiting");
                try { invoke(launched, "state", new Class<?>[]{boolean.class}, true); } catch (Exception e) { throw new RuntimeException(e); }
                require(!ui.courses.getChildAt(0).isEnabled() && !ui.importIso.isEnabled(), "Busy state blocks duplicate launch/import");
                require(ui.cancel.isEnabled() && ui.close.isEnabled(), "Long operations retain cancel and exit");
                ui.cancel.performClick();
                try { require((boolean) get(launched, "cancelled"), "Cancel reaches the import cancellation flag"); invoke(launched, "state", new Class<?>[]{boolean.class}, false); }
                catch (Exception e) { throw new RuntimeException(e); }
            });
            test.waitForIdleSync();
            AlertDialog[] choice = {null};
            main(() -> {
                ui.status("", false); ui.root.scrollTo(0, 0);
                try { snapshot(ui.root, pictures, "courses");
                    AlertDialog dialog = (AlertDialog) invoke(launched, "showImportChoices", new Class<?>[]{Uri.class, List.class}, Uri.EMPTY, Arrays.asList("ALASKA", "GARI"));
                    choice[0] = dialog;
                    require(!dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled(), "Import requires an explicit course selection");
                    dialog.findViewById(R.id.launcher_select_all).performClick(); require(dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString().contains("2"), "Select all updates import count");
                    dialog.findViewById(R.id.launcher_select_all).performClick(); require(!dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled(), "Clear selection prevents an empty import");
                    dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
                } catch (Exception e) { throw new RuntimeException(e); }
            });
            test.waitForIdleSync(); main(() -> require(!choice[0].isShowing(), "Import has an explicit Back action"));
            File unreadable = new File(temporary, "not-a-folder"); require(unreadable.createNewFile(), "Unavailable library fixture created"); library(activity, unreadable);
            main(() -> {
                require(ui.courses.getChildCount() == 0 && ui.empty.getVisibility() == View.VISIBLE, "Read failure never leaves stale Play buttons");
                require(!ui.importIso.isEnabled() && ui.chooseFolder.isEnabled(), "Read failure offers folder recovery before import");
                require(ui.details.getVisibility() == View.VISIBLE && ui.refresh.isEnabled(), "Recovery and refresh controls are exposed");
                require(!ui.status.getText().toString().isEmpty(), "Read failure is described in text");
                try { snapshot(ui.root, pictures, "folder-error"); } catch (IOException e) { throw new RuntimeException(e); }
                Configuration config = new Configuration(context.getResources().getConfiguration()); config.fontScale = 1.5f; config.screenWidthDp = 360;
                Context scaled = new ContextThemeWrapper(context.createConfigurationContext(config), R.style.Theme_OpenSlope_Launcher);
                LauncherUi large = new LauncherUi(scaled); large.maps(Arrays.asList(new MapLibrary.Entry("A long custom course name with several words", Uri.EMPTY, true)), map -> {});
                large.settingsToggle.performClick(); large.helpToggle.performClick(); large.detailsToggle.performClick();
                large.root.measure(View.MeasureSpec.makeMeasureSpec(large.dp(360), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(large.dp(640), View.MeasureSpec.EXACTLY));
                large.root.layout(0, 0, large.root.getMeasuredWidth(), large.root.getMeasuredHeight());
                controls(large.root, scaled.getResources().getDisplayMetrics().density); textFits(large.root);
                try { snapshot(large.root, pictures, "large-text-narrow"); } catch (IOException e) { throw new RuntimeException(e); }
            });
            result.putString("stream", "PASS: " + checks + " launcher flow, target, font-scaling and accessibility checks; captures in cache/launcher-ui-checks\n");
        } catch (Throwable error) { result.putString("stream", "FAIL: " + error + "\n"); code = Activity.RESULT_CANCELED; }
        finally { if (temporary != null) MapLibrary.deleteLocal(temporary); if (activity != null) { LauncherActivity launched = activity; test.runOnMainSync(launched::finish); } test.finish(code, result); }
    }
    static void run(Instrumentation test) { new LauncherUiChecks(test).run(); }
}
