#pragma once
#include "avatar.hpp"

namespace openslope {
class RideUi;
struct UiResult;

class AvatarPreferences {
public:
    std::string selected = "builtin:stick-figure";
    static std::filesystem::path default_path();
    static AvatarPreferences load(const std::filesystem::path& file,
                                  std::string_view fallback = "builtin:stick-figure");
    static std::string random_rider();
    bool save(const std::filesystem::path& file) const;
    // The library is a characters/ folder beside the preferences file.
    void present(RideUi& ui, const std::filesystem::path& file) const;
    bool apply(Avatar& avatar, const RideUi& ui) const;
    bool handle(const UiResult& result, RideUi& ui, Avatar& avatar);
};
} // namespace openslope
