#include "music_assignment.hpp"
#include "strings.hpp"
#include <algorithm>
#include <numeric>

namespace openslope::import_detail {
namespace {
std::string map_key(const std::string& name) {
    auto key = upper(name);
    if (key.starts_with("SSXOT_")) {
        if (key.ends_with("_DAY"))
            key.resize(key.size() - 4);
        else if (key.ends_with("_NIGHT"))
            key.resize(key.size() - 6);
    }
    return key;
}
} // namespace

MusicAssignment assign_map_music(std::span<const DiscCourse> courses, const std::string& requested, std::size_t songs) {
    if (songs > 4096 || courses.size() > 10000)
        throw std::runtime_error("Music assignment exceeds its limits");
    MusicAssignment out;
    if (requested.empty()) {
        out.indices.resize(songs);
        std::iota(out.indices.begin(), out.indices.end(), 0);
        out.metadata = {{"Mode", "full-catalogue"}, {"CatalogueSongs", songs}};
        return out;
    }
    std::vector<std::string> maps;
    for (const auto& course : courses)
        maps.push_back(map_key(course.name));
    std::sort(maps.begin(), maps.end());
    maps.erase(std::unique(maps.begin(), maps.end()), maps.end());
    const auto key = map_key(requested);
    const auto at = std::lower_bound(maps.begin(), maps.end(), key);
    if (at == maps.end() || *at != key)
        throw std::runtime_error("Music assignment course is not in the disc catalogue");
    const auto index = std::size_t(at - maps.begin());
    if (songs) {
        // Partition catalogue order evenly. When maps outnumber songs, cycle
        // the song index so every map still has music without importing extras.
        const auto first = songs < maps.size() ? index % songs : index * songs / maps.size();
        const auto end = songs < maps.size() ? first + 1 : (index + 1) * songs / maps.size();
        for (auto song = first; song < end; ++song)
            out.indices.push_back(song);
    }
    out.metadata = {{"Mode", "map-index-v1"},  {"Map", key},
                    {"MapIndex", index},       {"MapCount", maps.size()},
                    {"CatalogueSongs", songs}, {"SongIndices", out.indices}};
    return out;
}

MusicAssignment assign_map_music(const DiscInput& disc, const std::string& requested, std::size_t songs,
                                 const ImportCancel& cancel) {
    if (requested.empty())
        return assign_map_music(std::span<const DiscCourse>{}, requested, songs);
    const auto courses = disc_courses(disc, cancel);
    return assign_map_music(courses, requested, songs);
}
} // namespace openslope::import_detail
