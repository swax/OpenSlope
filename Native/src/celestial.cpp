#include "openslope/celestial.hpp"
#include "celestial_spokes.hpp"
#include "import_internal.hpp"
#include <algorithm>
#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
namespace {
struct Point {
    double x{}, y{};

    Point operator+(Point b) const { return {x + b.x, y + b.y}; }

    Point operator-(Point b) const { return {x - b.x, y - b.y}; }

    Point operator*(double s) const { return {x * s, y * s}; }
};

struct Spoke {
    double angle{}, amplitude{};
};

const std::vector<Spoke>& spokes() {
    static const auto pattern = [] {
        const auto doc =
            nlohmann::json::parse(std::begin(bundled::celestial_spokes), std::end(bundled::celestial_spokes));
        std::vector<Spoke> result;
        for (const auto& s : doc.at("Spokes"))
            result.push_back({s.at("deg").get<double>() * pi / 180, s.at("amp").get<double>()});
        return result;
    }();
    return pattern;
}

double side(Point direction, Point point) { return direction.x * point.y - direction.y * point.x; }

std::vector<Point> clip_half_plane(std::vector<Point> polygon, Point origin, Point ray, double sign) {
    std::vector<Point> result;
    if (polygon.empty())
        return result;
    auto a = polygon.back();
    auto da = side(ray, a - origin) * sign;
    for (const auto b : polygon) {
        const auto db = side(ray, b - origin) * sign;
        if ((da >= 0) != (db >= 0))
            result.push_back(a + (b - a) * (da / (da - db)));
        if (db >= 0)
            result.push_back(b);
        a = b;
        da = db;
    }
    return result;
}

std::array<double, 4> project(const CelestialView& view, Vec3 p) {
    std::array<double, 4> result{};
    for (unsigned r = 0; r < 4; ++r)
        result[r] = view.clip[r] * p.x + view.clip[4 + r] * p.y + view.clip[8 + r] * p.z + view.clip[12 + r];
    return result;
}

Vertex vertex(std::array<double, 4> p, std::array<float, 3> rgb, double intensity, double u = 0, double v = 0) {
    Vertex result{float(p[0]),
                  float(p[1]),
                  float(p[2]),
                  float(rgb[0] * intensity),
                  float(rgb[1] * intensity),
                  float(rgb[2] * intensity)};
    result.s = float(u);
    result.t = float(v);
    result.ls = 1;
    result.lt = float(p[3]);
    return result;
}
} // namespace

std::vector<LampGlint> load_lamp_glints(const std::filesystem::path& root) {
    using Json = nlohmann::json;
    Json doc;
    const auto read = [&](const std::filesystem::path& file, std::uintmax_t maximum) {
        const auto relative =
            std::filesystem::weakly_canonical(file).lexically_relative(std::filesystem::weakly_canonical(root));
        if (relative.empty() || relative.is_absolute() || *relative.begin() == ".." ||
            std::filesystem::file_size(file) > maximum)
            throw std::runtime_error("Invalid course light asset");
        std::ifstream input(file, std::ios::binary);
        return std::vector<std::uint8_t>(std::istreambuf_iterator<char>(input), {});
    };
    if (std::filesystem::exists(root / "Lights.json")) {
        const auto bytes = read(root / "Lights.json", 32 * 1024 * 1024);
        doc = Json::parse(bytes);
    } else if (std::filesystem::is_directory(root / "Source")) {
        // Older Native ISO imports retain their source geometry. Decode only its light table.
        for (const auto& entry : std::filesystem::directory_iterator(root / "Source")) {
            const auto name = entry.path().filename().string();
            if (entry.path().extension() != ".PBD" || name.ends_with("_SKY.PBD"))
                continue;
            const auto bytes = read(entry.path(), 512 * 1024 * 1024);
            doc = Json::parse(import_detail::light_document(bytes));
            break;
        }
    }
    if (doc.is_null())
        return {};
    const auto& rows = doc.at("Lights");
    if (!rows.is_array() || rows.size() > 100000)
        throw std::runtime_error("Invalid course light table");
    std::vector<LampGlint> result;
    for (const auto& row : rows) {
        const auto mask = row.value("SpriteRes", 0) & 0x70;
        if (mask != 16 && mask != 32 && mask != 64)
            continue;
        const auto vector = [&](const char* key) {
            const auto& v = row.at(key);
            if (!v.is_array() || v.size() != 3)
                throw std::runtime_error("Invalid course light vector");
            Vec3 p{v[0].get<double>(), v[1].get<double>(), v[2].get<double>()};
            if (!finite(p) || length(p) > 1e9)
                throw std::runtime_error("Invalid course light components");
            return p;
        };
        const auto colour = vector("Colour");
        if (std::min({colour.x, colour.y, colour.z}) < 0 || length(colour) < 1e-12)
            continue;
        const auto p = vector("Position");
        const auto brightness = row.value("UnknownFloat1", 1.);
        if (!std::isfinite(brightness) || brightness < 0 || brightness > 100)
            throw std::runtime_error("Invalid course light brightness");
        result.push_back({{p.x / 100, p.z / 100, -p.y / 100}, colour / length(colour), unsigned(mask), brightness});
    }
    return result;
}

