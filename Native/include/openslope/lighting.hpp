#pragma once
#include "lighting_mode.hpp"
#include "world.hpp"

namespace openslope {
struct Props;
struct Appearance;

// std140 layout, private to each renderer so queued views cannot overwrite it.
struct LightingUniform {
    std::array<float, 4> sun_direction{}, sun_colour{}, ambient{}, settings{};
    std::array<float, 4> local_colour{1, 1, 1, 6}, presentation{0, .16f, 0, 0};
};

static_assert(sizeof(LightingUniform) == 96);

struct LocalLight {
    // colour.w identifies only this source's enclosing fixture part for shadow queries.
    std::array<float, 4> position_radius{}, colour{}, direction_cone{0, -1, 0, -1};
    std::array<float, 4> emitter{.3f, 1, 0, 0}; // Emitting radius in metres; calibrated power multiplier.
};

static_assert(sizeof(LocalLight) == 64);

struct LightGrid {
    struct Header {
        std::array<std::uint32_t, 4> shape{1, 1, 0, 0};
        std::array<float, 4> origin_cell{0, 0, 64, 0};
    } header;

    std::vector<LocalLight> lights;
    std::vector<std::array<std::uint32_t, 2>> cells;
    std::vector<std::uint32_t> indices;
    std::span<const std::uint32_t> at(Vec3 position) const;
};

static_assert(sizeof(LightGrid::Header) == 32);

LightGrid local_light_grid(const World& world);
// Fit direct-light power and low-frequency fill against authored terrain samples
// once during upload. Rendering continues to use raw albedo and live shadows.
unsigned calibrate_lighting(LightGrid& lights, const Mesh& mesh, const Appearance& appearance, World& world);
std::vector<std::uint32_t> light_housings(LightGrid& lights, const Props& props);

LightingUniform enhanced_lighting(const World& world, Vec3 eye);
LightingUniform runtime_lighting(const World& world, Vec3 eye);
} // namespace openslope
