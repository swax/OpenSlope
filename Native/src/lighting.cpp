#include "openslope/lighting.hpp"
#include <algorithm>

namespace openslope {
LightingUniform enhanced_lighting(const World& world, Vec3 eye) {
    LightingUniform result;
    const auto luminance = world.sky_colour[0] * .2126f + world.sky_colour[1] * .7152f + world.sky_colour[2] * .0722f;
    // Continuous sky-derived daylight also works for maps without a sun sprite.
    const auto day = std::clamp((luminance - .08f) / .28f, 0.f, 1.f);
    auto direction = world.glare.direction();
    direction.y = std::max(direction.y, .25);
    direction = normalized(direction);
    result.sun_direction = {float(direction.x), float(direction.y), float(direction.z), 0};
    result.sun_colour = {.65f * day, .56f * day, .43f * day, 0};
    result.ambient = {.62f - day * .05f, .67f - day * .04f, .81f - day * .07f, 0};
    result.settings = {1, day, 0, 0};
    std::vector<std::pair<double, LightingUniform::Lamp>> nearby;
    const auto append = [&](Vec3 position, Vec3 colour, double radius, double intensity) {
        const auto distance = length(position - eye);
        if (intensity <= 0 || distance >= 160)
            return;
        LightingUniform::Lamp lamp;
        lamp.position_radius = {float(position.x), float(position.y), float(position.z), float(radius)};
        lamp.colour = {float(colour.x * intensity), float(colour.y * intensity), float(colour.z * intensity), 0};
        nearby.emplace_back(distance, lamp);
    };
    for (const auto& lamp : world.point_lights)
        append(lamp.position, lamp.colour, lamp.radius, lamp.intensity);
    if (world.point_lights.empty())
        for (const auto& lamp : world.glints)
            append(lamp.position, lamp.hue, std::clamp(8. + lamp.size * .35, 10., 32.), lamp.brightness);
    std::stable_sort(nearby.begin(), nearby.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    const auto count = std::min(nearby.size(), result.lamps.size());
    result.settings[2] = float(count);
    for (std::size_t i = 0; i < count; ++i)
        result.lamps[i] = nearby[i].second;
    return result;
}
} // namespace openslope
