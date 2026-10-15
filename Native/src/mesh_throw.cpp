#include "openslope/mesh_throw.hpp"
#include <algorithm>
#include <random>
#include <stdexcept>

namespace openslope {
MeshThrow::MeshThrow(MeshThrowLaw law, std::span<const Vec3> centres, Vec3 contact_direction, std::uint32_t seed)
    : law_(law) {
    const auto bounded = [](Vec3 p) { return finite(p) && length(p) <= 1e6; };
    if (!std::isfinite(law.step) || law.step < 0 || law.step > 60 || !std::isfinite(law.duration) || law.duration < 0 ||
        law.duration > 3600 || !std::isfinite(law.multiplier) || std::abs(law.multiplier) > 1e4 ||
        !bounded(law.direction) || !bounded(law.speed) || !bounded(contact_direction) || !bounded(law.gravity) ||
        centres.size() > 256)
        throw std::invalid_argument("Invalid mesh throw law");
    auto direction = law.direction;
    if (length(direction) < 1e-9)
        direction = normalized(contact_direction, {0, 0, -1});
    const Vec3 velocity{direction.x * law.speed.x * law.multiplier, direction.y * law.speed.y * law.multiplier,
                        direction.z * law.speed.z * law.multiplier};
    Vec3 middle;
    for (const auto centre : centres) {
        if (!bounded(centre))
            throw std::invalid_argument("Invalid mesh throw centre");
        middle += centre;
    }
    if (!centres.empty())
        middle = middle / double(centres.size());
    std::mt19937 random(seed);
    const auto unit = [&] { return 2 * std::generate_canonical<double, 32>(random) - 1; };
    for (const auto centre : centres) {
        const auto axis = normalized(Vec3{unit(), unit(), unit()}, {0, 1, 0});
        auto spread = centres.size() > 1 ? normalized(centre - middle, axis) : Vec3{};
        spread = {spread.x * std::abs(law.speed.x) * .35, spread.y * std::abs(law.speed.y) * .35,
                  spread.z * std::abs(law.speed.z) * .35};
        pieces_.push_back({centre, velocity + spread, axis, unit() * 5});
    }
}

void MeshThrow::step(double seconds) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid mesh throw tick");
    age_ = std::min(law_.duration, age_ + seconds);
}

std::vector<Transform> MeshThrow::pose() const {
    const auto t = law_.step > 1e-9 ? std::floor((age_ + 1e-9) / law_.step) * law_.step : age_;
    std::vector<Transform> result;
    for (const auto& piece : pieces_) {
        const auto half = piece.spin * t * .5, s = std::sin(half);
        auto rotation =
            placement({}, {piece.axis.x * s, piece.axis.y * s, piece.axis.z * s, std::cos(half)}, {1, 1, 1});
        const auto offset =
            piece.velocity * t + law_.gravity * (.5 * t * t) + piece.centre - transform_point(rotation, piece.centre);
        rotation[12] = offset.x;
        rotation[13] = offset.y;
        rotation[14] = offset.z;
        result.push_back(rotation);
    }
    return result;
}
} // namespace openslope
