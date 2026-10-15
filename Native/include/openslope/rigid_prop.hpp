#pragma once
#include "collision.hpp"
#include <functional>

namespace openslope {
struct PropBodyContact : ShapeContact {
    Vec3 velocity;
};

using PropBodyQuery =
    std::function<std::vector<PropBodyContact>(std::span<const ProbeSphere>, std::span<const ProbeSphere>)>;

// Clean 130/230/370 supply the body and normal impulse contract. Launch magnitude,
// friction, damping, sleep thresholds and the rider's 75 kg are application tuning.
class RigidProp {
public:
    RigidProp(PropBodyShape shape, double mass, Vec3 launch);
    void step(double seconds, const PropBodyQuery& query);
    CollisionResponse shove(const WorldContact& contact, Vec3 rider_velocity, Vec3 rider_up);
    Transform pose() const;

    Vec3 centre() const { return position_; }

    Vec3 velocity() const { return velocity_; }

    Vec3 angular_velocity() const { return angular_; }

    Vec3 point_velocity(Vec3 point) const;

    bool sleeping() const { return sleeping_; }

private:
    PropBodyShape shape_;
    std::vector<ProbeSphere> offsets_;
    std::array<double, 9> inertia_{};
    Transform rotation_ = identity_transform();
    Vec3 origin_, position_, velocity_, angular_;
    double inverse_mass_ = 0, pending_ = 0, activity_ = 1;
    bool sleeping_ = false;
    Vec3 inertia(Vec3 value) const;
    void impulse(Vec3 value, Vec3 point);
    void resolve(const PropBodyContact& hit);
    std::vector<ProbeSphere> probes(Vec3 position, const Transform& rotation) const;
    void substep(double seconds, const PropBodyQuery& query, bool& supported);
};
} // namespace openslope
