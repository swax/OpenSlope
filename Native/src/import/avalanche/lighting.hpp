#pragma once
#include "import/shared.hpp"
#include <nlohmann/json_fwd.hpp>

namespace openslope::import_detail {
// Source light directions are kept in the source world basis until export.
nlohmann::json write_avalanche_lighting(Bytes geometry, Bytes player, Bytes scenery, Bytes shadow,
                                        const std::filesystem::path& output, const ImportCancel& cancel);
Image avalanche_texture(Bytes bytes, unsigned index);
} // namespace openslope::import_detail
