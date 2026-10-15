#pragma once
#include "props.hpp"

namespace openslope {
struct Appearance;
std::vector<std::string> skybox_files(const std::filesystem::path& root);

struct World {
    Props sky;
    std::array<float, 3> sky_colour{.065f, .11f, .18f}, fog_colour{};
    float fog_start{}, fog_end{};
    bool explicit_sky = false, explicit_fog_colour = false;
    static World load(const std::filesystem::path& root);
    void fit_colours(const Appearance& appearance);
};
} // namespace openslope
