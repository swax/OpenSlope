#include "openslope/import.hpp"
#include <algorithm>

namespace openslope {
bool valid_map_name(const std::string& name) {
    if (name.empty() || name.size() > 128 || name.front() == '.' || name.back() == '.' || name.back() == ' ')
        return false;
    return std::all_of(name.begin(), name.end(), [](unsigned char c) {
        return c >= 32 && c != 127 && c != '/' && c != '\\' && c != ':' && c != '*' && c != '?' && c != '"' &&
               c != '<' && c != '>' && c != '|';
    });
}

std::vector<std::string> available_maps(const std::filesystem::path& root) {
    std::vector<std::string> result;
    if (!std::filesystem::is_directory(root))
        return result;
    for (const auto& entry : std::filesystem::directory_iterator(root)) {
        const auto name = entry.path().filename().string();
        if (valid_map_name(name) && entry.is_directory() && !entry.is_symlink() &&
            std::filesystem::is_regular_file(entry.path() / "Patches.json"))
            result.push_back(name);
    }
    std::sort(result.begin(), result.end());
    return result;
}

} // namespace openslope
