#include "importer.hpp"
#include "formats.hpp"
#include "import/containers/disc.hpp"
#include "titles.hpp"

namespace openslope::import_detail {
namespace {
bool accepts(const DiscInput& disc) {
    if (!gamecube_disc(disc))
        return false;
    const auto header = disc.read(0, 6);
    return Bytes{header}.text(0, 6) == "GTEE01";
}
} // namespace

const GameImporter avalanche_importer{
    accepts, avalanche_courses, write_avalanche_course, avalanche_titles,
    [](const DiscInput& disc, const std::string&, const std::filesystem::path& output, const ImportProgress& progress,
       const ImportCancel& cancel) { write_avalanche_music(disc, output, progress, cancel); }};
} // namespace openslope::import_detail
