package org.openslope.nativeplayer;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import java.util.*;

/** Standard Android views retain system input, font scaling and accessibility semantics. */
final class LauncherUi {
    final Context context;
    final ScrollView root;
    final LinearLayout content, courses, empty, settings, help, details, add;
    final TextView status, location, source, count, emptyTitle, emptyBody, modeHint;
    final Button importIso, chooseFolder, useLocal, refresh, cancel, settingsToggle, helpToggle, detailsToggle, addToggle, close;
    final Spinner runMode, renderScale, targetRefreshRate, antialiasing, steeringMode;
    final ProgressBar progress;
    private final List<View> controls = new ArrayList<>();
    private final Map<View, View> labels = new HashMap<>();
    private Boolean wasEmpty;

    LauncherUi(Context context) {
        this.context = context;
        root = new ScrollView(context); root.setId(R.id.launcher_root); root.setFillViewport(true);
        root.setBackgroundColor(color(R.color.launcher_background));
        content = column(); int padding = dp(context.getResources().getConfiguration().screenWidthDp < 600 ? 16 : 32);
        content.setPadding(padding, dp(24), padding, dp(24)); root.addView(content);
        TextView title = text(content, R.string.launcher_title, 30, false); title.setId(R.id.launcher_title); heading(title);
        text(content, R.string.launcher_subtitle, 18, true);

        LinearLayout library = card(content);
        heading(text(library, R.string.your_courses, 22, false));
        count = text(library, "", 18, true);
        runMode = choice(library, R.id.launcher_mode, R.string.ride_mode, R.array.ride_modes);
        modeHint = text(library, R.string.mode_freeride_hint, 18, true);
        courses = column(); courses.setId(R.id.launcher_courses); library.addView(courses);
        empty = column(); library.addView(empty);
        emptyTitle = text(empty, R.string.empty_title, 22, false); heading(emptyTitle);
        emptyBody = text(empty, R.string.empty_body, 18, true);

        addToggle = button(content, View.generateViewId(), R.string.add_courses, false);
        add = card(content);
        heading(text(add, R.string.add_courses, 22, false));
        text(add, R.string.add_courses_hint, 18, true);
        importIso = button(add, R.id.launcher_import, R.string.import_iso, true);
        chooseFolder = button(add, R.id.launcher_folder, R.string.choose_maps, false);
        source = text(add, R.string.app_maps_source, 18, true);
        detailsToggle = button(add, R.id.launcher_details, R.string.folder_details, false);
        details = column(); details.setVisibility(View.GONE); add.addView(details);
        location = text(details, "", 18, true);
        useLocal = button(details, R.id.launcher_local, R.string.use_app_maps, false);
        refresh = button(details, R.id.launcher_refresh, R.string.refresh_courses, false);
        toggle(detailsToggle, details, R.string.folder_details, R.string.hide_folder_details);
        toggle(addToggle, add, R.string.add_courses, R.string.hide_add_courses);

        LinearLayout operation = column(); content.addView(operation);
        progress = new ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true); progress.setVisibility(View.GONE);
        progress.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        operation.addView(progress, new LinearLayout.LayoutParams(-1, dp(8)));
        status = text(operation, "", 18, true); status.setId(R.id.launcher_status); status.setVisibility(View.GONE);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        cancel = button(operation, R.id.launcher_cancel, R.string.cancel_operation, false); cancel.setVisibility(View.GONE);
        content.removeView(operation); content.addView(operation, 2);

