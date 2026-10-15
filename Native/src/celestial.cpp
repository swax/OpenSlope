#include "openslope/celestial.hpp"
#include "celestial_spokes.hpp"
#include <algorithm>
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
