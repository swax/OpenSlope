#pragma once
#include "world.hpp"

namespace openslope {
// std140 layout, private to each renderer so queued views cannot overwrite it.
struct LightingUniform {
    std::array<float, 4> sun_direction{}, sun_colour{}, ambient{}, settings{};

    struct Lamp {
        std::array<float, 4> position_radius{}, colour{};
    };

    std::array<Lamp, 16> lamps{};
};

static_assert(sizeof(LightingUniform) == 576);

LightingUniform enhanced_lighting(const World& world, Vec3 eye);
} // namespace openslope
