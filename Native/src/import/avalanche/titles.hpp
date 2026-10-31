#pragma once
#include "openslope/import.hpp"

namespace openslope::import_detail {
void avalanche_titles(const DiscInput& disc, std::vector<DiscCourse>& courses, const ImportCancel& cancel);
}
