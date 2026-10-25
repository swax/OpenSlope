#include "importer.hpp"
#include "formats.hpp"
#include "import/containers/disc.hpp"

namespace openslope::import_detail {
namespace {
bool accepts(const DiscInput& disc) {
    if (!gamecube_disc(disc))
        return false;
    const auto header = disc.read(0, 6);
    return Bytes{header}.text(0, 6) == "GTEE01";
}
} // namespace

const GameImporter avalanche_importer{accepts, avalanche_courses, write_avalanche_course};
} // namespace openslope::import_detail
