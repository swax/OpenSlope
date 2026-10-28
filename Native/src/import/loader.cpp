#include "avalanche/importer.hpp"
#include "game_importer.hpp"
#include "madtrix/importer.hpp"
#include "shared.hpp"
#include "ssx/importer.hpp"
#include "strings.hpp"
#include <array>

namespace openslope {
namespace {
using namespace import_detail;

const GameImporter& importer(const DiscInput& disc, const ImportCancel& cancel) {
    // Register another game family here; filesystem/container readers remain independent.
    constexpr std::array importers{&ssx_importer, &avalanche_importer, &madtrix_importer};
    for (const auto* candidate : importers) {
        check_cancel(cancel);
        if (candidate->accepts(disc))
            return *candidate;
    }
    throw std::runtime_error("No supported game maps were found on this disc");
}
} // namespace

std::vector<DiscCourse> disc_courses(const DiscInput& image, const ImportCancel& cancelled) {
    const auto disc = logical_disc(image);
    return importer(disc, cancelled).courses(disc, cancelled);
}

void extract_course(const DiscInput& source_image, const std::string& course, const std::filesystem::path& output,
                    const ImportProgress& progress, const ImportCancel& cancelled) {
    const auto disc = logical_disc(source_image);
    const auto stem = import_detail::upper(course);
    if (!valid_map_name(stem))
        throw std::runtime_error("Invalid course name");
    if (!std::filesystem::create_directory(output))
        throw std::runtime_error("Import destination already exists");

    struct Cleanup {
        std::filesystem::path path;
        bool complete = false;

        ~Cleanup() {
            if (!complete) {
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
        }
    } cleanup{std::filesystem::absolute(output)};

    const auto notify = [&](const std::string& text) {
        import_detail::check_cancel(cancelled);
        if (progress)
            progress(text);
    };
    notify("Reading " + stem + " archive");
    importer(disc, cancelled).extract(disc, stem, output, progress, cancelled);
    import_detail::check_cancel(cancelled);
    cleanup.complete = true;
}
} // namespace openslope
