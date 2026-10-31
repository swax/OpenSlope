#pragma once
#include "import/shared.hpp"
#include <map>

namespace openslope::import_detail {
std::map<std::uint32_t, std::string> localized_titles(std::span<const std::uint8_t> data);
std::uint32_t locale_key(std::string_view key);
void ontour_titles(const DiscInput& disc, std::vector<DiscCourse>& courses, const ImportCancel& cancel);
} // namespace openslope::import_detail
