#pragma once
#include "openslope/props.hpp"
#include <nlohmann/json_fwd.hpp>

namespace openslope::prop_detail {
// Reuse the already validated instance table during import/runtime validation.
// Keep this JSON-dependent interface private to the core library.
std::vector<Transform> placements(const nlohmann::json& rows);
} // namespace openslope::prop_detail
