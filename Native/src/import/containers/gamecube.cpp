#include "disc.hpp"
#include <algorithm>
#include <cctype>

namespace openslope::import_detail {
namespace {
struct File {
    std::string path;
    std::uint64_t offset{}, size{};
    bool directory{};
};

std::string key(std::string name) {
    for (auto& c : name)
        c = char(std::toupper(static_cast<unsigned char>(c)));
    return name;
}

std::vector<File> index(const DiscInput& disc) {
    const auto header = disc.read(0, 0x440);
    Bytes h{header};
    if (h.be(0x1c) != 0xc2339f3d)
        throw std::runtime_error("Not a GameCube disc");
    const auto offset = h.be(0x424), size = h.be(0x428);
    if (size < 12 || size > 16 * 1024 * 1024)
        throw std::runtime_error("Invalid GameCube filesystem extent");
    const auto data = disc.read(offset, size);
    Bytes b{data};
    const auto count = b.be(8);
    if (b.be(0) != 0x01000000 || !count || count > 100000 || count > size / 12)
        throw std::runtime_error("Invalid GameCube filesystem root");

    struct Directory {
        std::string name;
        unsigned end, index;
    };

    std::vector<Directory> stack{{"", count, 0}};
    std::vector<File> files;
    std::vector<std::string> names;
    for (unsigned i = 1; i < count; ++i) {
        while (!stack.empty() && i >= stack.back().end)
            stack.pop_back();
        if (stack.empty())
            throw std::runtime_error("Invalid GameCube directory nesting");
        const auto type_name = b.be(i * 12), off = b.be(i * 12 + 4), bytes = b.be(i * 12 + 8);
        const auto at = std::size_t(count) * 12 + (type_name & 0xffffff);
        b.range(at, 1);
        auto end = at;
        while (end < data.size() && data[end] && end - at <= 128)
            ++end;
        if (end == data.size() || end - at > 128)
            throw std::runtime_error("Invalid GameCube filename");
        const auto name = b.text(at, end - at);
        if (!valid_map_name(name))
            throw std::runtime_error("Unsafe GameCube filename");
        auto path = stack.back().name.empty() ? name : stack.back().name + "/" + name;
        if (path.size() > 1024 || (type_name >> 24) > 1)
            throw std::runtime_error("Invalid GameCube filesystem entry");
        names.push_back(key(path));
        const bool directory = (type_name >> 24) != 0;
        if (directory) {
            if (off != stack.back().index || bytes <= i || bytes > stack.back().end)
                throw std::runtime_error("Invalid GameCube directory bounds");
            stack.push_back({path, bytes, i});
        } else if (off > disc.size || bytes > disc.size - off)
            throw std::runtime_error("GameCube file lies outside the image");
        files.push_back({std::move(path), off, bytes, directory});
    }
    std::sort(names.begin(), names.end());
    if (std::adjacent_find(names.begin(), names.end()) != names.end())
        throw std::runtime_error("Duplicate GameCube path");
    return files;
}
} // namespace

bool gamecube_disc(const DiscInput& disc) {
    return disc.size >= 0x440 && Bytes{disc.read(0x1c, 4)}.be(0) == 0xc2339f3d;
}

std::vector<DiscEntry> gamecube_directory(const DiscInput& disc, const std::string& path) {
    const auto prefix = path.empty() ? std::string{} : key(path) + "/";
    std::vector<DiscEntry> result;
    for (const auto& file : index(disc)) {
        const auto candidate = key(file.path);
        if (candidate.starts_with(prefix) && file.path.find('/', prefix.size()) == std::string::npos)
            result.push_back({file.path.substr(prefix.size()), file.size, file.directory});
    }
    return result;
}

std::vector<std::uint8_t> gamecube_file(const DiscInput& disc, const std::string& path) {
    const auto requested = key(path);
    for (const auto& file : index(disc))
        if (!file.directory && key(file.path) == requested)
            return disc.read(file.offset, std::size_t(file.size));
    throw std::runtime_error("GameCube file not found: " + path);
}
} // namespace openslope::import_detail
