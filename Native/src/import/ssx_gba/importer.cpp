#include "importer.hpp"
#include "assets.hpp"
#include <algorithm>

namespace openslope::import_detail {
namespace {
bool accepts(const DiscInput& source) {
    if (source.size < 0xc0)
        return false;
    const auto code = source.read(0xac, 4);
    return Bytes{code}.text(0, 4) == "AXYE";
}

std::vector<DiscCourse> courses(const DiscInput& source, const ImportCancel& cancel) {
    const gba::Rom rom{source, cancel};
    std::vector<DiscCourse> result;
    for (const auto& c : rom.courses) {
        DiscCourse row{c.id, rom.resources[c.geometry].size};
        row.display_name = c.title;
        row.name_source = "native-course-name-lookup";
        result.push_back(row);
    }
    return result;
}

void extract(const DiscInput& source, const std::string& id, const std::filesystem::path& output,
             const ImportProgress& progress, const ImportCancel& cancel) {
    const gba::Rom rom{source, cancel};
    const auto found = std::find_if(rom.courses.begin(), rom.courses.end(), [&](const auto& c) { return c.id == id; });
    gba::require(found != rom.courses.end(), "Unknown SSX Tricky GBA course");
    gba::write_course(rom, *found, output, progress, cancel);
}

void music(const DiscInput& source, const std::string& id, const std::filesystem::path& output,
           const ImportProgress& progress, const ImportCancel& cancel) {
    const gba::Rom rom{source, cancel};
    const auto found = std::find_if(rom.courses.begin(), rom.courses.end(), [&](const auto& c) { return c.id == id; });
    gba::require(found != rom.courses.end(), "Unknown SSX Tricky GBA course");
    gba::write_music(rom, *found, output, progress, cancel);
}
} // namespace

const GameImporter ssx_gba_importer{accepts, courses, extract, nullptr, music};
} // namespace openslope::import_detail
