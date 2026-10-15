#pragma once
#include "props.hpp"

namespace openslope {
struct FlagLaw {
    bool opposite = false;
    double speed = 0, amplitude = 0, lifetime = 0;
};

struct FlagWave {
    bool opposite = false;
    double amplitude = 0, phase = 0;
};

class FlagPlayback {
public:
    FlagPlayback(FlagLaw law, double initial_phase);
    void step(double seconds);

    FlagWave wave() const { return {law_.opposite, law_.amplitude, phase_}; }

    bool expired() const { return expired_; }

private:
    FlagLaw law_;
    double phase_ = 0, age_ = 0;
    bool expired_ = false;
};

// [Trailmap: 230-flag] Station zero is the first sampled edge, not a world axis.
double flag_displacement(double station, const FlagWave& wave);
PropPose flag_pose(PropPose pose, const FlagWave& wave);
Bounds flag_bounds(const Bounds& local, const PropPose& pose);
} // namespace openslope
