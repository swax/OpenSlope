#include "openslope/collision.hpp"
#include <stdexcept>

namespace openslope {
namespace {
double component(Vec3 p, unsigned axis) { return axis == 0 ? p.x : axis == 1 ? p.y : p.z; }

std::optional<double> root(double a, double b, double c) {
    if (std::abs(a) < 1e-18) {
        if (std::abs(b) < 1e-18)
            return {};
        const auto t = -c / b;
        return t >= 0 && t <= 1 ? std::optional(t) : std::nullopt;
    }
    auto disc = b * b - 4 * a * c;
    if (disc < 0)
        return {};
    disc = std::sqrt(disc);
    const auto first = (-b - disc) / (2 * a), second = (-b + disc) / (2 * a);
    if (first >= 0 && first <= 1)
        return first;
    if (second >= 0 && second <= 1)
        return second;
    return {};
}

bool in_triangle(Vec3 point, Vec3 a, Vec3 b, Vec3 c) {
    const auto u = b - a, v = c - a, p = point - a;
    const auto uu = dot(u, u), uv = dot(u, v), vv = dot(v, v), pu = dot(p, u), pv = dot(p, v), det = uu * vv - uv * uv;
    if (det < 1e-18)
        return false;
    const auto x = (pu * vv - pv * uv) / det, y = (pv * uu - pu * uv) / det;
    return x >= -1e-9 && y >= -1e-9 && x + y <= 1 + 1e-9;
}

Vec3 closest_segment(Vec3 p, Vec3 a, Vec3 b) {
    const auto e = b - a;
    return a + e * std::clamp(dot(p - a, e) / std::max(dot(e, e), 1e-18), 0.0, 1.0);
}
} // namespace

std::optional<ShapeContact> swept_box(const Bounds& box, const Transform& world, ProbeSphere start, ProbeSphere end) {
    const auto inverse = inverse_transform(world);
    const auto a = transform_point(inverse, start.centre), b = transform_point(inverse, end.centre);
    const auto delta = b - a;
    const auto radius = std::max(start.radius, end.radius);
    const auto at = [&](double t) -> std::optional<ShapeContact> {
        const auto p = a + delta * t;
        std::optional<ShapeContact> best;
        for (unsigned axis = 0; axis < 3; ++axis) {
            const Vec3 row{inverse[axis], inverse[4 + axis], inverse[8 + axis]};
            const auto factor = length(row), local_radius = radius * factor;
            if (component(p, axis) < component(box.min, axis) - local_radius - 1e-9 ||
                component(p, axis) > component(box.max, axis) + local_radius + 1e-9)
                return {};
        }
        for (unsigned axis = 0; axis < 3; ++axis) {
            bool admitted = true;
            for (unsigned other = 0; other < 3; ++other)
                if (other != axis)
                    admitted &= component(p, other) >= component(box.min, other) - 1e-9 &&
                                component(p, other) <= component(box.max, other) + 1e-9;
            if (!admitted)
                continue;
            for (const auto sign : {-1., 1.}) {
                const auto plane = component(sign < 0 ? box.min : box.max, axis);
                const Vec3 row{inverse[axis], inverse[4 + axis], inverse[8 + axis]};
                const auto distance = sign * (component(p, axis) - plane) / length(row), depth = radius - distance;
                if (depth < -1e-8)
                    continue;
                const auto normal = normalized(row * sign);
                const auto centre = start.centre + (end.centre - start.centre) * t;
                ShapeContact hit{centre - normal * distance, normal, t, std::max(0.0, depth)};
                if (!best || depth < best->depth)
                    best = hit;
            }
        }
        return best;
    };
    if (const auto hit = at(0))
        return hit;
    std::optional<ShapeContact> best;
    // [Trailmap: 370-sphere-box] Sweep the union of six face prisms. Only
    // the face-normal axis grows; perpendicular slabs keep square edges.
    for (unsigned face = 0; face < 3; ++face) {
        double lo = 0, hi = 1;
        const Vec3 row{inverse[face], inverse[4 + face], inverse[8 + face]};
        const auto padding = radius * length(row);
        bool valid = true;
        for (unsigned axis = 0; axis < 3; ++axis) {
            const auto low = component(box.min, axis) - (axis == face ? padding : 0),
                       high = component(box.max, axis) + (axis == face ? padding : 0), value = component(a, axis),
                       speed = component(delta, axis);
            if (std::abs(speed) < 1e-15) {
                if (value < low || value > high) {
                    valid = false;
                    break;
                }
            } else {
                auto first = (low - value) / speed, last = (high - value) / speed;
                if (first > last)
                    std::swap(first, last);
                lo = std::max(lo, first);
                hi = std::min(hi, last);
                if (lo > hi) {
                    valid = false;
                    break;
                }
            }
        }
        if (valid)
            if (const auto hit = at(lo); hit && (!best || hit->t < best->t))
                best = hit;
    }
    return best;
}

std::optional<ShapeContact> swept_triangle(Vec3 a, Vec3 b, Vec3 c, ProbeSphere start, ProbeSphere end) {
    const auto delta = end.centre - start.centre, geometric = cross(b - a, c - a);
    if (length(geometric) < 1e-12)
        return {};
    const auto normal = normalized(geometric);
    const auto radius = std::max(start.radius, end.radius);
    std::optional<ShapeContact> best;
    const auto accept = [&](double t, Vec3 point, Vec3 n, double depth = 0) {
        if (t < 0 || t > 1)
            return;
        if (!best || t < best->t || (t == best->t && depth > best->depth))
            best = ShapeContact{point, normalized(n, -normalized(delta)), t, depth};
    };
    const auto plane = dot(start.centre - a, normal), speed = dot(delta, normal);
    const auto finish = plane + speed;
    // Every triangle feature lies in this plane. Reject a swept sphere that
    // never reaches its radius-wide slab before testing the edges and vertices.
    if (std::min(plane, finish) > radius || std::max(plane, finish) < -radius)
        return {};
    const auto projection = start.centre - normal * plane;
    if (std::abs(plane) <= radius && in_triangle(projection, a, b, c)) {
        accept(0, projection, normal * (plane < 0 ? -1. : 1.), radius - std::abs(plane));
        return best;
    }
    if (std::abs(plane) > radius && std::abs(speed) > 1e-15) {
        // Reaching the infinite face is a lower bound for every feature. An
        // entry point inside the triangle therefore already is the first hit.
        const auto sign = plane < 0 ? -1. : 1.;
        const auto t = (sign * radius - plane) / speed;
        const auto point = start.centre + delta * t - normal * (sign * radius);
        if (t >= 0 && t <= 1 && in_triangle(point, a, b, c)) {
            accept(t, point, normal * sign);
            return best;
        }
    }
    for (const auto& edge : std::array<std::array<Vec3, 2>, 3>{{{a, b}, {b, c}, {c, a}}}) {
        const auto nearest = closest_segment(start.centre, edge[0], edge[1]), offset = start.centre - nearest;
        if (length(offset) <= radius)
            accept(0, nearest, offset, radius - length(offset));
        const auto e = edge[1] - edge[0], origin = start.centre - edge[0];
        const auto ee = dot(e, e);
        if (ee > 1e-18) {
            const auto p = origin - e * (dot(origin, e) / ee), d = delta - e * (dot(delta, e) / ee);
            if (const auto t = root(dot(d, d), 2 * dot(p, d), dot(p, p) - radius * radius)) {
                const auto centre = start.centre + delta * (*t);
                const auto u = dot(centre - edge[0], e) / ee;
                if (u >= 0 && u <= 1)
                    accept(*t, edge[0] + e * u, centre - (edge[0] + e * u));
            }
        }
        for (const auto vertex : edge) {
            const auto v = start.centre - vertex;
            if (const auto t = root(dot(delta, delta), 2 * dot(v, delta), dot(v, v) - radius * radius))
                accept(*t, vertex, start.centre + delta * (*t) - vertex);
        }
    }
    if (std::abs(speed) > 1e-15)
        for (const auto sign : {-1., 1.}) {
            const auto t = (sign * radius - plane) / speed;
            const auto point = start.centre + delta * t - normal * (sign * radius);
            if (in_triangle(point, a, b, c))
                accept(t, point, normal * sign);
        }
    return best;
}

std::vector<std::uint8_t> occupancy_masks(std::span<const std::uint8_t> input, unsigned encoding, unsigned depth) {
    if (!depth || depth > 7 || encoding > 1)
        throw std::runtime_error("Invalid occupancy depth or encoding");
    std::size_t expected = 0, level = 1;
    for (unsigned i = 0; i < depth; ++i) {
        expected += level;
        level *= 8;
    }
    if (encoding == 0) {
        if (input.size() != expected)
            throw std::runtime_error("Raw occupancy masks have the wrong size");
        return {input.begin(), input.end()};
    }
    std::vector<std::uint8_t> output;
    output.reserve(expected);
    std::size_t p = 0;
    bool stopped = false;
    while (p < input.size()) {
        const auto control = static_cast<std::int8_t>(input[p++]);
        if (control == 0) {
            stopped = true;
            break;
        }
        const auto count = control < 0 ? std::size_t(-int(control)) : std::size_t(control) + 1;
        if (output.size() + count > expected)
            throw std::runtime_error("Occupancy RLE exceeds its decoded size");
        if (control < 0) {
            if (count > input.size() - p)
                throw std::runtime_error("Truncated occupancy literal");
            output.insert(output.end(), input.begin() + p, input.begin() + p + count);
            p += count;
        } else {
            if (p >= input.size())
                throw std::runtime_error("Truncated occupancy repeat");
            output.insert(output.end(), count, input[p++]);
        }
    }
    if (!stopped || output.size() != expected)
        throw std::runtime_error("Incomplete occupancy masks");
    return output;
}

CollisionResponse collision_response(const WorldContact& c, Vec3 velocity, Vec3 board_up) {
    CollisionResponse result{{}, velocity, 0, false};
    if (!c.response)
        return result;
    const auto normal = normalized(c.normal);
    result.position_delta = normal * (std::max(0.0, c.depth) * .1);
    const auto closing = -dot(velocity - c.surface_velocity, normal);
    if (closing <= 0)
        return result;
    if (c.surface >= 0) {
        result.velocity += normal * closing;
        result.impulse = closing;
        return result;
    }
    // [Trailmap: 130-contact-state, 370-depenetrate, 370-bounce] Exactly
    // zero response mass and flag-off contact are handled before this helper.
    result.impulse = std::max(closing * (1 + c.bounce), closing + .55556);
    result.velocity += normal * result.impulse;
    result.hard = result.impulse > 19.44444 + 8.33333 * dot(normalized(board_up), normal);
    return result;
}
} // namespace openslope
