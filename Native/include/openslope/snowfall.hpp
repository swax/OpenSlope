#pragma once
#include "math.hpp"
#include <cstdint>
#include <vector>

namespace openslope {
struct SnowSettings {
    unsigned flakes = 600;
    Vec3 box{40, 34, 40};
    double lift = 5, fall_min = 2.2, fall_max = 4, drift = .7;
    double size_min = .1, size_max = .3, near_start = .25, near_end = .6;
    double edge_fade = .2, alpha = .5, brightness = .6, softness = .55;
};

struct SnowFlake {
    std::array<float, 3> base;
    std::array<float, 4> random;
};

static_assert(sizeof(SnowFlake) == 28);

inline constexpr unsigned maximum_snowflakes = 100000;
inline constexpr std::uint32_t snow_seed = 0x534e4f57;

// The default stop follows public play-profile assertions. The upper range is
// application weather tuning, not a recovered original-course weather roll.
SnowSettings snow_settings(double amount);
std::vector<SnowFlake> snow_flakes(unsigned count = maximum_snowflakes, std::uint32_t seed = snow_seed);
Vec3 snow_centre(Vec3 eye, const SnowSettings& settings);
Vec3 snow_path(const SnowFlake& flake, double time, const SnowSettings& settings);
Vec3 snow_offset(Vec3 position, Vec3 centre, const SnowSettings& settings);
double snow_edge_scale(Vec3 offset, const SnowSettings& settings);
double snow_near_scale(double distance, const SnowSettings& settings);
double snow_size(const SnowFlake& flake, const SnowSettings& settings);

struct SnowfallView {
    Vec3 eye{}; // One cyclopean anchor for both eyes; independent of each view matrix.
    double time = 0, amount = 0;
};
} // namespace openslope
