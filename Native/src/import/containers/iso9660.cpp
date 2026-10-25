#include "disc.hpp"
#include "import/strings.hpp"
#include <algorithm>
#include <sstream>

namespace openslope::import_detail {
bool iso9660_disc(const DiscInput& disc) {
    if (disc.size < 17 * 2048)
        return false;
    const auto descriptor = disc.read(16 * 2048, 7);
    return Bytes{descriptor}.text(1, 5) == "CD001" && descriptor[6] == 1;
}

Extent Iso::record(Bytes b, std::size_t p) const {
    const auto length = b.le(p, 1);
    if (length < 34)
        throw std::runtime_error("Invalid ISO directory record");
    b.range(p, length);
    const auto name_length = b.le(p + 32, 1);
    if (name_length > length - 33)
        throw std::runtime_error("Invalid ISO filename length");
    const auto lba = b.le(p + 2), size = b.le(p + 10);
    if (lba != b.be(p + 6) || size != b.be(p + 14))
        throw std::runtime_error("ISO endian fields disagree");
    if (b.le(p + 1, 1) || b.le(p + 26, 1) || b.le(p + 27, 1) || (b.le(p + 25, 1) & 0x80))
        throw std::runtime_error("Extended, interleaved or multi-extent ISO files are unsupported");
    const std::uint64_t offset = std::uint64_t(lba) * 2048;
    if (offset > disc_.size || size > disc_.size - offset)
        throw std::runtime_error("ISO directory points outside image");
    auto name = b.text(p + 33, name_length);
    const auto semi = name.find(';');
    if (semi != std::string::npos)
        name.resize(semi);
    return {name, offset, size, (b.le(p + 25, 1) & 2) != 0};
}

Iso::Iso(const DiscInput& disc) : disc_(disc) {
    for (unsigned sector = 16; sector < 48; ++sector) {
        const auto raw = disc.read(std::uint64_t(sector) * 2048, 2048);
        Bytes b{raw};
        if (b.text(1, 5) != "CD001" || b.le(6, 1) != 1)
            throw std::runtime_error("This is not an ISO9660 disc image");
        if (b.le(0, 1) == 255)
            break;
        if (b.le(0, 1) == 1) {
            if (b.le(128, 2) != 2048 || b.be(130, 2) != 2048)
                throw std::runtime_error("ISO logical sector size is unsupported");
            root_ = record(b, 156);
            if (!root_.directory)
                throw std::runtime_error("Invalid ISO root");
            return;
        }
    }
    throw std::runtime_error("ISO primary volume descriptor is missing");
}

std::vector<Extent> Iso::children(const Extent& directory) const {
    if (!directory.directory || directory.size > 4 * 1024 * 1024)
        throw std::runtime_error("Invalid or oversized ISO directory");
    const auto data = disc_.read(directory.offset, static_cast<std::size_t>(directory.size));
    Bytes b{data};
    std::vector<Extent> result;
    for (std::size_t p = 0; p < data.size();) {
        const auto size = data[p];
        if (!size) {
            p = std::min(data.size(), (p / 2048 + 1) * 2048);
            continue;
        }
        if (size > 2048 - p % 2048)
            throw std::runtime_error("ISO record crosses a sector boundary");
        auto entry = record(b, p);
        p += size;
        if (entry.name.size() == 1 && (entry.name[0] == 0 || entry.name[0] == 1))
            continue;
        if (!valid_map_name(entry.name))
            throw std::runtime_error("Unsafe ISO filename");
        if (result.size() >= 65535)
            throw std::runtime_error("ISO directory has too many entries");
        result.push_back(std::move(entry));
    }
    return result;
}

Extent Iso::find(const std::string& path) const {
    Extent current = root_;
    std::istringstream stream(path);
    std::string part;
    while (std::getline(stream, part, '/')) {
        if (!valid_map_name(part))
            throw std::runtime_error("Invalid disc path");
        const auto entries = children(current);
        const auto it =
            std::find_if(entries.begin(), entries.end(), [&](const auto& e) { return upper(e.name) == upper(part); });
        if (it == entries.end())
            throw std::runtime_error("Disc has no " + path);
        current = *it;
    }
    return current;
}
} // namespace openslope::import_detail
