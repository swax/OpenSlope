#pragma once
#include "celestial.hpp"
#include "props.hpp"
#include <string_view>

namespace openslope {
struct Appearance;
std::vector<std::string> skybox_files(const std::filesystem::path& root);

struct LightingCalibration {
    bool enabled = false;
    bool fit_lamps = false;
    std::array<float, 3> runtime_ambient{.06f, .09f, .15f}, local_colour{1, 1, 1};
    std::array<float, 3> directional_gain{.2f, .2f, .2f};
    float falloff = 6, enhanced_amount = .05f, bloom = .04f;
    static LightingCalibration for_course(std::string_view course);
};

struct World {
    Props sky;
    Glare glare;
    std::vector<LampGlint> glints;
    std::vector<PointLight> point_lights;
    DirectionalLight directional;
    double daylight_limit = 1; // Exported moonlight can constrain the sky fallback.
    LightingCalibration calibration;
    std::array<float, 3> sky_colour{.065f, .11f, .18f}, fog_colour{};
    float fog_start{}, fog_end{};
    bool explicit_sky = false, explicit_fog_colour = false;
    static World load(const std::filesystem::path& root);
    void fit_colours(const Appearance& appearance);
    std::array<float, 2> draw_fog(float range) const;
};
} // namespace openslope