std::vector<Vertex> lamp_glint_mesh(std::span<const LampGlint> lights, const std::array<float, 16>& clip, Vec3 eye,
                                    unsigned width, unsigned height, double range) {
    if (!finite(eye) || !width || !height || !std::isfinite(range) || range <= 0)
        throw std::invalid_argument("Invalid lamp glint view");
    for (const auto v : clip)
        if (!std::isfinite(v))
            throw std::invalid_argument("Invalid lamp projection");
    const auto forward = normalized(Vec3{clip[3], clip[7], clip[11]}, {0, 0, -1});
    const Vec3 row_x{clip[0], clip[4], clip[8]}, row_y{clip[1], clip[5], clip[9]};
    const auto right = normalized(project(row_x, forward), {1, 0, 0}),
               up = normalized(-project(row_y, forward), {0, 1, 0});
    const CelestialView view{clip};

    struct Visible {
        const LampGlint* light;
        double distance;
        std::array<double, 4> p;
    };

    std::vector<Visible> visible;
    for (const auto& light : lights) {
        const auto distance = length(light.position - eye);
        const auto p = project(view, light.position);
        if (distance >= range || distance < .05 || p[3] <= 1e-6 || p[2] < 0 || p[2] > p[3] || std::abs(p[0]) > p[3] ||
            std::abs(p[1]) > p[3])
            continue;
        visible.push_back({&light, distance, p});
    }
    std::stable_sort(visible.begin(), visible.end(),
                     [](const auto& a, const auto& b) { return a.distance < b.distance; });
    if (visible.size() > 10)
        visible.resize(10);
    std::vector<Vertex> result;
    const auto quad = [&](const LampGlint& light, Vec3 x, Vec3 y, double gain, double kind) {
        for (const auto uv : std::array<std::array<double, 2>, 6>{{{0, 0}, {1, 0}, {1, 1}, {0, 0}, {1, 1}, {0, 1}}}) {
            const auto p = light.position + x * (uv[0] * 2 - 1) + y * (1 - uv[1] * 2);
            Vertex v{float(p.x), float(p.y), float(p.z), float(light.hue.x), float(light.hue.y), float(light.hue.z)};
            v.s = float(uv[0]);
            v.t = float(uv[1]);
            v.ls = float(gain);
            v.lx = float(kind);
            result.push_back(v);
        }
    };
    for (const auto& lamp : visible) {
        const auto& light = *lamp.light;
        const auto nx = lamp.p[0] / lamp.p[3], ny = lamp.p[1] / lamp.p[3];
        const auto bloom = std::pow(std::max(0., 1 - std::hypot(nx, ny)), 4);
        const auto gain = light.brightness * (1 + bloom) * std::min(1., 2 * (1 - lamp.distance / range));
        const auto radius = (light.size == 64 ? 2.5 : light.size == 32 ? 1. : .5) * (1 + bloom);
        quad(light, right * radius * 2, up * radius * 2, gain * .25, 0);
        const auto angle = -pi * .5 * nx;
        const auto x = right * std::cos(angle) + up * std::sin(angle),
                   y = up * std::cos(angle) - right * std::sin(angle);
        quad(light, x * radius, y * radius * .15, gain, 1);
        quad(light, y * radius, x * radius * .15, gain, 1);
        const auto px = 2 * lamp.p[3] / (width * std::max(length(row_x), 1e-9));
        const auto py = 2 * lamp.p[3] / (height * std::max(length(row_y), 1e-9));
        quad(light, right * px * 8, up * py * 4, gain, 0);
    }
    return result;
}

Vec3 Glare::direction() const {
    const auto az = azimuth * pi / 180, el = elevation * pi / 180;
    // Raw +X azimuth, XY horizon and Z elevation, then (x,z,-y).
    return {std::cos(az) * std::cos(el), std::sin(el), -std::sin(az) * std::cos(el)};
}