        settingsToggle = button(content, R.id.launcher_settings, R.string.ride_settings, false);
        settings = card(content); settings.setVisibility(View.GONE);
        settings.setAccessibilityPaneTitle(context.getString(R.string.ride_settings));
        renderScale = choice(settings, R.id.launcher_scale, R.string.vr_resolution, R.array.vr_resolutions);
        targetRefreshRate = choice(settings, R.id.launcher_refresh_rate, R.string.target_refresh_rate, R.array.refresh_rates);
        text(settings, R.string.resolution_hint, 18, true);
        antialiasing = choice(settings, R.id.launcher_antialiasing, R.string.edge_smoothing, R.array.smoothing_options);
        steeringMode = choice(settings, R.id.launcher_steering, R.string.riding_steering, R.array.steering_options);
        text(settings, R.string.steering_hint, 18, true);
        toggle(settingsToggle, settings, R.string.ride_settings, R.string.hide_ride_settings);
        helpToggle = button(content, R.id.launcher_help, R.string.first_run_help, false);
        help = card(content); help.setVisibility(View.GONE);
        help.setAccessibilityPaneTitle(context.getString(R.string.first_run_help));
        heading(text(help, R.string.enter_vr_title, 22, false));
        text(help, R.string.enter_vr_help, 18, true);
        heading(text(help, R.string.controls_title, 22, false));
        text(help, R.string.controls_help, 18, true);
        toggle(helpToggle, help, R.string.first_run_help, R.string.hide_first_run_help);
        close = button(content, R.id.launcher_close, R.string.close_app, false);
        controls.remove(close);
    }

    int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
    private int color(int resource) { return context.getColor(resource); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(context); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout card(LinearLayout parent) {
        LinearLayout view = column(); view.setPadding(dp(20), dp(16), dp(20), dp(16)); view.setBackgroundResource(R.drawable.launcher_card);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(16); params.bottomMargin = dp(8);
        parent.addView(view, params); return view;
    }
    private TextView text(LinearLayout parent, int resource, int size, boolean secondary) { return text(parent, context.getString(resource), size, secondary); }
    private TextView text(LinearLayout parent, String value, int size, boolean secondary) {
        TextView view = new TextView(context); view.setText(value); view.setTextSize(size);
        view.setTextColor(color(secondary ? R.color.launcher_secondary : R.color.launcher_text));
        view.setPadding(0, dp(4), 0, dp(8)); view.setLineSpacing(dp(3), 1); parent.addView(view); return view;
    }
    private void heading(TextView view) { view.setAccessibilityHeading(true); view.setTypeface(null, Typeface.BOLD); }
    Button button(LinearLayout parent, int id, int label, boolean primary) { return button(parent, id, context.getString(label), primary); }
    Button dialogButton(LinearLayout parent, int id, int label) { Button view = button(parent, id, label, false); controls.remove(view); return view; }
    private Button button(LinearLayout parent, int id, String label, boolean primary) {
        Button view = new Button(context); view.setId(id); view.setText(label); view.setTextSize(18); view.setAllCaps(false);
        view.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); view.setPadding(dp(20), dp(14), dp(20), dp(14));
        view.setMinHeight(dp(60)); view.setMinimumHeight(dp(60)); view.setMinWidth(dp(60));
        view.setBackgroundTintList(null); primary(view, primary);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(6); params.bottomMargin = dp(6);
        parent.addView(view, params); controls.add(view); return view;
    }
    private void primary(Button view, boolean primary) {
        view.setBackgroundResource(primary ? R.drawable.launcher_primary : R.drawable.launcher_action);
        view.setTextColor(new ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled}, new int[0]},
            new int[]{color(R.color.launcher_disabled_text), color(primary ? R.color.launcher_ink : R.color.launcher_text)}));
    }
    private Spinner choice(LinearLayout parent, int id, int label, int entries) {
        TextView name = text(parent, label, 18, false);
        Spinner view = new Spinner(context, Spinner.MODE_DIALOG); view.setId(id); name.setLabelFor(id);
        view.setPrompt(context.getString(label)); view.setMinimumHeight(dp(60)); view.setBackgroundResource(R.drawable.launcher_action);
        ArrayAdapter<CharSequence> adapter = ArrayAdapter.createFromResource(context, entries, R.layout.launcher_choice);
        adapter.setDropDownViewResource(R.layout.launcher_choice_item); view.setAdapter(adapter);
        parent.addView(view, new LinearLayout.LayoutParams(-1, -2)); controls.add(view); labels.put(view, name); return view;
    }
    private void toggle(Button button, View panel, int show, int hide) {
        expanded(button, panel, show, hide, false);
        button.setOnClickListener(v -> expanded(button, panel, show, hide, panel.getVisibility() != View.VISIBLE));
    }
    private void expanded(Button button, View panel, int show, int hide, boolean open) {
        panel.setVisibility(open ? View.VISIBLE : View.GONE); button.setText(open ? hide : show);
        button.setContentDescription(context.getString(open ? R.string.section_expanded : R.string.section_collapsed, context.getString(show)));
    }
    void busy(boolean working, boolean cancellable) {
        for (View view : controls) view.setEnabled(!working);
        for (int i = 0; i < courses.getChildCount(); ++i) courses.getChildAt(i).setEnabled(!working);
        progress.setVisibility(working ? View.VISIBLE : View.GONE);
        cancel.setVisibility(working && cancellable ? View.VISIBLE : View.GONE); cancel.setEnabled(working && cancellable);
        if (working && cancellable) root.smoothScrollTo(0, 0);
    }
    void status(String message, boolean error) {
        status.setTextColor(color(error ? R.color.launcher_warning : R.color.launcher_secondary));
        status.setText(message); status.setVisibility(message.isEmpty() ? View.GONE : View.VISIBLE);
    }
    void maps(List<MapLibrary.Entry> maps, java.util.function.Consumer<MapLibrary.Entry> play) {
        courses.removeAllViews();
        for (MapLibrary.Entry map : maps) {
            Button view = button(courses, View.generateViewId(), context.getString(R.string.play_course, map.name), true);
            controls.remove(view); view.setTag(map.name); view.setOnClickListener(v -> play.accept(map));
        }
        boolean none = maps.isEmpty(); empty.setVisibility(none ? View.VISIBLE : View.GONE);
        if (wasEmpty == null || wasEmpty != none) expanded(addToggle, add, R.string.add_courses, R.string.hide_add_courses, none);
        wasEmpty = none; addToggle.setVisibility(none ? View.GONE : View.VISIBLE);
        runMode.setVisibility(none ? View.GONE : View.VISIBLE);
        labels.get(runMode).setVisibility(none ? View.GONE : View.VISIBLE);
        modeHint.setVisibility(none ? View.GONE : View.VISIBLE);
        emptyTitle.setText(R.string.empty_title); emptyBody.setText(R.string.empty_body);
        count.setText(context.getResources().getQuantityString(R.plurals.available_courses, maps.size(), maps.size()));
        count.setVisibility(none ? View.GONE : View.VISIBLE);
        primary(importIso, none);
    }
    void libraryError() {
        maps(Collections.emptyList(), map -> {}); count.setText(R.string.library_unavailable);
        count.setVisibility(View.VISIBLE);
        emptyTitle.setText(R.string.folder_error_title); emptyBody.setText(R.string.folder_error_body);
        importIso.setEnabled(false); expanded(detailsToggle, details, R.string.folder_details, R.string.hide_folder_details, true);
    }
    boolean collapse() {
        if (help.getVisibility() == View.VISIBLE) { helpToggle.performClick(); return true; }
        if (settings.getVisibility() == View.VISIBLE) { settingsToggle.performClick(); return true; }
        if (details.getVisibility() == View.VISIBLE) { detailsToggle.performClick(); return true; }
        if (addToggle.getVisibility() == View.VISIBLE && add.getVisibility() == View.VISIBLE) { addToggle.performClick(); return true; }
        return false;
    }
}
