#pragma once
#include "openslope/import.hpp"
#include <nlohmann/json.hpp>

namespace openslope::import_detail {
inline nlohmann::json course_metadata(const DiscCourse& course) {
    nlohmann::json result{{"Course", course.name}, {"MapType", course.map_type}};
    if (!course.display_name.empty()) {
        result["DisplayName"] = course.display_name;
        result["NameSource"] = course.name_source;
    }
    if (!course.world_id.empty())
        result["WorldId"] = course.world_id;
    if (!course.parent_map.empty())
        result["ParentMap"] = course.parent_map;
    if (!course.source_sections.empty())
        result["SourceSections"] = course.source_sections;
    if (!course.connects.empty())
        result["Connects"] = course.connects;
    return result;
}
} // namespace openslope::import_detail
