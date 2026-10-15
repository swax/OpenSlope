#pragma once
#include "import.hpp"
#include <map>
#include <optional>

namespace openslope {
struct SoundRoute {
    unsigned group{}, slot{};
    bool operator==(const SoundRoute&) const = default;
};

struct CollisionRoutes {
    std::string executable;
    std::map<unsigned, SoundRoute> events;
};

// Unsupported dispatchers stay unresolved; malformed/ambiguous inputs throw.
std::optional<std::map<unsigned, SoundRoute>> executable_collision_routes(std::span<const std::uint8_t> source,
                                                                          const ImportCancel& cancelled = {});
std::optional<CollisionRoutes> disc_collision_routes(const DiscInput& disc, const ImportCancel& cancelled = {});
} // namespace openslope
