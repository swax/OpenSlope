#include "openslope/material_animation.hpp"
#include "import_internal.hpp"
#include "openslope/import.hpp"
#include <algorithm>
#include <cctype>
#include <fstream>
#include <nlohmann/json.hpp>
#include <optional>
#include <set>

namespace openslope::import_detail {
std::vector<std::vector<std::uint32_t>> material_frame_indices(std::span<const std::uint8_t> source) {
    Bytes bytes{source};
    const auto count = bytes.le(40), materials = bytes.le(20);
    if (count > 65535 || materials > 65535)
        throw std::runtime_error("Invalid material animation counts");
    std::size_t cursor = bytes.le(100), total = 0;
    std::vector<std::vector<std::uint32_t>> books;
    for (unsigned i = 0; i < count; ++i) {
        const auto frames = bytes.le(cursor);
        cursor += 4;
        total += frames;
        if (frames > 4096 || total > 1000000)
            throw std::runtime_error("Invalid flipbook frame count");
        bytes.range(cursor, std::size_t(frames) * 4);
        std::vector<std::uint32_t> book;
        for (unsigned j = 0; j < frames; ++j)
            book.push_back(bytes.le(cursor + j * 4));
        books.push_back(std::move(book));
        cursor += std::size_t(frames) * 4;
    }
    bytes.range(bytes.le(80), std::size_t(materials) * 72);
    std::vector<std::vector<std::uint32_t>> result;
    for (unsigned i = 0; i < materials; ++i) {
        const auto book = bytes.signed16(bytes.le(80) + i * 72 + 68);
        if (book < -1 || (book >= 0 && std::size_t(book) >= books.size()))
            throw std::runtime_error("Material references missing flipbook");
        result.push_back(book < 0 ? std::vector<std::uint32_t>{} : books[std::size_t(book)]);
    }
    return result;
}
} // namespace openslope::import_detail

namespace openslope {
namespace {
std::string lower(std::string value) {
    for (auto& c : value)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return value;
}

std::vector<std::uint8_t> file(const std::filesystem::path& root, const std::filesystem::path& path) {
    const auto base = std::filesystem::weakly_canonical(root), resolved = std::filesystem::weakly_canonical(path),
               within = resolved.lexically_relative(base);
    if (within.empty() || within.is_absolute() || *within.begin() == ".." ||
        std::filesystem::file_size(resolved) > 64 * 1024 * 1024)
        throw std::runtime_error("Invalid material sidecar");
    std::ifstream stream(resolved, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

std::string frame_name(std::string name) {
    if (!valid_map_name(name))
        throw std::runtime_error("Unsafe material frame");
    if (!lower(name).ends_with(".png"))
        name += ".png";
    return name;
}
} // namespace

std::vector<std::vector<std::string>> material_flipbooks(const std::filesystem::path& root) {
    if (root.empty() || !std::filesystem::is_regular_file(root / "Materials.json"))
        return {};
    const auto bytes = file(root, root / "Materials.json");
    const auto doc = nlohmann::json::parse(bytes);
    const auto& materials = doc.at("Materials");
    if (!materials.is_array() || materials.size() > 65535)
        throw std::runtime_error("Invalid animated material table");
    std::vector<std::vector<std::string>> result(materials.size());
    bool missing = false;
    std::size_t total = 0;
    for (std::size_t i = 0; i < materials.size(); ++i) {
        if (!materials[i].contains("TextureFlipbook")) {
            missing = true;
            continue;
        }
        const auto& frames = materials[i].at("TextureFlipbook");
        if (!frames.is_array() || frames.size() > 4096 || (total += frames.size()) > 1000000)
            throw std::runtime_error("Invalid material frame list");
        for (const auto& frame : frames)
            result[i].push_back(frame_name(frame.get<std::string>()));
    }
    if (!missing || !std::filesystem::is_directory(root / "Source"))
        return result;
    std::vector<std::filesystem::path> sources;
    for (const auto& entry : std::filesystem::directory_iterator(root / "Source"))
        if (entry.is_regular_file())
            sources.push_back(entry.path());
    std::optional<std::pair<std::filesystem::path, std::filesystem::path>> pair;
    for (const auto& p : sources)
        if (lower(p.extension().string()) == ".pbd" && !lower(p.stem().string()).ends_with("_sky"))
            for (const auto& image : sources)
                if (lower(image.filename().string()) == lower(p.stem().string() + ".ssh")) {
                    if (pair)
                        throw std::runtime_error("Ambiguous material sidecars");
                    pair = {{p, image}};
                }
    if (!pair)
        return result;
    const auto geometry = file(root, pair->first);
    import_detail::Bytes pbd{geometry};
    if (pbd.le(20) != materials.size() || pbd.le(40) == 0)
        return result;
    const auto indices = import_detail::material_frame_indices(geometry);
    const auto art = file(root, pair->second);
    import_detail::Bytes bank{art};
    if (bank.text(0, 4) != "SHPS" || bank.le(4) != art.size())
        throw std::runtime_error("Invalid material texture directory");
    const auto count = bank.le(8);
    if (!count || count > 4096)
        throw std::runtime_error("Invalid material texture count");
    bank.range(16, std::size_t(count) * 8);
    std::vector<std::string> names;
    std::set<std::string> unique;
    for (unsigned i = 0; i < count; ++i) {
        auto name = bank.text(16 + i * 8, 4);
        while (!name.empty() && (name.back() == '\0' || name.back() == ' '))
            name.pop_back();
        name = frame_name(name);
        if (!unique.insert(name).second)
            throw std::runtime_error("Duplicate material texture name");
        names.push_back(name);
    }
    for (std::size_t i = 0; i < materials.size(); ++i)
        if (!materials[i].contains("TextureFlipbook") && !indices[i].empty()) {
            const auto base = pbd.signed16(pbd.le(80) + i * 72);
            if (base < 0 || std::size_t(base) >= names.size() ||
                (!materials[i].contains("TexturePath") || !materials[i].at("TexturePath").is_string() ||
                 materials[i].at("TexturePath").get<std::string>() != names[std::size_t(base)]))
                continue;
            for (const auto index : indices[i]) {
                if (index >= names.size())
                    throw std::runtime_error("Material frame references missing texture");
                result[i].push_back(names[index]);
            }
        }
    return result;
}
} // namespace openslope
