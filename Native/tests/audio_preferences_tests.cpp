#include "openslope/audio_preferences.hpp"
#include "openslope/audio_scene.hpp"
#include "openslope/ride_ui.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool value, const char* text) {
    ++checks;
    if (!value)
        throw std::runtime_error(text);
}

void write(const std::filesystem::path& path, const Json& json) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream(path) << json;
}

void persistence(const std::filesystem::path& root) {
    const auto file = root / "User/audio.json";
    auto settings = AudioPreferences::load(file);
    check(settings.music_enabled && settings.volume == 1 && settings.song("MESA").empty(),
          "missing settings default to audible music and Random");
    settings.music_enabled = false;
    settings.volume = .4;
    settings.song("Mesa", "alpha");
    settings.song("ALASKA", "beta");
    settings.toggle_mute();
    check(settings.save(file), "write initial preferences");
    settings = AudioPreferences::load(file);
    check(!settings.music_enabled && settings.volume == 0 && settings.audible_volume == .4,
          "mute and previous audible trim survive process reload");
    settings.toggle_mute();
    check(settings.volume == .4 && settings.song("mesa") == "alpha" && settings.song("ALASKA") == "beta",
          "unmute restores trim while course selections stay separate");
    settings.song("MESA", "");
    check(settings.save(file), "replace preferences atomically");
    check(AudioPreferences::load(file).song("mesa").empty() && AudioPreferences::load(file).song("ALASKA") == "beta",
          "Random removes only that course's explicit selection");
    settings.song("../unsafe", "bad");
    settings.song("MESA", "../bad");
    check(settings.song("../unsafe").empty() && settings.song("MESA").empty(),
          "path-like preference names are ignored");
    write(file, {{"schema", "openslope-audio-preferences/v1"},
                 {"volume", "bad"},
                 {"musicEnabled", "false"},
                 {"songs", {{"MESA", 42}, {"ALASKA", "beta"}}}});
    settings = AudioPreferences::load(file);
    check(settings.music_enabled && settings.volume == 1 && settings.song("ALASKA") == "beta",
          "malformed fields retain safe defaults without losing valid selections");
    std::ofstream(file) << "invalid JSON";
    check(AudioPreferences::load(file).volume == 1, "invalid JSON cannot prevent play");
    std::ofstream(file) << std::string(256 * 1024 + 1, 'x');
    check(AudioPreferences::load(file).music_enabled, "oversized preferences cannot prevent play");
    const auto blocked = root / "Blocked";
    std::filesystem::create_directory(blocked);
    check(!settings.save(blocked), "a failed atomic replacement is reported");
    for (const auto& item : std::filesystem::directory_iterator(root))
        check(item.path().filename().string().find(".tmp-") == std::string::npos,
              "failed writes remove only their temporary file");
}

void menus(const std::filesystem::path& root) {
    write(root / "Audio/Music/playlist.json", {"alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"});
    AudioScene audio(root);
    AudioPreferences settings;
    RideUi ui;
    ui.visible = ui.immersive = ui.map_picker = true;
    ui.frame({{0, 0, 0}, {1, 0, 0}, {0, -1, 0}, true});
    settings.present(ui, &audio, "MESA");
    const auto click = [&](UiAction action, const std::string& value = "") {
        const auto list = ui.buttons();
        const auto b = std::find_if(list.begin(), list.end(),
                                    [&](const auto& row) { return row.action == action && row.value == value; });
        check(b != list.end(), "requested audio action is exposed in the current menu");
        const EquipmentRay ray{{b->x + b->w / 2, -b->y - b->h / 2, 1}, {0, 0, -1}, true};
        ui.release();
        const auto picked = ui.pointer(ray, true);
        check(picked.action == action && picked.value == value && picked.consumed,
              "ray selection retains exact action/song and consumes trigger");
        const auto changed = settings.handle(picked, ui, &audio, "MESA");
        check(ui.pointer(ray, true).action == UiAction::None,
              "holding a trigger cannot repeat a setting on the next page");
        return changed;
    };
    check(!click(UiAction::Sound) && ui.audio_options, "audio page opens without modifying preferences");
    click(UiAction::VolumeDown);
    check(settings.volume == .9, "volume changes in ten-percent steps");
    click(UiAction::Music);
    check(!settings.music_enabled && !audio.music_status().enabled && settings.volume == .9,
          "music and master controls remain independent");
    click(UiAction::MasterMute);
    click(UiAction::MasterMute);
    check(settings.volume == .9, "master mute restores the prior trim");
    click(UiAction::Songs);
    check(ui.song_picker && ui.song_choices.size() == 7, "song picker contains the course playlist");
    click(UiAction::NextSongPage);
    click(UiAction::SelectSong, "eta");
    check(!ui.song_picker && settings.song("MESA") == "eta" && audio.music_status().selection == "eta",
          "selection from a later page reaches the current audio scene");
    click(UiAction::Songs);
    click(UiAction::SelectSong);
    check(settings.song("MESA").empty() && audio.music_status().selection.empty(),
          "Random immediately releases an explicit song preference");
    click(UiAction::Sound);
    const auto main_buttons = ui.buttons();
    check(!ui.audio_options && std::any_of(main_buttons.begin(), main_buttons.end(),
                                           [](const auto& b) { return b.action == UiAction::Exit; }),
          "audio Back restores the wrist app-exit menu");
    auto clip = std::make_shared<PcmClip>();
    clip->rate = 8000;
    clip->samples.assign(8000, .25f);
    settings.volume = 0;
    settings.apply(audio, "MESA", true);
    const auto voice = audio.mixer().play(clip);
    std::array<float, 2400> samples{};
    audio.mixer().render(samples);
    check(std::all_of(samples.begin(), samples.end(), [](float v) { return v == 0; }) &&
              audio.mixer().status(voice)->frame > 0,
          "saved master zero is silent from the first sample while transport advances");
    settings.volume = .4;
    settings.apply(audio, "MESA");
    audio.mixer().render(samples);
    check(samples.back() > .099 && samples.back() < .101, "effects remain audible while music is disabled");
}
} // namespace

int main() {
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-audio-preferences-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));

    struct Cleanup {
        std::filesystem::path path;

        ~Cleanup() { std::filesystem::remove_all(path); }
    } cleanup{root};

    try {
        std::filesystem::create_directories(root);
        persistence(root);
        menus(root / "Map");
        std::cout << "PASS: " << checks
                  << " audio preference, atomic persistence, ray-selected desktop/wrist menu and master/mute checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
