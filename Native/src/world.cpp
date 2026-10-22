#include "openslope/world.hpp"
#include "openslope/appearance.hpp"
#include <fstream>
#include <nlohmann/json.hpp>
#include <set>
#include <tuple>

namespace openslope {
namespace {
void within(const std::filesystem::path& root, const std::filesystem::path& path) {
    const auto relative =
        std::filesystem::weakly_canonical(path).lexically_relative(std::filesystem::weakly_canonical(root));
    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
        throw std::runtime_error("World asset resolves outside its course");
}

std::array<float, 3> colour(const nlohmann::json& value) {
    if (!value.is_array() || value.size() != 3)
        throw std::runtime_error("World colour requires three byte channels");
    std::array<float, 3> result{};
    for (unsigned i = 0; i < 3; ++i) {
        const auto v = value[i].get<double>();
        if (!std::isfinite(v) || v < 0 || v > 255)
            throw std::runtime_error("World colour channel is outside 0..255");
        result[i] = float(v / 255);
    }
    return result;
}

LightingCalibration load_calibration(const std::filesystem::path& root, LightingCalibration preset) {
    const auto file = root / "NativeLighting.json";
    if (!std::filesystem::exists(file))
        return preset;
    within(root, file);
    if (std::filesystem::file_size(file) > 8192)
        throw std::runtime_error("Native lighting calibration exceeds 8 KiB");
    std::ifstream input(file);
    const auto profile = nlohmann::json::parse(input);
    if (profile.value("Schema", "") != "openslope-native-lighting/v1")
        throw std::runtime_error("Unsupported native lighting calibration");
    preset.enabled = profile.value("Enabled", true);
    preset.fit_lamps = profile.value("AutoFit", preset.fit_lamps);
    const auto scalar = [](const nlohmann::json& value, float low, float high) {
        const auto number = value.get<float>();
        if (!std::isfinite(number) || number < low || number > high)
            throw std::runtime_error("Native lighting calibration value is outside its range");
        return number;
    };
    const auto rgb = [&](const char* key, std::array<float, 3>& result) {
        if (!profile.contains(key))
            return;
        const auto& values = profile.at(key);
        if (!values.is_array() || values.size() != 3)
            throw std::runtime_error("Native lighting calibration requires three linear RGB channels");
        for (unsigned i = 0; i < 3; ++i)
            result[i] = scalar(values[i], 0, 8);
    };
    rgb("RuntimeAmbient", preset.runtime_ambient);
    rgb("LocalColour", preset.local_colour);
    rgb("DirectionalGain", preset.directional_gain);
    for (const auto& [key, target, low, high] : {std::tuple{"FalloffMetres", &preset.falloff, 1.f, 32.f},
                                                 {"EnhancedAmount", &preset.enhanced_amount, 0.f, .5f},
                                                 {"Bloom", &preset.bloom, 0.f, .25f}})
        if (profile.contains(key))
            *target = scalar(profile.at(key), low, high);
    return preset;
}
} // namespace

LightingCalibration LightingCalibration::for_course(std::string_view course) {
    LightingCalibration result;
    // Course identifiers come from World.json, independent of folder naming.
    result.enabled = course == "SNOW" || course == "MERQUER" || course == "MESA";
    result.fit_lamps = result.enabled;
    if (course == "MESA") {
        result.runtime_ambient = {.12f, .1f, .08f};
        result.directional_gain = {.35f, .35f, .35f};
    }
    return result;
}

std::vector<std::string> skybox_files(const std::filesystem::path& root) {
    if (root.empty() || !std::filesystem::exists(root / "Skybox"))
        return {};
    within(root, root / "Skybox");
    if (!std::filesystem::is_directory(root / "Skybox") ||
        !std::filesystem::is_regular_file(root / "Skybox/Models.json") ||
        !std::filesystem::is_regular_file(root / "Skybox/Materials.json"))
        throw std::runtime_error("Skybox requires model and material tables");
    auto files = prop_files(root / "Skybox", true);
    for (auto& name : files)
        name = "Skybox/" + name;
    return files;
}

World World::load(const std::filesystem::path& root) {
    World result;
    if (root.empty())
        return result;
    result.glints = load_lamp_glints(root, &result.point_lights, &result.daylight_limit, &result.directional);
    skybox_files(root);
    result.sky = Props::load(root / "Skybox", true);
    if (!result.sky.parts.empty()) {
        result.fog_start = 600;
        result.fog_end = 2200;
    }
    const auto file = root / "World.json";
    if (!std::filesystem::exists(file)) {
        result.calibration = load_calibration(root, {});
        return result;
    }
    within(root, file);
    if (std::filesystem::file_size(file) > 65536)
        throw std::runtime_error("World profile exceeds 64 KiB");
    std::ifstream input(file);
    const auto profile = nlohmann::json::parse(input);
    if (profile.value("Schema", "") != "openslope-world/v1")
        throw std::runtime_error("Unsupported world profile");
    if (profile.contains("Course") && profile.at("Course").is_string())
        result.calibration = LightingCalibration::for_course(profile.at("Course").get<std::string>());
    result.calibration = load_calibration(root, result.calibration);
    if (profile.contains("SkyColor")) {
        result.sky_colour = colour(profile.at("SkyColor"));
        result.explicit_sky = true;
    }
    if (profile.contains("Glare")) {
        const auto& fields = profile.at("Glare");
        auto& glare = result.glare;
        glare.enabled = fields.value("Enabled", false);
        if (fields.contains("CoreColour"))
            glare.core = colour(fields.at("CoreColour"));
        if (fields.contains("RimColour"))
            glare.rim = colour(fields.at("RimColour"));
        const auto scalar = [&](const char* name, double fallback, double low, double high) {
            const auto value = fields.value(name, fallback);
            if (!std::isfinite(value) || value < low || value > high)
                throw std::runtime_error("Invalid celestial parameter");
            return value;
        };
        glare.fan_intensity = scalar("FanIntensity", glare.fan_intensity, 0, 10);
        glare.sprite_intensity = scalar("SpriteIntensity", glare.sprite_intensity, 0, 10);
        glare.azimuth = std::remainder(scalar("AzimuthDegrees", glare.azimuth, -360000, 360000), 360.);
        glare.elevation = scalar("ElevationDegrees", glare.elevation, -90, 90);
        glare.distance = scalar("DistanceUnits", glare.distance, 1, 1e8);
        glare.radius = scalar("SizeUnits", glare.radius, 0, 1e8);
    }
    if (profile.contains("Fog")) {
        const auto& fog = profile.at("Fog");
        if (!fog.value("Enabled", true)) {
            result.fog_start = result.fog_end = 0;
            return result;
        }
        result.fog_start = fog.at("Start").get<float>();
        result.fog_end = fog.at("End").get<float>();
        if (!std::isfinite(result.fog_start) || !std::isfinite(result.fog_end) || result.fog_start < 0 ||
            result.fog_end <= result.fog_start || result.fog_end > 10000)
            throw std::runtime_error("Invalid world fog distances");
        if (fog.contains("Color")) {
            result.fog_colour = colour(fog.at("Color"));
            result.explicit_fog_colour = true;
        }
    }
    return result;
}

std::array<float, 2> World::draw_fog(float range) const {
    if (!std::isfinite(range) || range <= 0)
        throw std::invalid_argument("Invalid fog draw range");
    if (fog_end > 0 && fog_end <= range)
        return {fog_start, fog_end};
    return {fog_end > 0 ? std::min(fog_start, range * .5f) : range * .5f, range};
}

void World::fit_colours(const Appearance& appearance) {
    if (sky.geometry.vertices.empty()) {
        if (!explicit_fog_colour)
            fog_colour = sky_colour;
        return;
    }
    double top = -std::numeric_limits<double>::infinity();
    for (const auto& p : sky.geometry.vertices)
        top = std::max(top, double(p.y));
    const auto sample = [&](bool zenith) {
        std::array<double, 3> total{};
        double weight = 0;
        std::set<std::string> used;
        for (const auto& part : sky.parts) {
            double lo = std::numeric_limits<double>::infinity(), hi = -lo, low_uv = 0, high_uv = 0;
            for (std::size_t i = part.first; i < part.first + part.count; ++i) {
                const auto& p = sky.geometry.vertices[sky.geometry.indices[i]];
                if (p.y < lo) {
                    lo = p.y;
                    low_uv = p.t;
                }
                if (p.y > hi) {
                    hi = p.y;
                    high_uv = p.t;
                }
            }
            if ((zenith ? hi < top - .001 : lo > 0 || hi < 0) || hi <= lo || !used.insert(part.texture).second)
                continue;
            const auto found = appearance.images.find("Skybox/Textures/" + part.texture);
            if (found == appearance.images.end())
                continue;
            const auto& image = found->second;
            const auto uv = zenith ? high_uv : low_uv + (high_uv - low_uv) * (-lo) / (hi - lo);
            const auto row = std::min(image.height - 1, unsigned(std::clamp(uv, 0., 1.) * image.height));
            for (unsigned x = 0; x < image.width; ++x) {
                const auto pixel = (std::size_t(row) * image.width + x) * 4;
                const auto alpha = image.pixels[pixel + 3] / 255.;
                weight += alpha;
                for (unsigned c = 0; c < 3; ++c)
                    total[c] += image.pixels[pixel + c] * alpha / 255;
            }
        }
        std::array<float, 3> value = sky_colour;
        if (weight > 0)
            for (unsigned c = 0; c < 3; ++c)
                value[c] = float(total[c] / weight);
        return value;
    };
    // [Trailmap: 400-backdrop, 442-load] An authored seam-matching default;
    // original executable sky channels are not compiled into this application.
    if (!explicit_sky)
        sky_colour = sample(true);
    if (!explicit_fog_colour)
        fog_colour = sample(false);
}
} // namespace openslope
