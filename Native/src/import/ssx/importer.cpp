#include "importer.hpp"
#include "formats.hpp"
#include "import/containers/big.hpp"
#include "import/strings.hpp"
#include <algorithm>

namespace openslope::import_detail {
namespace {
bool accepts(const DiscInput& disc) {
    if (!iso9660_disc(disc))
        return false;
    Iso iso(disc);
    const auto root = iso.children(iso.find(""));
    if (std::none_of(root.begin(), root.end(), [](const auto& e) { return e.directory && upper(e.name) == "DATA"; }))
        return false;
    const auto data = iso.children(iso.find("DATA"));
    return std::any_of(data.begin(), data.end(), [](const auto& e) {
        return e.directory && (upper(e.name) == "MODELS" || upper(e.name) == "WORLDS");
    });
}

std::vector<DiscCourse> courses(const DiscInput& disc, const ImportCancel& cancelled) {
    Iso iso(disc);
    import_detail::check_cancel(cancelled);
    const auto data = iso.children(iso.find("DATA"));
    if (std::any_of(data.begin(), data.end(), [](const auto& e) { return e.directory && upper(e.name) == "WORLDS"; })) {
        const auto database = disc_archive_file(disc, "DATA/WORLDS/BAM.BIG", "data/worlds/bam.sdb");
        if (Bytes{database}.le(0) == 0x21004e00) {
            const auto ids = disc_archive_file(disc, "DATA/WORLDS/BAM.BIG", "data/worlds/bam.phm"),
                       names = disc_archive_file(disc, "DATA/WORLDS/BAM.BIG", "data/worlds/bam.psm");
            return import_detail::ontour_courses(database, ids, names,
                                                 disc_archive_directory(disc, "DATA/WORLDS/BAM.BIG"),
                                                 iso.find("DATA/WORLDS/BAM.BIG").size);
        }
        return import_detail::ssx3_courses(database, iso.find("DATA/WORLDS/BAM.BIG").size);
    }
    std::vector<DiscCourse> result;
    for (const auto& entry : iso.children(iso.find("DATA/MODELS"))) {
        import_detail::check_cancel(cancelled);
        const auto name = upper(entry.name);
        if (entry.directory || !name.ends_with(".BIG") || name == "SSXFE.BIG")
            continue;
        const auto stem = name.substr(0, name.size() - 4);
        // Discovery needs the PBD format header, not decoded textures, audio or
        // source sidecars for every course. Validate the full index and leaf
        // names now; extraction still decodes and validates every member.
        std::map<std::string, Extent> files;
        for (auto file : archive_index(disc, entry)) {
            import_detail::check_cancel(cancelled);
            const auto slash = file.name.find_last_of('/');
            const auto leaf = upper(file.name.substr(slash == std::string::npos ? 0 : slash + 1));
            if (!files.emplace(leaf, std::move(file)).second)
                throw std::runtime_error("Duplicate level member");
        }
        const auto original =
            std::find_if(files.begin(), files.end(), [](const auto& file) { return file.first.ends_with(".WDX"); });
        if (original != files.end()) {
            const auto index = decode_refpack(disc.read(original->second.offset, std::size_t(original->second.size)));
            import_detail::ssx_header(index);
            const auto base = original->first.substr(0, original->first.size() - 4);
            for (const auto suffix : {".WDF", ".WDR", ".SSH", "L.SSH", ".AIP", ".WFX"})
                if (!files.contains(base + suffix))
                    throw std::runtime_error("SSX course archive is incomplete");
            result.push_back({"SSX_" + stem, entry.size});
            continue;
        }
        const auto it = files.find(stem + ".PBD");
        if (it != files.end()) {
            const auto geometry =
                decode_refpack(disc.read(it->second.offset, static_cast<std::size_t>(it->second.size)));
            pbd_header(Bytes{geometry});
            if (!files.contains(stem + ".MAP") || !files.contains(stem + ".SSH"))
                throw std::runtime_error("Course archive is incomplete");
            result.push_back({stem, entry.size});
        }
    }
    if (result.empty())
        throw std::runtime_error("No supported SSX, SSX Tricky, SSX 3 or SSX On Tour PS2 maps were found");
    std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) { return a.name < b.name; });
    return result;
}

void extract(const DiscInput& disc, const std::string& stem, const std::filesystem::path& output,
             const ImportProgress& progress, const ImportCancel& cancelled) {
    Iso iso(disc);
    if (stem.starts_with("SSX3_") || stem.starts_with("SSXOT_")) {
        const auto entries = archive_index(disc, iso.find("DATA/WORLDS/BAM.BIG"));
        const auto it = std::find_if(entries.begin(), entries.end(),
                                     [](const auto& e) { return upper(e.name) == "DATA/WORLDS/BAM.SSB"; });
        if (it == entries.end())
            throw std::runtime_error("Mountain world stream is missing");
        DiscInput stream{it->size, [disc, offset = it->offset](std::uint64_t p, std::span<std::uint8_t> bytes) {
                             disc.read_at(offset + p, bytes);
                         }};
        const auto database = disc_archive_file(disc, "DATA/WORLDS/BAM.BIG", "data/worlds/bam.sdb"),
                   identifiers = disc_archive_file(disc, "DATA/WORLDS/BAM.BIG", "data/worlds/bam.phm"),
                   names = disc_archive_file(disc, "DATA/WORLDS/BAM.BIG", "data/worlds/bam.psm");
        if (stem.starts_with("SSXOT_")) {
            const auto courses = import_detail::ontour_courses(database, identifiers, names,
                                                               disc_archive_directory(disc, "DATA/WORLDS/BAM.BIG"),
                                                               iso.find("DATA/WORLDS/BAM.BIG").size);
            if (std::none_of(courses.begin(), courses.end(), [&](const auto& item) { return item.name == stem; }))
                throw std::runtime_error("Unknown On Tour track or time of day");
        }
        import_detail::write_mountain_course(disc, stream, database, identifiers, names, stem, output, progress,
                                             cancelled);
        return;
    }
    const bool original = stem.starts_with("SSX_");
    const auto files = archive(disc, iso.find("DATA/MODELS/" + (original ? stem.substr(4) : stem) + ".BIG"), cancelled);
    if (original) {
        import_detail::write_ssx_course(disc, files, stem, output, progress, cancelled);
        return;
    }
    write_tricky_course(disc, files, stem, output, progress, cancelled);
}
} // namespace

const GameImporter ssx_importer{accepts, courses, extract};
} // namespace openslope::import_detail
