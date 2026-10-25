#include "import/ssx/formats.hpp"
#include <chrono>
#include <fstream>
#include <nlohmann/json.hpp>
#include <set>

namespace openslope::import_detail {
void write_crowd(std::span<const std::uint8_t> source, const std::filesystem::path& root, const ImportCancel& cancel) {
    if (source.size() > 64 * 1024 * 1024 || !std::filesystem::is_directory(root) ||
        std::filesystem::exists(root / "Crowd.json"))
        throw std::runtime_error("Invalid crowd source or existing profile");
    const auto images = decode_ssh(source, false, cancel);
    if (images.size() != 16)
        throw std::runtime_error("Shared crowd bank requires sixteen frames");
    const auto base = std::filesystem::weakly_canonical(root),
               textures = std::filesystem::weakly_canonical(root / "Textures"),
               relative = textures.lexically_relative(base);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
        throw std::runtime_error("Unsafe crowd texture directory");
    nlohmann::json names = nlohmann::json::array();
    std::set<std::string> unique;
    for (const auto& image : images) {
        const auto name = "crowd-" + image.name + ".png";
        if (!valid_map_name(name) || !unique.insert(name).second || std::filesystem::exists(textures / name))
            throw std::runtime_error("Crowd texture conflicts with an existing map asset");
        names.push_back(name);
    }
    std::filesystem::create_directories(textures);
    std::vector<std::filesystem::path> created;
    const auto temporary =
        root /
        (".openslope-crowd-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".json");
    try {
        for (std::size_t i = 0; i < images.size(); ++i) {
            check_cancel(cancel);
            const auto path = textures / names[i].get<std::string>();
            created.push_back(path);
            write_png(path, images[i]);
        }
        check_cancel(cancel);
        {
            std::ofstream file(temporary, std::ios::binary);
            file << nlohmann::json{{"Schema", "openslope-crowd/v1"}, {"Frames", names}}.dump() << '\n';
            if (!file)
                throw std::runtime_error("Cannot write crowd profile");
        }
        if (std::filesystem::exists(root / "Crowd.json"))
            throw std::runtime_error("Crowd profile appeared during conversion");
        std::filesystem::rename(temporary, root / "Crowd.json");
    } catch (...) {
        std::error_code error;
        std::filesystem::remove(temporary, error);
        for (const auto& path : created)
            std::filesystem::remove(path, error);
        throw;
    }
}
} // namespace openslope::import_detail
