#pragma once
#include "player.hpp"
#include <functional>

namespace openslope {
// Authored input sequences make actual desktop rendering reproducible without
// a keyboard automation hook, headset or bundled course assets.
struct ReplayStep {unsigned ticks{};RideInput input;};
struct Replay {
    std::vector<ReplayStep> steps;
    bool placement=false;
    Vec3 position,forward{0,0,-1},velocity,up{0,1,0};
    static Replay load(const std::filesystem::path& path);
    void run(Player& player,const std::function<void()>& after_tick={}) const;
};
}
