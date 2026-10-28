#pragma once
#include "import/containers/pak.hpp"

namespace openslope::import_detail {
void write_madtrix_audio(const Pak& pak, const std::string& course, const std::filesystem::path& output,
                         const ImportCancel& cancel);
unsigned write_madtrix_music(const DiscInput& disc, const std::filesystem::path& output, const ImportCancel& cancel);
} // namespace openslope::import_detail
