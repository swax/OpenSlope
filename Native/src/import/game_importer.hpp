#pragma once
#include "openslope/import.hpp"

namespace openslope::import_detail {
// Callbacks receive a logical, seekable disc. Probes inspect identity/layout only;
// once a probe matches, parsing failures propagate instead of trying another game.
// The shared loader owns destination creation, cancellation and failure cleanup.
struct GameImporter {
    bool (*accepts)(const DiscInput& disc);
    std::vector<DiscCourse> (*courses)(const DiscInput& disc, const ImportCancel& cancel);
    void (*extract)(const DiscInput& disc, const std::string& course, const std::filesystem::path& output,
                    const ImportProgress& progress, const ImportCancel& cancel);
    void (*titles)(const DiscInput& disc, std::vector<DiscCourse>& courses, const ImportCancel& cancel) = nullptr;
    void (*music)(const DiscInput& disc, const std::string& course, const std::filesystem::path& output,
                  const ImportProgress& progress, const ImportCancel& cancel) = nullptr;
};
} // namespace openslope::import_detail
