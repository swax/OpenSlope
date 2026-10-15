#include "openslope/boost_trail.hpp"
#include <stdexcept>

namespace openslope {
BoostTrail::Pose BoostTrail::capture(BoostTrailPose pose) {
    if (!finite(pose.position) || !finite(pose.forward) || !finite(pose.up) || length(pose.forward) < 1e-9 ||
        length(cross(pose.forward, pose.up)) < 1e-9)
        throw std::invalid_argument("Invalid boost trail pose");
    const auto forward = normalized(pose.forward), up = normalized(project(pose.up, forward)),
               right = normalized(cross(forward, up));
    // First-party edge bands around the diagnostic deck; source attachment
    // points and the exact age ramp remain unresolved in clean boost-trail.
    const auto tail = pose.position - forward * .8 + up * .015;
    return {tail - right * .22, tail - right * .14, tail + right * .14, tail + right * .22};
}

void BoostTrail::reset() {
    history_ = {};
    head_ = count_ = 0;
    colour_ = {};
    frame_.reset();
}

void BoostTrail::step(std::uint64_t frame, BoostTrailPose pose, double held, double meter, bool speed_pad) {
    if (!std::isfinite(held) || held < 0 || held > 1 || !std::isfinite(meter) || meter < 0 || meter > 1)
        throw std::invalid_argument("Invalid boost trail energy");
    const auto points = capture(pose);
    if (frame_ && frame < *frame_)
        throw std::invalid_argument("Boost trail frame moved backwards");
    if (frame_ && frame == *frame_)
        return;
    frame_ = frame;
    if (frame % 3)
        return;
    if (held > 0 || speed_pad) {
        colour_ = speed_pad || meter > .66648 ? std::array<double, 3>{1, .0758, .002}
                  : meter > .33363            ? std::array<double, 3>{1, .4746, 0}
                                              : std::array<double, 3>{1, .9645, 0};
        history_[head_] = points;
        head_ = (head_ + 1) % 7;
        count_ = std::min(count_ + 1, 7u);
    } else if (count_)
        --count_;
}

BoostTrailMesh BoostTrail::draw(BoostTrailPose live) const {
    BoostTrailMesh result;
    if (count_ < 2)
        return result;
    auto previous = capture(live);
    const auto vertex = [&](Vec3 point, unsigned age) {
        const auto gain = 1 - double(age) / count_;
        return BoostTrailVertex{point,
                                {float(colour_[0] * gain), float(colour_[1] * gain), float(colour_[2] * gain), 1}};
    };
    for (unsigned age = 1; age <= count_; ++age) {
        const auto& next = history_[(head_ + 7 - age) % 7];
        for (unsigned edge = 0; edge < 2; ++edge) {
            const auto a = vertex(previous[edge * 2], age - 1), b = vertex(previous[edge * 2 + 1], age - 1),
                       c = vertex(next[edge * 2 + 1], age), d = vertex(next[edge * 2], age);
            for (const auto point : {a, b, c, a, c, d})
                result.points[result.count++] = point;
        }
        previous = next;
    }
    return result;
}
} // namespace openslope
