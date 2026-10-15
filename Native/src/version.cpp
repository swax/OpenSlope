#include "openslope/version.hpp"
#include "build_version.hpp"

namespace openslope {
std::string_view application_version() { return build_version; }
} // namespace openslope
