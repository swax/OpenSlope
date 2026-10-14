#pragma once
#include "openslope/player.hpp"
#include <functional>

namespace openslope {
struct XrPlatform {
    void* java_vm{};
    void* activity{};
    std::function<bool()> process_events;
    double render_scale=1.0;
    unsigned msaa=4;
    bool head_steering=false;
};
int run_openxr(Player& player,const XrPlatform& platform={},double seconds=0);
}
