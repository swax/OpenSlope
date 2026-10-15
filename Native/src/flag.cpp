#include "openslope/flag.hpp"
#include <stdexcept>

namespace openslope {
namespace {
void validate(const FlagWave& wave) {
    if (!std::isfinite(wave.amplitude) || std::abs(wave.amplitude) > 1e9 || !std::isfinite(wave.phase) ||
        wave.phase < 0 || wave.phase >= 1)
        throw std::invalid_argument("Invalid flag wave");
}
} // namespace

FlagPlayback::FlagPlayback(FlagLaw law, double initial_phase) : law_(law), phase_(initial_phase) {
    validate(wave());
    if (!std::isfinite(law.speed) || std::abs(law.speed) > 1e9 || !std::isfinite(law.lifetime) ||
        std::abs(law.lifetime) > 1e9)
        throw std::invalid_argument("Invalid flag clock");
}

void FlagPlayback::step(double seconds) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid flag step");
    if (expired_)
        return;
    const auto elapsed = law_.lifetime > 0 ? std::min(seconds, std::max(0., law_.lifetime - age_)) : seconds;
    age_ += elapsed;
    phase_ = std::fmod(phase_ + law_.speed * elapsed, 1.);
    if (phase_ < 0)
        phase_ += 1;
    if (law_.lifetime > 0 && age_ >= law_.lifetime - 1e-9)
        expired_ = true;
}

double flag_displacement(double station, const FlagWave& wave) {
    validate(wave);
    if (!std::isfinite(station) || station < 0 || station > 1)
        throw std::invalid_argument("Invalid flag station");
    const auto k = wave.opposite ? 1 - station : station;
    return wave.amplitude * k * std::sin(2 * pi * (k - wave.phase));
}

PropPose flag_pose(PropPose pose, const FlagWave& wave) {
    validate(wave);
    const auto scale = length(Vec3{pose.matrix[0], pose.matrix[1], pose.matrix[2]});
    if (!std::isfinite(scale) || scale < 1e-9)
        throw std::invalid_argument("Singular flag X scale");
    pose.uv[2] = float(wave.amplitude / (100 * scale));
    pose.uv[3] = float(wave.phase + (wave.opposite ? 2 : 0));
    return pose;
}

Bounds flag_bounds(const Bounds& local, const PropPose& pose) {
    auto box = local;
    box.min.x -= std::abs(pose.uv[2]);
    box.max.x += std::abs(pose.uv[2]);
    Transform world;
    for (unsigned i = 0; i < 16; ++i)
        world[i] = pose.matrix[i];
    Bounds result;
    for (unsigned c = 0; c < 8; ++c)
        result.add(transform_point(
            world, {c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z}));
    return result;
}
} // namespace openslope
