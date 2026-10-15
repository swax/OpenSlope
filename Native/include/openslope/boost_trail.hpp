#pragma once
#include "math.hpp"
#include <array>
#include <cstdint>
#include <optional>
#include <span>

namespace openslope {
struct BoostTrailPose {Vec3 position,forward{0,0,-1},up{0,1,0};};
struct BoostTrailVertex {Vec3 position;std::array<float,4> colour{};};
struct BoostTrailMesh {
    std::array<BoostTrailVertex,84> points{};std::size_t count=0;
    std::span<const BoostTrailVertex> vertices() const {return std::span(points).first(count);}
};
class BoostTrail {
public:
    void reset();
    void step(std::uint64_t frame,BoostTrailPose pose,double held,double meter,bool speed_pad);
    BoostTrailMesh draw(BoostTrailPose live) const;
    unsigned records() const {return count_;}
    std::array<double,3> colour() const {return colour_;}
private:
    using Pose=std::array<Vec3,4>;
    std::array<Pose,7> history_{};unsigned head_=0,count_=0;
    std::array<double,3> colour_{};std::optional<std::uint64_t> frame_;
    static Pose capture(BoostTrailPose pose);
};
}