CelestialMesh celestial_mesh(const Glare& glare, const CelestialView& view) {
    CelestialMesh result;
    for (const auto value :
         {glare.fan_intensity, glare.sprite_intensity, glare.azimuth, glare.elevation, glare.distance, glare.radius})
        if (!std::isfinite(value))
            throw std::invalid_argument("Invalid celestial settings");
    if (glare.fan_intensity < 0 || glare.fan_intensity > 10 || glare.sprite_intensity < 0 ||
        glare.sprite_intensity > 10 || glare.distance < 1 || glare.distance > 1e8 || glare.radius < 0 ||
        glare.radius > 1e8)
        throw std::invalid_argument("Celestial settings exceed bounds");
    for (const auto colour : {glare.core, glare.rim})
        for (const auto v : colour)
            if (!std::isfinite(v) || v < 0 || v > 1)
                throw std::invalid_argument("Invalid celestial colour");
    if (!std::isfinite(view.visibility) || view.visibility < 0 || view.visibility > 1 || !finite(view.anchor) ||
        !std::isfinite(view.far_distance) || view.far_distance <= 0)
        throw std::invalid_argument("Invalid celestial view");
    for (const auto v : view.clip)
        if (!std::isfinite(v))
            throw std::invalid_argument("Invalid celestial projection");
    if (!glare.enabled || view.visibility == 0)
        return result;
    const auto direction = glare.direction();
    const auto distance = std::min(glare.distance / 100, view.far_distance * .9);
    const auto centre = view.anchor + direction * distance;
    const auto sun = project(view, centre);
    if (sun[3] <= 1e-6)
        return result;
    const auto radius = distance * glare.radius / glare.distance;
    const auto& pattern = spokes();
    if (glare.fan_intensity > 0) {
        if (!view.stereo) {
            const Point origin{sun[0] / sun[3], -sun[1] / sun[3]};
            for (std::size_t i = 0; i < pattern.size(); ++i) {
                const auto a = pattern[i], b = pattern[(i + 1) % pattern.size()];
                auto polygon = clip_half_plane({{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}, origin,
                                               {std::cos(a.angle), std::sin(a.angle)}, 1);
                polygon = clip_half_plane(std::move(polygon), origin, {std::cos(b.angle), std::sin(b.angle)}, -1);
                const auto point = [&](Point p) {
                    const auto delta = p - origin;
                    const auto falloff = std::max(0., 1 - (delta.x * delta.x + delta.y * delta.y) / 3);
                    return vertex({p.x, -p.y, .5, 1}, glare.core,
                                  view.visibility * glare.fan_intensity * (128. / 255) * a.amplitude * falloff);
                };
                for (std::size_t j = 1; j + 1 < polygon.size(); ++j)
                    for (const auto p : {polygon[0], polygon[j], polygon[j + 1]})
                        result.fan.push_back(point(p));
            }
        } else {
            const auto right = normalized(cross(direction, {0, 1, 0}), {1, 0, 0}), up = cross(right, direction);
            const auto reach = distance * std::tan(40 * pi / 180);
            for (std::size_t i = 0; i < pattern.size(); ++i) {
                const auto a = pattern[i], b = pattern[(i + 1) % pattern.size()];
                const auto intensity = view.visibility * glare.fan_intensity * (128. / 255) * a.amplitude;
                result.fan.push_back(vertex(sun, glare.core, intensity));
                for (const auto angle : {a.angle, b.angle}) {
                    const auto p = centre + (right * std::cos(angle) + up * std::sin(angle)) * reach;
                    result.fan.push_back(vertex(project(view, p), glare.core, 0));
                }
            }
        }
    }
    if (glare.sprite_intensity > 0 && radius > 0) {
        const auto forward = normalized(Vec3{view.clip[3], view.clip[7], view.clip[11]}, {0, 0, -1});
        const auto row = Vec3{view.clip[0], view.clip[4], view.clip[8]};
        const auto right = normalized(row - forward * dot(row, forward), {1, 0, 0});
        const auto up = normalized(cross(right, forward), {0, 1, 0});
        for (const auto uv : {Point{0, 0}, Point{1, 0}, Point{1, 1}, Point{0, 0}, Point{1, 1}, Point{0, 1}}) {
            const auto p = centre + right * ((uv.x * 2 - 1) * radius) + up * ((1 - uv.y * 2) * radius);
            result.corona.push_back(vertex(project(view, p), glare.rim,
                                           view.visibility * glare.sprite_intensity * (255. / 128), uv.x, uv.y));
        }
    }
    return result;
}

void GlareVisibility::reset() {
    value_ = target_ = 0;
    until_sample_ = 0;
    initialized_ = false;
}

double GlareVisibility::step(const Terrain& terrain, const Glare& glare, Vec3 eye, double seconds) {
    if (!finite(eye) || !std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid celestial visibility tick");
    if (!glare.enabled) {
        reset();
        return 0;
    }
    until_sample_ -= seconds;
    if (until_sample_ <= 0) {
        const auto direction = glare.direction();
        const auto right = normalized(cross(direction, {0, 1, 0}), {1, 0, 0}), up = cross(right, direction);
        const auto spread = std::min(.02, glare.radius / glare.distance * .1);
        unsigned clear = 0;
        for (const auto axis : {Vec3{}, right * spread, right * -spread, up * spread, up * -spread}) {
            const auto ray = normalized(direction + axis);
            if (!terrain.intersect(eye + ray * .05, eye + ray * 10000))
                ++clear;
        }
        target_ = clear / 5.;
        until_sample_ = .1;
        if (!initialized_) {
            value_ = target_;
            initialized_ = true;
        }
    }
    value_ += (target_ - value_) * (1 - std::exp(-seconds * std::log(2.) / .12));
    return value_;
}
} // namespace openslope
