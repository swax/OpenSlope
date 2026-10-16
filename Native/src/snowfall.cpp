#include "openslope/snowfall.hpp"
#include <stdexcept>

namespace openslope {
namespace {
double smooth(double t) {
    t = std::clamp(t, 0., 1.);
    return t * t * (3 - 2 * t);
}
} // namespace

SnowSettings snow_settings(double amount) {
    if (!std::isfinite(amount))
        throw std::invalid_argument("Invalid snowfall amount");
    amount = std::clamp(amount, 0., 10.);
    SnowSettings result;
    if (amount <= 3) {
        result.flakes = unsigned(std::lround(result.flakes * amount / 3));
        return result;
    }
    const auto t = (amount - 3) / 7;
    const auto blend = [t](double a, double b) { return a + (b - a) * t; };
    result.flakes = unsigned(std::lround(blend(result.flakes, maximum_snowflakes)));
    result.box = {blend(40, 20), blend(34, 18), blend(40, 20)};
    result.fall_min = blend(result.fall_min, 7);
    result.fall_max = blend(result.fall_max, 11);
    result.drift = blend(result.drift, 14);
    result.alpha = blend(result.alpha, .75);
    return result;
}

std::vector<SnowFlake> snow_flakes(unsigned count, std::uint32_t seed) {
    if (count > maximum_snowflakes)
        throw std::invalid_argument("Snowflake field exceeds its bound");
    auto state = seed;
    const auto random = [&]() {
        state = state * 1664525u + 1013904223u;
        return float(state >> 8) / 16777216.f;
    };
    std::vector<SnowFlake> result;
    result.reserve(count);
    for (unsigned i = 0; i < count; ++i)
        result.push_back({{random(), random(), random()}, {random(), random(), random(), random()}});
    return result;
}

Vec3 snow_centre(Vec3 eye, const SnowSettings& settings) { return eye + Vec3{0, settings.lift, 0}; }

Vec3 snow_path(const SnowFlake& flake, double time, const SnowSettings& s) {
    const Vec3 motion{(flake.random[0] * 2 - 1) * s.drift, -(s.fall_min + (s.fall_max - s.fall_min) * flake.random[2]),
                      (flake.random[1] * 2 - 1) * s.drift};
    return Vec3{flake.base[0] * s.box.x, flake.base[1] * s.box.y, flake.base[2] * s.box.z} + motion * time;
}

Vec3 snow_offset(Vec3 position, Vec3 centre, const SnowSettings& s) {
    const auto fold = [](double x, double width) { return x - width * std::floor((x + width * .5) / width); };
    const auto p = position - centre;
    return {fold(p.x, s.box.x), fold(p.y, s.box.y), fold(p.z, s.box.z)};
}

double snow_edge_scale(Vec3 offset, const SnowSettings& s) {
    const auto edge = std::max(
        {std::abs(offset.x) * 2 / s.box.x, std::abs(offset.y) * 2 / s.box.y, std::abs(offset.z) * 2 / s.box.z});
    return smooth((1 - edge) / s.edge_fade);
}

double snow_near_scale(double distance, const SnowSettings& s) {
    return smooth((distance - s.near_start) / (s.near_end - s.near_start));
}

double snow_size(const SnowFlake& flake, const SnowSettings& s) {
    return s.size_min + (s.size_max - s.size_min) * flake.random[3];
}
} // namespace openslope
