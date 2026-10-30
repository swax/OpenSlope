#pragma once
#include <string>
#include <string_view>

namespace openslope {
// Presentation only: imports, folders and saved preferences keep the original ID.
// Unknown IDs and custom map names are returned unchanged.
std::string course_display_name(std::string_view id);
} // namespace openslope
