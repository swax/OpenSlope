#pragma once
#include "openslope/player.hpp"
#include <functional>

namespace openslope {
enum class XrExitDestination { System, App, Maps };

struct XrPlatform {
    void* java_vm{};
    void* activity{};
    std::function<bool()> process_events;
    double render_scale = 1.0;
    unsigned msaa = 4;
    bool head_steering = false;
    std::function<bool()> is_resumed{};
    std::function<XrExitDestination()> exit_request{};
    std::function<void(XrExitDestination)> on_exit{};
    std::filesystem::path audio_preferences;
    std::string course_id;
};

int run_openxr(Player& player, const XrPlatform& platform = {}, double seconds = 0);
} // namespace openslope
