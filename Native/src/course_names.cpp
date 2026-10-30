#include "openslope/course_names.hpp"
#include <array>

namespace openslope {
std::string course_display_name(std::string_view id) {
    struct CourseName {
        std::string_view id, title;
    };

    // USA menu titles, matching Slopesmith's disc-courses catalogue. [Trailmap: 600-course-names]
    static constexpr std::array names{
        CourseName{"AVALANCHE_CRS00_00", "Half-Pipe"},        CourseName{"AVALANCHE_CRS00_03", "Sid's Night Midi"},
        CourseName{"AVALANCHE_CRS01_00", "Tenderfoot Pass"},  CourseName{"AVALANCHE_CRS01_01", "Powder Threat"},
        CourseName{"AVALANCHE_CRS01_02", "Revolution Cliff"}, CourseName{"AVALANCHE_CRS01_03", "Evolution Riff"},
        CourseName{"AVALANCHE_CRS02_00", "Spinal Damage"},    CourseName{"AVALANCHE_CRS02_01", "Ballistic"},
        CourseName{"AVALANCHE_CRS02_02", "No Way Out"},       CourseName{"AVALANCHE_CRS02_03", "Outway Knoll"},
        CourseName{"AVALANCHE_CRS03_00", "Frosty Shadows"},   CourseName{"AVALANCHE_CRS03_01", "Tree Top Trauma"},
        CourseName{"AVALANCHE_CRS03_02", "Midnight City"},    CourseName{"AVALANCHE_CRS03_03", "Top Tree Mama"},
        CourseName{"AVALANCHE_CRS04_00", "Ski School"},       CourseName{"AVALANCHE_CRS04_01", "Grits n' Gravy"},
        CourseName{"AVALANCHE_CRS04_02", "Rotted Ridge"},     CourseName{"AVALANCHE_CRS04_03", "Dazzlin' Teaser"},
        CourseName{"AVALANCHE_CRS05_00", "Air-Make"},         CourseName{"AVALANCHE_CRS05_01", "Trestle Trouble"},
        CourseName{"AVALANCHE_CRS05_02", "Diesel Disaster"},  CourseName{"AVALANCHE_CRS05_03", "Treble Tussle"},
        CourseName{"AVALANCHE_CRS06_00", "Terrain Park"},     CourseName{"AVALANCHE_CRS06_02", "Sick With It"},
        CourseName{"AVALANCHE_CRS06_03", "Wit's Thicket"},
    };
    for (const auto& name : names)
        if (id == name.id)
            return std::string(name.title);
    return std::string(id);
}
} // namespace openslope
