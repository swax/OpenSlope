#include "openslope/rigid_prop.hpp"
#include <stdexcept>

namespace openslope {
namespace {
Vec3 direction(const Transform& m, Vec3 v) {
    return {m[0] * v.x + m[4] * v.y + m[8] * v.z, m[1] * v.x + m[5] * v.y + m[9] * v.z,
            m[2] * v.x + m[6] * v.y + m[10] * v.z};
}

Vec3 transpose(const Transform& m, Vec3 v) {
    return {m[0] * v.x + m[1] * v.y + m[2] * v.z, m[4] * v.x + m[5] * v.y + m[6] * v.z,
            m[8] * v.x + m[9] * v.y + m[10] * v.z};
}

Vec3 matrix(const std::array<double, 9>& m, Vec3 v) {
    return {m[0] * v.x + m[1] * v.y + m[2] * v.z, m[3] * v.x + m[4] * v.y + m[5] * v.z,
            m[6] * v.x + m[7] * v.y + m[8] * v.z};
}

Transform turn(const Transform& previous, Vec3 omega, double seconds) {
    auto result = previous;
    const auto speed = length(omega);
    if (speed > 1e-12) {
        const auto axis = omega / speed;
        for (unsigned column = 0; column < 3; ++column) {
            const auto v = rotate({previous[column * 4], previous[column * 4 + 1], previous[column * 4 + 2]}, axis,
                                  speed * seconds);
            result[column * 4] = v.x;
            result[column * 4 + 1] = v.y;
            result[column * 4 + 2] = v.z;
        }
        const auto x = normalized(Vec3{result[0], result[1], result[2]}),
                   y = normalized(project(Vec3{result[4], result[5], result[6]}, x)), z = cross(x, y);
        for (unsigned i = 0; i < 3; ++i) {
            const auto v = i == 0 ? x : i == 1 ? y : z;
            result[i * 4] = v.x;
            result[i * 4 + 1] = v.y;
            result[i * 4 + 2] = v.z;
        }
    }
    return result;
}

Vec3 limited(Vec3 v, double maximum) {
    const auto n = length(v);
    return n > maximum ? v * (maximum / n) : v;
}
} // namespace

RigidProp::RigidProp(PropBodyShape shape, double mass, Vec3 launch) : shape_(std::move(shape)) {
    if (!std::isfinite(mass) || mass <= 0 || mass > 1e9 || !finite(launch) || length(launch) > 1e6 ||
        shape_.probes.empty() || shape_.probes.size() > 32768 || !finite(shape_.centre))
        throw std::invalid_argument("Invalid live prop body");
    for (const auto value : shape_.placement)
        if (!std::isfinite(value))
            throw std::invalid_argument("Invalid body placement");
    inverse_mass_ = 1 / mass;
    origin_ = position_ = transform_point(shape_.placement, shape_.centre);
    double scale = 0;
    const std::array<Vec3, 3> axes{Vec3{shape_.placement[0], shape_.placement[1], shape_.placement[2]},
                                   Vec3{shape_.placement[4], shape_.placement[5], shape_.placement[6]},
                                   Vec3{shape_.placement[8], shape_.placement[9], shape_.placement[10]}};
    // Gershgorin bound on A^T A: conservative also for scaled/sheared placements.
    for (const auto a : axes) {
        double row = 0;
        for (const auto b : axes)
            row += std::abs(dot(a, b));
        scale = std::max(scale, row);
    }
    scale = std::sqrt(scale);
    Bounds box;
    for (const auto sphere : shape_.probes) {
        if (!finite(sphere.centre) || !std::isfinite(sphere.radius) || sphere.radius <= 0 || sphere.radius > 1e6)
            throw std::invalid_argument("Invalid body leaf sphere");
        const auto centre = transform_point(shape_.placement, sphere.centre) - origin_;
        const auto radius = sphere.radius * scale;
        offsets_.push_back({centre, radius});
        const Vec3 r{radius, radius, radius};
        box.add(centre - r);
        box.add(centre + r);
    }
    const auto component = [](Vec3 v, unsigned i) { return i == 0 ? v.x : i == 1 ? v.y : v.z; };
    for (unsigned r = 0; r < 3; ++r)
        for (unsigned c = 0; c < 3; ++c)
            for (unsigned a = 0; a < 3; ++a)
                for (unsigned b = 0; b < 3; ++b)
                    inertia_[r * 3 + c] += component(normalized(axes[a]), r) * shape_.inverse_inertia[a * 3 + b] *
                                           component(normalized(axes[b]), c);
    for (const auto v : inertia_)
        if (!std::isfinite(v))
            throw std::invalid_argument("Invalid inverse inertia");
    if (inertia_[0] <= 0 || inertia_[4] <= 0 || inertia_[8] <= 0) {
        const auto d = box.max - box.min;
        inertia_ = {12 * inverse_mass_ / std::max(1e-6, d.y * d.y + d.z * d.z), 0, 0, 0,
                    12 * inverse_mass_ / std::max(1e-6, d.x * d.x + d.z * d.z), 0, 0, 0,
                    12 * inverse_mass_ / std::max(1e-6, d.x * d.x + d.y * d.y)};
    }
    // The zero-vector Roller path launches along the authored instance up axis.
    // Its launch scales inversely with mass; an explicit vector uses a fixed speed.
    velocity_ =
        limited(length(launch) > 1e-9 ? normalized(launch) * 8 : normalized(axes[1]) * (8 * inverse_mass_), 300);
}

Vec3 RigidProp::inertia(Vec3 value) const {
    return direction(rotation_, matrix(inertia_, transpose(rotation_, value)));
}

Vec3 RigidProp::point_velocity(Vec3 point) const { return velocity_ + cross(angular_, point - position_); }

void RigidProp::impulse(Vec3 value, Vec3 point) {
    velocity_ = limited(velocity_ + value * inverse_mass_, 300);
    angular_ = limited(angular_ + inertia(cross(point - position_, value)), 50);
}

CollisionResponse RigidProp::shove(const WorldContact& contact, Vec3 rider_velocity, Vec3 rider_up) {
    if (!finite(rider_velocity) || !finite(contact.point) || !finite(contact.normal))
        throw std::invalid_argument("Invalid live-body contact");
    const auto normal = normalized(contact.normal), arm = contact.point - position_;
    CollisionResponse result{normal * (std::max(0., contact.depth) * .1), rider_velocity, 0, false};
    const auto closing = -dot(rider_velocity - point_velocity(contact.point), normal);
    if (closing <= 0)
        return result;
    const auto rotation = cross(arm, normal);
    constexpr double rider_inverse_mass = 1. / 75;
    const auto denominator = inverse_mass_ + rider_inverse_mass + std::max(0., dot(rotation, inertia(rotation)));
    const auto magnitude = 1.3 * closing / denominator;
    impulse(normal * (-magnitude), contact.point);
    result.impulse = magnitude * rider_inverse_mass;
    result.velocity += normal * result.impulse;
    result.hard = result.impulse > 19.44444 + 8.33333 * dot(normalized(rider_up), normal);
    activity_ = std::max(activity_, length(velocity_) + length(angular_));
    sleeping_ = false;
    return result;
}

std::vector<ProbeSphere> RigidProp::probes(Vec3 position, const Transform& rotation) const {
    std::vector<ProbeSphere> result;
    result.reserve(offsets_.size());
    for (const auto p : offsets_)
        result.push_back({position + direction(rotation, p.centre), p.radius});
    return result;
}

void RigidProp::resolve(const PropBodyContact& hit) {
    const auto normal = normalized(hit.normal), arm = hit.point - position_;
    const auto closing = -dot(point_velocity(hit.point) - hit.velocity, normal);
    if (closing <= 0)
        return;
    const auto rn = cross(arm, normal);
    const auto magnitude = 1.3 * closing / (inverse_mass_ + std::max(0., dot(rn, inertia(rn))));
    impulse(normal * magnitude, hit.point);
    const auto tangent = project(point_velocity(hit.point) - hit.velocity, normal);
    const auto speed = length(tangent);
    if (speed > 1e-9) {
        const auto t = tangent / speed, rt = cross(arm, t);
        const auto friction = std::min(.65 * magnitude, speed / (inverse_mass_ + std::max(0., dot(rt, inertia(rt)))));
        impulse(t * (-friction), hit.point);
    }
}

void RigidProp::substep(double seconds, const PropBodyQuery& query, bool& supported) {
    velocity_.y -= 9.8 * seconds;
    auto remaining = seconds;
    for (unsigned iteration = 0; iteration < 6 && remaining > 1e-8; ++iteration) {
        const auto next = position_ + velocity_ * remaining;
        const auto rotation = turn(rotation_, angular_, remaining);
        const auto from = probes(position_, rotation_), to = probes(next, rotation);
        auto contacts = query(from, to);
        for (auto& contact : contacts)
            if (contact.terrain_probe) {
                const auto probe = *contact.terrain_probe;
                if (probe >= from.size())
                    throw std::invalid_argument("Invalid terrain contact probe");
                if (contact.t <= 1e-8 && dot(position_ - contact.point, contact.normal) < -1e-8) {
                    // An embedded leaf can lie across a thin sheet from its
                    // body's centre. Clear it toward the body's side, retaining
                    // the full signed depth rather than dropping the contact.
                    contact.normal = -contact.normal;
                    contact.depth = 2 * std::max(from[probe].radius, to[probe].radius) - contact.depth;
                }
            }
        if (contacts.empty()) {
            position_ = next;
            rotation_ = rotation;
            break;
        }
        double t = 1;
        for (const auto& contact : contacts)
            t = std::min(t, std::clamp(contact.t, 0., 1.));
        position_ += (next - position_) * t;
        rotation_ = turn(rotation_, angular_, remaining * t);
        std::vector<PropBodyContact> manifold;
        std::vector<std::pair<Vec3, double>> planes;
        for (const auto& contact : contacts)
            if (contact.t <= t + 1e-6) {
                manifold.push_back(contact);
                supported |= contact.normal.y > .1;
                const auto normal = normalized(contact.normal);
                bool merged = false;
                for (auto& plane : planes)
                    if (dot(plane.first, normal) > .995) {
                        plane.second = std::max(plane.second, contact.depth);
                        merged = true;
                        break;
                    }
                if (!merged)
                    planes.push_back({normal, contact.depth});
            }
        for (const auto& plane : planes)
            position_ += plane.first * (std::max(0., plane.second) + .001);
        // Simultaneous support points must be solved together. A single deepest
        // leaf repeatedly reporting t=0 can otherwise freeze a compound body.
        for (unsigned pass = 0; pass < 12; ++pass)
            for (const auto& contact : manifold)
                resolve(contact);
        remaining *= 1 - t;
    }
}

void RigidProp::step(double seconds, const PropBodyQuery& query) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1 || !query)
        throw std::invalid_argument("Invalid dynamic prop tick");
    if (sleeping_)
        return;
    pending_ += seconds;
    while (pending_ >= 1. / 60 - 1e-9) {
        pending_ = std::max(0., pending_ - 1. / 60);
        const auto subdivisions = std::clamp(unsigned(std::ceil(length(angular_) / (60 * (pi / 36)))), 2u, 8u);
        bool supported = false;
        for (unsigned i = 0; i < subdivisions; ++i)
            substep(1. / (60 * subdivisions), query, supported);
        angular_ *= std::exp(-.25 / 60);
        if (supported) {
            const auto resistance = std::exp(-2.5 / 60);
            velocity_ *= resistance;
            angular_ *= resistance;
        }
        activity_ *= .95;
        if (supported && length(velocity_) < .14 && length(angular_) < .18 && activity_ < .025) {
            velocity_ = angular_ = {};
            sleeping_ = true;
            break;
        }
    }
}

Transform RigidProp::pose() const {
    auto delta = rotation_;
    const auto translation = position_ - direction(rotation_, origin_);
    delta[12] = translation.x;
    delta[13] = translation.y;
    delta[14] = translation.z;
    return multiply(delta, shape_.placement);
}
} // namespace openslope
