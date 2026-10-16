#include "openslope/audio_preferences.hpp"
#include "openslope/audio_scene.hpp"
#include "openslope/ride_ui.hpp"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace openslope {
namespace {
using Json = nlohmann::json;

bool name(const std::string& value) {
    return !value.empty() && value.size() <= 255 && value != "." && value != ".." &&
           std::all_of(value.begin(), value.end(), [](unsigned char c) { return c >= 32 && c != '/' && c != '\\'; });
}

std::string key(std::string value) {
    if (!name(value))
        return {};
    for (auto& c : value)
        if (c >= 'a' && c <= 'z')
            c = char(c - 'a' + 'A');
    return value;
}
} // namespace

AudioPreferences AudioPreferences::load(const std::filesystem::path& file) {
    AudioPreferences result;
    if (file.empty())
        return result;
    try {
        if (!std::filesystem::exists(file))
            return result;
        if (std::filesystem::file_size(file) > 256 * 1024)
            throw std::runtime_error("Audio preferences exceed their limit");
        const auto json = Json::parse(std::ifstream(file));
        if (!json.is_object() || json.value("schema", "") != "openslope-audio-preferences/v1")
            throw std::runtime_error("Unknown audio preferences schema");
        if (json.contains("musicEnabled") && json.at("musicEnabled").is_boolean())
            result.music_enabled = json.at("musicEnabled");
        const auto number = [&](const char* field, double fallback) {
            if (!json.contains(field) || !json.at(field).is_number())
                return fallback;
            const auto value = json.at(field).get<double>();
            return std::isfinite(value) ? std::clamp(value, 0., 1.) : fallback;
        };
        result.volume = number("volume", 1);
        result.audible_volume = number("audibleVolume", 1);
        if (result.volume > 0)
            result.audible_volume = result.volume;
        if (result.audible_volume == 0)
            result.audible_volume = 1;
        if (json.contains("songs") && json.at("songs").is_object()) {
            if (json.at("songs").size() > 512)
                throw std::runtime_error("Too many course music preferences");
            for (const auto& [course, selection] : json.at("songs").items())
                if (!key(course).empty() && selection.is_string())
                    result.song(course, selection.get<std::string>());
        }
        return result;
    } catch (const std::exception& e) {
        std::cerr << "Audio preferences ignored: " << e.what() << '\n';
        return {};
    }
}

bool AudioPreferences::save(const std::filesystem::path& file) const {
    if (file.empty())
        return false;
    auto temporary = file;
    temporary += ".tmp-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    try {
        if (songs_.size() > 512 || !std::isfinite(volume) || volume < 0 || volume > 1 ||
            !std::isfinite(audible_volume) || audible_volume <= 0 || audible_volume > 1)
            throw std::runtime_error("Invalid audio preferences");
        const auto content = Json{
            {"schema", "openslope-audio-preferences/v1"},
            {"musicEnabled", music_enabled},
            {"volume", volume},
            {"audibleVolume", audible_volume},
            {"songs", songs_}}.dump(2);
        if (content.size() > 256 * 1024)
            throw std::runtime_error("Audio preferences exceed their limit");
        if (!file.parent_path().empty())
            std::filesystem::create_directories(file.parent_path());
        {
            std::ofstream out(temporary, std::ios::binary);
            out.write(content.data(), std::streamsize(content.size()));
            out.flush();
            if (!out)
                throw std::runtime_error("Cannot write audio preferences");
        }
#ifdef _WIN32
        if (!MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("Cannot replace audio preferences");
#else
        std::filesystem::rename(temporary, file);
#endif
        return true;
    } catch (const std::exception& e) {
        std::error_code ignored;
        std::filesystem::remove(temporary, ignored);
        std::cerr << "Audio preferences not saved: " << e.what() << '\n';
        return false;
    }
}

std::filesystem::path AudioPreferences::default_path() {
#ifdef _WIN32
    std::wstring path(32768, wchar_t(0));
    const auto length = GetEnvironmentVariableW(L"LOCALAPPDATA", path.data(), DWORD(path.size()));
    if (length && length < path.size()) {
        path.resize(length);
        return std::filesystem::path(path) / "OpenSlope" / "audio-preferences.json";
    }
#else
    if (const auto path = std::getenv("XDG_CONFIG_HOME"); path && *path)
        return std::filesystem::path(path) / "OpenSlope/audio-preferences.json";
    if (const auto path = std::getenv("HOME"); path && *path)
        return std::filesystem::path(path) / ".config/OpenSlope/audio-preferences.json";
#endif
    return {};
}

std::string AudioPreferences::song(const std::string& course) const {
    const auto found = songs_.find(key(course));
    return found == songs_.end() ? "" : found->second;
}

void AudioPreferences::song(const std::string& course, const std::string& value) {
    const auto id = key(course);
    if (id.empty())
        return;
    if (value.empty())
        songs_.erase(id);
    else if (name(value) && (songs_.contains(id) || songs_.size() < 512))
        songs_[id] = value;
}

void AudioPreferences::toggle_mute() {
    if (volume > 0) {
        audible_volume = volume;
        volume = 0;
    } else {
        volume = audible_volume;
    }
}

void AudioPreferences::apply(AudioScene& audio, const std::string& course, bool initial) const {
    const auto status = audio.music_status();
    auto selection = song(course);
    if (std::find(status.songs.begin(), status.songs.end(), selection) == status.songs.end())
        selection.clear();
    audio.music_enabled(music_enabled);
    audio.music_song(selection);
    audio.mixer().volume(volume, initial);
}

void AudioPreferences::present(RideUi& ui, const AudioScene* audio, const std::string& course) const {
    const auto status = audio ? audio->music_status() : MusicStatus{};
    ui.music_enabled = music_enabled;
    ui.master_volume = volume;
    ui.sound_muted = volume == 0;
    ui.authored_music = status.authored;
    ui.song_choices = status.songs;
    ui.current_song = status.song;
    ui.song_selection = song(course);
    if (std::find(status.songs.begin(), status.songs.end(), ui.song_selection) == status.songs.end())
        ui.song_selection.clear();
}

bool AudioPreferences::handle(const UiResult& result, RideUi& ui, AudioScene* audio, const std::string& course) {
    switch (result.action) {
    case UiAction::Sound:
        ui.audio_options = !ui.audio_options;
        ui.song_picker = false;
        ui.controls = ui.library = ui.graphics_options = false;
        return false;
    case UiAction::Songs:
        if (!ui.authored_music) {
            ui.song_picker = !ui.song_picker;
            ui.song_page = 0;
        }
        return false;
    case UiAction::PreviousSongPage:
        if (ui.song_page)
            --ui.song_page;
        return false;
    case UiAction::NextSongPage:
        if ((ui.song_page + 1) * 5 < ui.song_choices.size())
            ++ui.song_page;
        return false;
    case UiAction::Music: music_enabled = !music_enabled; break;
    case UiAction::MasterMute: toggle_mute(); break;
    case UiAction::VolumeDown:
    case UiAction::VolumeUp:
        volume = std::clamp((std::round(volume * 10) + (result.action == UiAction::VolumeUp ? 1 : -1)) / 10, 0., 1.);
        if (volume > 0)
            audible_volume = volume;
        break;
    case UiAction::SelectSong:
        if (ui.authored_music || (!result.value.empty() && std::find(ui.song_choices.begin(), ui.song_choices.end(),
                                                                     result.value) == ui.song_choices.end()))
            return false;
        song(course, result.value);
        ui.song_picker = false;
        break;
    default: return false;
    }
    if (audio)
        apply(*audio, course);
    present(ui, audio, course);
    return true;
}
} // namespace openslope
