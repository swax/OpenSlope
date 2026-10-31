#include "avalanche/importer.hpp"
#include "course_metadata.hpp"
#include "game_importer.hpp"
#include "madtrix/importer.hpp"
#include "music_cache.hpp"
#include "shared.hpp"
#include "ssx/importer.hpp"
#include "ssx_gba/importer.hpp"
#include "strings.hpp"
#include <array>
#include <fstream>
#include <nlohmann/json.hpp>

namespace openslope {
namespace {
using namespace import_detail;

const GameImporter& importer(const DiscInput& disc, const ImportCancel& cancel) {
    // Register another game family here; filesystem/container readers remain independent.
    constexpr std::array importers{&ssx_gba_importer, &ssx_importer, &avalanche_importer, &madtrix_importer};
    for (const auto* candidate : importers) {
        check_cancel(cancel);
        if (candidate->accepts(disc))
            return *candidate;
    }
    throw std::runtime_error("No supported game maps were found on this disc");
}
} // namespace

std::vector<DiscCourse> disc_courses(const DiscInput& image, const ImportCancel& cancelled) {
    import_detail::check_cancel(cancelled);
    if (image.context && image.context->listed)
        return image.context->courses;
    const auto disc = image.context ? image : logical_disc(image);
    const auto& family = image.context && image.context->family ? *image.context->family : importer(disc, cancelled);
    auto courses = family.courses(disc, cancelled);
    if (family.titles) {
        try {
            family.titles(disc, courses, cancelled);
        } catch (const std::exception&) {
            import_detail::check_cancel(cancelled);
        }
    }
    if (disc.context) {
        disc.context->family = &family;
        disc.context->courses = courses;
        disc.context->listed = true;
        ++disc.context->stats.scans;
    }
    return courses;
}

void extract_course(const DiscInput& source_image, const std::string& course, const std::filesystem::path& output,
                    const ImportProgress& progress, const ImportCancel& cancelled) {
    const auto disc = source_image.context ? source_image : logical_disc(source_image);
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
    const auto& family = disc.context && disc.context->family ? *disc.context->family : importer(disc, cancelled);
    family.extract(disc, stem, output, progress, cancelled);
    auto named = disc_courses(disc, cancelled);
    std::erase_if(named, [&](const auto& entry) { return entry.name != stem && entry.name != "TRICKY_" + stem; });
    if (named.empty())
        named.push_back({stem, 0});
    // Old saved projects still request bare Tricky slots. Keep their cache keys intact.
    named.front().name = stem;
    {
        const auto path = output / "Import.json";
        std::ifstream input(path);
        auto metadata = nlohmann::json::parse(input);
        input.close();
        metadata.update(import_detail::course_metadata(named.front()));
        std::ofstream file(path);
        file << metadata.dump(2) << '\n';
        if (!file)
            throw std::runtime_error("Cannot write course title metadata");
    }
    import_detail::check_cancel(cancelled);
    cleanup.complete = true;
}
} // namespace openslope
