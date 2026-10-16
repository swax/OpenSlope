#pragma once
#include "import.hpp"

namespace openslope {
// Empty means an unsupported/missing settings source or an unknown course slot.
std::string executable_world_profile(std::span<const std::uint8_t> executable, const std::string& course,
                                     const ImportCancel& cancelled = {});
std::string disc_world_profile(const DiscInput& disc, const std::string& course, const ImportCancel& cancelled = {});
// Inspection of the independently initialized shared functional surface table.
std::string executable_surface_spray_profile(std::span<const std::uint8_t> executable,
                                             const ImportCancel& cancelled = {});
std::string disc_surface_spray_profile(const DiscInput& disc, const ImportCancel& cancelled = {});
} // namespace openslope
