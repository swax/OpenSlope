#pragma once
#include <string_view>

namespace openslope {
enum class LightingMode { Original, Enhanced, Runtime };

constexpr std::string_view lighting_name(LightingMode mode) {
    switch (mode) {
    case LightingMode::Enhanced: return "enhanced";
    case LightingMode::Runtime: return "runtime";
    default: return "original";
    }
}
} // namespace openslope
