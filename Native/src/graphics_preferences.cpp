#include "openslope/graphics_preferences.hpp"
#include "openslope/audio_preferences.hpp"
#include "openslope/ride_ui.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
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
bool GraphicsPreferences::valid_scale(unsigned value) {
    return value == 100 || value == 125 || value == 150 || value == 200;
}

bool GraphicsPreferences::valid_msaa(unsigned value) { return value == 1 || value == 2 || value == 4 || value == 8; }

std::array<std::uint32_t, 2> GraphicsPreferences::scene_size(std::uint32_t width, std::uint32_t height,
                                                             unsigned scale) {
    const auto x = (std::uint64_t(width) * scale + 99) / 100, y = (std::uint64_t(height) * scale + 99) / 100;
    if (!valid_scale(scale) || !width || !height || x > UINT32_MAX || y > UINT32_MAX)
        throw std::invalid_argument("Invalid scaled scene dimensions");
    return {std::uint32_t(x), std::uint32_t(y)};
}

GraphicsPreferences GraphicsPreferences::load(const std::filesystem::path& file) {
    GraphicsPreferences result;
    if (file.empty())
        return result;
    try {
        if (!std::filesystem::exists(file))
            return result;
        if (std::filesystem::file_size(file) > 4096)
            throw std::runtime_error("Graphics preferences exceed their limit");
        const auto json = nlohmann::json::parse(std::ifstream(file));
        if (!json.is_object() || json.value("schema", "") != "openslope-graphics-preferences/v1")
            throw std::runtime_error("Unknown graphics preferences schema");
        if (json.contains("renderScale") && json["renderScale"].is_number_unsigned()) {
            const auto value = json["renderScale"].get<std::uint64_t>();
            if (value <= UINT32_MAX && valid_scale(unsigned(value)))
                result.render_scale = unsigned(value);
        }
        if (json.contains("msaa") && json["msaa"].is_number_unsigned()) {
            const auto value = json["msaa"].get<std::uint64_t>();
            if (value <= UINT32_MAX && valid_msaa(unsigned(value)))
                result.msaa = unsigned(value);
        }
        if (json.contains("snow") && json["snow"].is_number()) {
            const auto value = json["snow"].get<double>();
            if (std::isfinite(value))
                result.snow = std::clamp(value, 0., 10.);
        }
        return result;
    } catch (const std::exception& e) {
        std::cerr << "Graphics preferences ignored: " << e.what() << '\n';
        return {};
    }
}

bool GraphicsPreferences::save(const std::filesystem::path& file) const {
    if (file.empty())
        return false;
    auto temporary = file;
    temporary += ".tmp-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    try {
        if (!valid_scale(render_scale) || !valid_msaa(msaa) || !std::isfinite(snow) || snow < 0 || snow > 10)
            throw std::runtime_error("Invalid graphics preferences");
        const auto content = nlohmann::json{
            {"schema", "openslope-graphics-preferences/v1"},
            {"renderScale", render_scale},
            {"msaa", msaa},
            {"snow", snow}}.dump(2);
        if (!file.parent_path().empty())
            std::filesystem::create_directories(file.parent_path());
        {
            std::ofstream out(temporary, std::ios::binary);
            out.write(content.data(), std::streamsize(content.size()));
            out.flush();
            if (!out)
                throw std::runtime_error("Cannot write graphics preferences");
        }
#ifdef _WIN32
        if (!MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("Cannot replace graphics preferences");
#else
        std::filesystem::rename(temporary, file);
#endif
        return true;
    } catch (const std::exception& e) {
        std::error_code ignored;
        std::filesystem::remove(temporary, ignored);
        std::cerr << "Graphics preferences not saved: " << e.what() << '\n';
        return false;
    }
}

std::filesystem::path GraphicsPreferences::default_path() {
    const auto audio = AudioPreferences::default_path();
    return audio.empty() ? std::filesystem::path{} : audio.parent_path() / "graphics-preferences.json";
}

void GraphicsPreferences::present(RideUi& ui) const {
    ui.render_scale = render_scale;
    ui.antialiasing = msaa;
    ui.snow_amount = snow;
}

bool GraphicsPreferences::handle(const UiResult& selection, RideUi& ui) {
    const auto previous = *this;
    switch (selection.action) {
    case UiAction::Graphics:
        ui.graphics_options = !ui.graphics_options;
        ui.audio_options = ui.song_picker = ui.library = ui.controls = false;
        return false;
    case UiAction::RenderScale:
        if (ui.immersive)
            return false;
        render_scale = render_scale == 100 ? 125 : render_scale == 125 ? 150 : render_scale == 150 ? 200 : 100;
        break;
    case UiAction::Antialiasing:
        if (ui.immersive)
            return false;
        msaa = msaa == 1 ? 2 : msaa == 2 ? 4 : msaa == 4 ? 8 : 1;
        break;
    case UiAction::SnowDown: snow = std::max(0., snow - 1); break;
    case UiAction::SnowUp: snow = std::min(10., snow + 1); break;
    case UiAction::GraphicsReset:
        if (ui.immersive)
            snow = 3;
        else
            *this = {};
        break;
    default: return false;
    }
    present(ui);
    return render_scale != previous.render_scale || msaa != previous.msaa || snow != previous.snow;
}
} // namespace openslope
