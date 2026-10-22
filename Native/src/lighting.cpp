#include "openslope/lighting.hpp"
#include "openslope/appearance.hpp"
#include "openslope/props.hpp"
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>

namespace openslope {
LightingUniform enhanced_lighting(const World& world, Vec3) {
    LightingUniform result;
    const auto luminance = world.sky_colour[0] * .2126f + world.sky_colour[1] * .7152f + world.sky_colour[2] * .0722f;
    // Continuous sky-derived daylight also works for maps without a sun sprite.
    auto day = std::clamp((luminance - .08f) / .28f, 0.f, 1.f);
    // A bright blue night backdrop is not daylight. Exported moonlight has
    // sub-unit strength; bright skies without source metadata keep the fallback.
    if (std::isfinite(world.daylight_limit))
        day = std::min(day, float(std::clamp(world.daylight_limit, 0., 1.)));
    auto direction = world.glare.direction();
    direction.y = std::max(direction.y, .25);
    direction = normalized(direction);
    result.sun_direction = {float(direction.x), float(direction.y), float(direction.z), 0};
    result.sun_colour = {.65f * day, .56f * day, .43f * day, 0};
    result.ambient = {.62f - day * .05f, .67f - day * .04f, .81f - day * .07f, 0};
    result.settings = {1, day, 0, 0};
    if (world.calibration.enabled) {
        const auto& profile = world.calibration;
        for (unsigned c = 0; c < 3; ++c)
            result.local_colour[c] = profile.local_colour[c] * profile.enhanced_amount;
        result.local_colour[3] = profile.falloff;
        result.presentation = {profile.enhanced_amount, profile.bloom, 1, 0};
        if (world.directional.valid) {
            const auto axis = world.directional.direction;
            result.sun_direction = {float(axis.x), float(axis.y), float(axis.z), 0};
            for (unsigned c = 0; c < 3; ++c) {
                const auto value = c == 0   ? world.directional.colour.x
                                   : c == 1 ? world.directional.colour.y
                                            : world.directional.colour.z;
                result.sun_colour[c] = float(value) * profile.directional_gain[c] * profile.enhanced_amount;
            }
        }
    }
    return result;
}

LightGrid local_light_grid(const World& world) {
    LightGrid result;
    double min_x = std::numeric_limits<double>::infinity(), min_z = min_x;
    double max_x = -min_x, max_z = -min_x;
    const auto append = [&](const PointLight& source) {
        if (!finite(source.position) || length(source.position) > 1e7 || !finite(source.colour) ||
            !finite(source.direction) || !std::isfinite(source.radius) || source.radius <= 0 ||
            !std::isfinite(source.intensity) || source.intensity <= 0 || !std::isfinite(source.cone_cos))
            return;
        if (result.lights.size() == 100000)
            throw std::runtime_error("Local light count exceeds its limit");
        const auto r = std::clamp(source.radius, 1., 120.);
        LocalLight light;
        light.position_radius = {float(source.position.x), float(source.position.y), float(source.position.z),
                                 float(r)};
        light.colour = {float(source.colour.x * source.intensity), float(source.colour.y * source.intensity),
                        float(source.colour.z * source.intensity), 0};
        const auto peak = std::max({light.colour[0], light.colour[1], light.colour[2]});
        // Preserve weak-light tuning while giving high-power authored lamps
        // proportional reach. The shader retains the previous daylight ceiling.
        if (peak > 4)
            for (unsigned c = 0; c < 3; ++c)
                light.colour[c] *= std::clamp(peak / 50.f, 4.f, 128.f) / peak;
        const auto dir = normalized(source.direction, {0, -1, 0});
        light.direction_cone = {float(dir.x), float(dir.y), float(dir.z), float(source.cone_cos)};
        result.lights.push_back(light);
        min_x = std::min(min_x, double(light.position_radius[0]) - light.position_radius[3]);
        min_z = std::min(min_z, double(light.position_radius[2]) - light.position_radius[3]);
        max_x = std::max(max_x, double(light.position_radius[0]) + light.position_radius[3]);
        max_z = std::max(max_z, double(light.position_radius[2]) + light.position_radius[3]);
    };
    for (const auto& source : world.point_lights)
        append(source);
    if (world.point_lights.empty())
        for (const auto& source : world.glints)
            append({source.position, source.hue, std::clamp(8. + source.size * .35, 10., 32.), source.brightness});
    result.header.shape[2] = std::uint32_t(result.lights.size());
    if (result.lights.empty()) {
        result.cells.push_back({0, 0});
        return result;
    }
    double size = 64, x, z, nx, nz;
    do {
        x = std::floor(min_x / size) * size;
        z = std::floor(min_z / size) * size;
        nx = std::floor((max_x - x) / size) + 1;
        nz = std::floor((max_z - z) / size) + 1;
        if (nx * nz <= 65536)
            break;
        size *= 2;
    } while (true);
    result.header.origin_cell = {float(x), float(z), float(size), 0};
    result.header.shape[0] = std::uint32_t(nx);
    result.header.shape[1] = std::uint32_t(nz);
    std::vector<std::vector<std::uint32_t>> buckets(std::size_t(nx * nz));
    for (std::uint32_t i = 0; i < result.lights.size(); ++i) {
        const auto& p = result.lights[i].position_radius;
        const auto first_x = std::clamp(int(std::floor((double(p[0]) - p[3] - x) / size)), 0, int(nx) - 1);
        const auto last_x = std::clamp(int(std::floor((double(p[0]) + p[3] - x) / size)), 0, int(nx) - 1);
        const auto first_z = std::clamp(int(std::floor((double(p[2]) - p[3] - z) / size)), 0, int(nz) - 1);
        const auto last_z = std::clamp(int(std::floor((double(p[2]) + p[3] - z) / size)), 0, int(nz) - 1);
        for (int iz = first_z; iz <= last_z; ++iz)
            for (int ix = first_x; ix <= last_x; ++ix)
                buckets[std::size_t(iz) * std::size_t(nx) + ix].push_back(i);
    }
    for (const auto& bucket : buckets) {
        result.cells.push_back({std::uint32_t(result.indices.size()), std::uint32_t(bucket.size())});
        result.indices.insert(result.indices.end(), bucket.begin(), bucket.end());
    }
    return result;
}

unsigned calibrate_lighting(LightGrid& lights, const Mesh& mesh, const Appearance& appearance, World& world) {
    if (!world.calibration.enabled || !world.calibration.fit_lamps || lights.lights.size() > 2048)
        return 0;
    const auto linear = [](double c) { return c <= .04045 ? c / 12.92 : std::pow((c + .055) / 1.055, 2.4); };
    const auto inverse = [](double c) {
        const auto a = 2.51 - 2.43 * c, b = .03 - .59 * c;
        return (-b + std::sqrt(b * b + .56 * a * c)) / (2 * a);
    };
    const auto sample = [](const RgbaImage& image, double u, double v, bool repeat) {
        std::array<double, 4> result{};
        if (!image.width || !image.height || image.pixels.size() != std::size_t(image.width) * image.height * 4 ||
            !std::isfinite(u) || !std::isfinite(v))
            return result;
        u = repeat ? u - std::floor(u) : std::clamp(u, 0., 1.);
        v = repeat ? v - std::floor(v) : std::clamp(v, 0., 1.);
        const auto x = u * image.width - .5, y = v * image.height - .5;
        const auto ix = int(std::floor(x)), iy = int(std::floor(y));
        for (int j = 0; j < 2; ++j)
            for (int i = 0; i < 2; ++i) {
                const auto index = [repeat](int value, unsigned size) {
                    return repeat ? (value % int(size) + int(size)) % int(size) : std::clamp(value, 0, int(size) - 1);
                };
                const auto at =
                    (std::size_t(index(iy + j, image.height)) * image.width + index(ix + i, image.width)) * 4;
                const auto weight = (i ? x - ix : 1 - x + ix) * (j ? y - iy : 1 - y + iy);
                for (unsigned c = 0; c < 4; ++c)
                    result[c] += image.pixels[at + c] * weight / 255;
            }
        return result;
    };

    struct Observation {
        std::size_t sample;
        Vec3 value;
    };

    std::vector<std::vector<Observation>> columns(4 + lights.lights.size());
    std::size_t observations = 0;
    std::vector<Vec3> targets, predicted;
    const auto rig = runtime_lighting(world, {});
    const Vec3 sun{rig.sun_colour[0], rig.sun_colour[1], rig.sun_colour[2]};
    const Vec3 axis{rig.sun_direction[0], rig.sun_direction[1], rig.sun_direction[2]};
    const auto ambient = world.calibration.runtime_ambient;
    const bool warm_fill = world.directional.valid && world.directional.colour.x > world.directional.colour.z * 2;
    const auto stride = std::max<std::size_t>(1, (mesh.indices.size() / 3 + 4095) / 4096);
    for (const auto& batch : mesh.batches) {
        if (batch.lightmap < 0 || batch.texture.empty())
            continue;
        const auto diffuse = appearance.images.find("Textures/" + batch.texture);
        std::ostringstream name;
        name << "Lightmaps/" << std::setfill('0') << std::setw(4) << batch.lightmap << ".png";
        const auto baked = appearance.images.find(name.str());
        if (diffuse == appearance.images.end() || baked == appearance.images.end())
            continue;
        for (std::size_t at = batch.first; at + 2 < std::size_t(batch.first) + batch.count && targets.size() < 4096;
             at += stride * 3) {
            const auto& a = mesh.vertices.at(mesh.indices.at(at));
            const auto& b = mesh.vertices.at(mesh.indices.at(at + 1));
            const auto& c = mesh.vertices.at(mesh.indices.at(at + 2));
            if (a.lw <= 0 || a.lh <= 0 || !baked->second.width || !baked->second.height)
                continue;
            const auto u = (double(a.s) + b.s + c.s) / 3, v = (double(a.t) + b.t + c.t) / 3;
            if (!std::isfinite(u) || !std::isfinite(v) || std::max(std::abs(u), std::abs(v)) > 1e6)
                continue;
            const auto base = sample(diffuse->second, u, v, true);
            const auto inset_x = std::min(.5 / baked->second.width, double(a.lw) * .5);
            const auto inset_y = std::min(.5 / baked->second.height, double(a.lh) * .5);
            const auto lu = std::clamp((double(a.ls) + b.ls + c.ls) / 3, a.lx + inset_x, a.lx + a.lw - inset_x);
            const auto lv = std::clamp((double(a.lt) + b.lt + c.lt) / 3, a.ly + inset_y, a.ly + a.lh - inset_y);
            const auto lightmap = sample(baked->second, lu, lv, false);
            if (base[3] < .5)
                continue;
            const Vec3 albedo{linear(base[0]), linear(base[1]), linear(base[2])};
            if (albedo.x + albedo.y + albedo.z < .03)
                continue;
            const auto target = terrain_light({base[0], base[1], base[2]}, lightmap);
            const Vec3 position{(double(a.x) + b.x + c.x) / 3, (double(a.y) + b.y + c.y) / 3,
                                (double(a.z) + b.z + c.z) / 3};
            auto n =
                normalized(Vec3{double(a.nx) + b.nx + c.nx, double(a.ny) + b.ny + c.ny, double(a.nz) + b.nz + c.nz});
            if (length(n) < .5 || !finite(position))
                continue;
            const auto index = targets.size();
            targets.push_back({inverse(linear(target[0])), inverse(linear(target[1])), inverse(linear(target[2]))});
            const auto hemi = .8 + .2 * (n.y * .5 + .5);
            if (warm_fill)
                columns[0].push_back(
                    {index,
                     {albedo.x * hemi * ambient[0], albedo.y * hemi * ambient[1], albedo.z * hemi * ambient[2]}});
            else {
                columns[0].push_back({index, {albedo.x * hemi, 0, 0}});
                columns[1].push_back({index, {0, albedo.y * hemi, 0}});
                columns[2].push_back({index, {0, 0, albedo.z * hemi}});
            }
            const auto facing = std::max(0., dot(n, axis));
            columns[3].push_back(
                {index, {albedo.x * sun.x * facing, albedo.y * sun.y * facing, albedo.z * sun.z * facing}});
            observations += 4;
            for (const auto id : lights.at(position)) {
                const auto& lamp = lights.lights[id];
                const auto& p = lamp.position_radius;
                const auto delta = Vec3{p[0], p[1], p[2]} - position;
                const auto distance = length(delta);
                if (distance >= p[3])
                    continue;
                const auto direction = delta / std::max(distance, .001);
                auto falloff = std::pow(1 - distance / p[3], 2);
                const auto day = double(rig.settings[1]);
                falloff *= (1 - day) / (1 + distance * distance / (rig.local_colour[3] * rig.local_colour[3])) + day;
                if (lamp.direction_cone[3] > -1) {
                    const auto& cone = lamp.direction_cone;
                    const auto aim = dot(-direction, {cone[0], cone[1], cone[2]});
                    if (aim <= cone[3])
                        continue;
                    falloff *= std::pow((aim - cone[3]) / std::max(1. - cone[3], .00001), 2);
                }
                const auto peak = std::max({lamp.colour[0], lamp.colour[1], lamp.colour[2], .001f});
                falloff *= ((1 - day) + day * std::min(1., 4. / peak)) * std::max(0., dot(n, direction)) * 1.4;
                if (falloff > 0) {
                    if (++observations > 524288)
                        return 0;
                    columns[4 + id].push_back({index,
                                               {albedo.x * lamp.colour[0] * rig.local_colour[0] * falloff,
                                                albedo.y * lamp.colour[1] * rig.local_colour[1] * falloff,
                                                albedo.z * lamp.colour[2] * rig.local_colour[2] * falloff}});
                }
            }
        }
    }
    if (targets.size() < 32)
        return 0;
    std::vector<double> coefficients(columns.size(), 1), weights(targets.size(), 1);
    for (unsigned c = 0; c < 3; ++c)
        coefficients[c] = world.calibration.runtime_ambient[c];
    if (warm_fill) {
        coefficients[0] = 1;
        coefficients[1] = coefficients[2] = 0;
    }
    const auto initial = coefficients;
    predicted.resize(targets.size());
    for (std::size_t j = 0; j < columns.size(); ++j)
        for (const auto& item : columns[j])
            predicted[item.sample] += item.value * coefficients[j];
    const auto error = [&] {
        double sum = 0;
        unsigned count = 0;
        for (std::size_t i = 0; i < targets.size(); i += 4) {
            const auto delta = targets[i] - predicted[i];
            sum += dot(delta, delta);
            ++count;
        }
        return std::sqrt(sum / (3 * count));
    };
    const auto before = error();
    for (unsigned iteration = 0; iteration < 32; ++iteration) {
        if (iteration % 8 == 0)
            for (std::size_t i = 0; i < weights.size(); ++i)
                weights[i] = i % 4 == 0 ? 0 : std::min(1., .15 / std::max(.0001, length(targets[i] - predicted[i])));
        for (std::size_t j = 0; j < columns.size(); ++j) {
            const auto regularization = j < 4 ? .02 : .001;
            auto numerator = regularization * initial[j], denominator = regularization;
            for (const auto& item : columns[j]) {
                const auto residual = targets[item.sample] - predicted[item.sample] + item.value * coefficients[j];
                numerator += dot(item.value, residual) * weights[item.sample];
                denominator += dot(item.value, item.value) * weights[item.sample];
            }
            const auto next =
                std::clamp(numerator / denominator, j < 4 ? 0. : .02, j < 3 && !(warm_fill && j == 0) ? .8 : 4.);
            for (const auto& item : columns[j])
                predicted[item.sample] += item.value * (next - coefficients[j]);
            coefficients[j] = next;
        }
    }
    const auto after = error();
    if (!std::isfinite(after) || after >= before * .995)
        return 0;
    for (unsigned c = 0; c < 3; ++c) {
        world.calibration.runtime_ambient[c] = float(warm_fill ? ambient[c] * coefficients[0] : coefficients[c]);
        world.calibration.directional_gain[c] *= float(coefficients[3]);
    }
    for (std::size_t i = 0; i < lights.lights.size(); ++i)
        lights.lights[i].emitter[1] *= float(coefficients[4 + i]);
    std::clog << "Lighting calibration held-out linear RMS: " << before << " -> " << after << '\n';
    return unsigned(targets.size());
}

std::vector<std::uint32_t> light_housings(LightGrid& lights, const Props& props) {
    for (auto& lamp : lights.lights)
        lamp.colour[3] = 0;
    std::vector<std::uint32_t> first;
    std::uint64_t next = 1;
    for (const auto& instance : props.instances) {
        const auto count = props.models.at(instance.model).parts.size();
        if (next + count > 0x1000000)
            return {}; // Vulkan's instance custom index has 24 bits.
        first.push_back(std::uint32_t(next));
        next += count;
    }
    std::vector<double> volumes(lights.lights.size(), std::numeric_limits<double>::infinity());
    for (std::size_t i = 0; i < props.instances.size(); ++i) {
        const auto& instance = props.instances[i];
        if (!instance.visible)
            continue;
        Transform pose;
        std::copy(instance.pose.matrix.begin(), instance.pose.matrix.end(), pose.begin());
        const auto& parts = props.models[instance.model].parts;
        for (std::size_t j = 0; j < parts.size(); ++j) {
            const auto& part = props.parts.at(parts[j]);
            if (part.wave_count || prop_alpha_mode(part, false) != 0)
                continue;
            Bounds box;
            for (unsigned corner = 0; corner < 8; ++corner)
                box.add(transform_point(pose, {corner & 1 ? part.bounds.max.x : part.bounds.min.x,
                                               corner & 2 ? part.bounds.max.y : part.bounds.min.y,
                                               corner & 4 ? part.bounds.max.z : part.bounds.min.z}));
            const auto size = box.max - box.min;
            // Only a compact, three-dimensional housing enclosing the source.
            // Large structures, long poles and degenerate bounds still occlude.
            if (!finite(size) || std::min({size.x, size.y, size.z}) < .05 || std::max({size.x, size.y, size.z}) > 10)
                continue;
            const auto volume = size.x * size.y * size.z;
            std::vector<std::uint32_t> candidates;
            for (unsigned corner = 0; corner < 4; ++corner) {
                const auto bucket =
                    lights.at({corner & 1 ? box.max.x : box.min.x, 0, corner & 2 ? box.max.z : box.min.z});
                candidates.insert(candidates.end(), bucket.begin(), bucket.end());
            }
            std::sort(candidates.begin(), candidates.end());
            candidates.erase(std::unique(candidates.begin(), candidates.end()), candidates.end());
            for (const auto index : candidates) {
                auto& lamp = lights.lights[index];
                const auto& p = lamp.position_radius;
                if (volume < volumes[index] && p[0] > box.min.x && p[0] < box.max.x && p[1] > box.min.y &&
                    p[1] < box.max.y && p[2] > box.min.z && p[2] < box.max.z) {
                    volumes[index] = volume;
                    lamp.colour[3] = float(first[i] + j);
                    lamp.emitter[0] = float(std::clamp(std::min({size.x, size.y, size.z}) * .25, .15, .75));
                }
            }
        }
    }
    return first;
}

std::span<const std::uint32_t> LightGrid::at(Vec3 position) const {
    if (!finite(position))
        return {};
    const auto x = std::floor((position.x - header.origin_cell[0]) / header.origin_cell[2]);
    const auto z = std::floor((position.z - header.origin_cell[1]) / header.origin_cell[2]);
    if (x < 0 || z < 0 || x >= header.shape[0] || z >= header.shape[1])
        return {};
    const auto cell = cells[std::size_t(z) * header.shape[0] + std::size_t(x)];
    return std::span<const std::uint32_t>(indices).subspan(cell[0], cell[1]);
}

LightingUniform runtime_lighting(const World& world, Vec3 eye) {
    auto result = enhanced_lighting(world, eye);
    const auto day = result.settings[1];
    // Raw albedo needs a complete direct-light response, rather than a
    // modulation of the imported shading. Sky fill approximates indirect light.
    result.settings[0] = float(LightingMode::Runtime);
    result.sun_colour = {1.4f * day, 1.25f * day, 1.05f * day, 0};
    result.ambient = {.06f + .16f * day, .09f + .20f * day, .15f + .25f * day, 0};
    if (world.calibration.enabled) {
        for (unsigned c = 0; c < 3; ++c) {
            result.ambient[c] = world.calibration.runtime_ambient[c];
            result.local_colour[c] = world.calibration.local_colour[c];
            if (world.directional.valid) {
                const auto value = c == 0   ? world.directional.colour.x
                                   : c == 1 ? world.directional.colour.y
                                            : world.directional.colour.z;
                result.sun_colour[c] = float(value) * world.calibration.directional_gain[c];
            }
        }
    }
    return result;
}
} // namespace openslope
