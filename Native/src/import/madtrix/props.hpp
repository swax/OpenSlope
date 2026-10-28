#pragma once
#include "import/containers/pak.hpp"
#include <functional>
#include <nlohmann/json_fwd.hpp>

namespace openslope::import_detail {
nlohmann::json write_madtrix_props(const Pak& pak, const std::string& course, const std::filesystem::path& output,
                                   const std::function<Image(const std::string&)>& image, const ImportCancel& cancel);
}
