#pragma once
#include "disc.hpp"
#include <map>

namespace openslope::import_detail {
std::vector<Extent> archive_index(const DiscInput& disc, const Extent& extent);
std::map<std::string, std::vector<std::uint8_t>> archive(const DiscInput& disc, const Extent& extent,
                                                         const ImportCancel& cancelled);
} // namespace openslope::import_detail
