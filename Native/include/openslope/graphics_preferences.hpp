#pragma once
#include "lighting_mode.hpp"
#include <array>
#include <cstdint>
#include <filesystem>

namespace openslope {
class RideUi;
struct UiResult;

struct GraphicsPreferences {
    unsigned render_scale = 150, msaa = 4;
    double snow = 3;
    LightingMode lighting = LightingMode::Original;
    static GraphicsPreferences load(const std::filesystem::path& file);
    bool save(const std::filesystem::path& file) const;
    static std::filesystem::path default_path();
    static bool valid_scale(unsigned value);
    static bool valid_msaa(unsigned value);
    static std::array<std::uint32_t, 2> scene_size(std::uint32_t width, std::uint32_t height, unsigned scale);
    void present(RideUi& ui) const;
    bool handle(const UiResult& selection, RideUi& ui);
};
} // namespace openslope
