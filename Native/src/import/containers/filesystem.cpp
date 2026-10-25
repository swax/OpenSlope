#include "big.hpp"
#include "import/strings.hpp"
#include <algorithm>

namespace openslope {
using import_detail::archive_index;
using import_detail::Iso;
using import_detail::upper;

std::vector<DiscEntry> disc_directory(const DiscInput& image, const std::string& path) {
    const auto disc = logical_disc(image);
    if (import_detail::gamecube_disc(disc))
        return import_detail::gamecube_directory(disc, path);
    Iso iso(disc);
    std::vector<DiscEntry> result;
    for (const auto& entry : iso.children(iso.find(path)))
        result.push_back({entry.name, entry.size, entry.directory});
    return result;
}

std::vector<std::uint8_t> disc_file(const DiscInput& image, const std::string& path) {
    const auto disc = logical_disc(image);
    if (import_detail::gamecube_disc(disc))
        return import_detail::gamecube_file(disc, path);
    Iso iso(disc);
    const auto entry = iso.find(path);
    if (entry.directory)
        throw std::runtime_error("Disc path names a directory");
    return disc.read(entry.offset, static_cast<std::size_t>(entry.size));
}

std::vector<DiscEntry> disc_archive_directory(const DiscInput& image, const std::string& path) {
    const auto disc = logical_disc(image);
    Iso iso(disc);
    std::vector<DiscEntry> result;
    for (const auto& entry : archive_index(disc, iso.find(path)))
        result.push_back({entry.name, entry.size, false});
    return result;
}

std::vector<std::uint8_t> disc_archive_file(const DiscInput& image, const std::string& path,
                                            const std::string& member_name) {
    const auto disc = logical_disc(image);
    Iso iso(disc);
    const auto entries = archive_index(disc, iso.find(path));
    const auto it = std::find_if(entries.begin(), entries.end(),
                                 [&](const auto& entry) { return upper(entry.name) == upper(member_name); });
    if (it == entries.end())
        throw std::runtime_error("Archive member not found: " + member_name);
    return decode_refpack(disc.read(it->offset, static_cast<std::size_t>(it->size)));
}

} // namespace openslope
