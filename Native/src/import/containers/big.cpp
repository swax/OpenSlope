#include "big.hpp"
#include "import/strings.hpp"
#include <algorithm>
#include <set>
#include <sstream>

namespace openslope::import_detail {
std::vector<Extent> archive_index(const DiscInput& disc, const Extent& extent) {
    const auto header = disc.read(extent.offset, static_cast<std::size_t>(std::min<std::uint64_t>(extent.size, 16)));
    Bytes h{header};
    const bool compact = header.size() >= 6 && h.be(0, 2) == 0xc0fb;
    if (!compact && (header.size() < 16 || (h.text(0, 4) != "BIGF" && h.text(0, 4) != "BIG4")))
        throw std::runtime_error("Unsupported audio archive");
    const unsigned width = compact ? 3 : 4;
    const std::size_t end = compact ? h.be(2, 2) + 4 : h.be(12), start = compact ? 6 : 16;
    if (end < start || end > extent.size || end > 4 * 1024 * 1024)
        throw std::runtime_error("Invalid archive index extent");
    const auto table = disc.read(extent.offset, end);
    Bytes b{table};
    std::vector<Extent> result;
    std::set<std::string> names;
    std::size_t entries = 0;
    const auto declared_count = compact ? 0u : h.be(8);
    if (!compact && declared_count > 65535)
        throw std::runtime_error("Invalid archive index count");
    for (std::size_t p = start; compact ? p < end : entries < declared_count;) {
        if (++entries > 65535 || end - p < 2 * width + 1)
            throw std::runtime_error("Invalid archive index count");
        const auto offset = b.be(p, width), size = b.be(p + width, width);
        p += 2 * width;
        const auto begin = p;
        while (p < end && table[p])
            ++p;
        if (p == end || p - begin > 512)
            throw std::runtime_error("Invalid archive member name");
        auto name = b.text(begin, p - begin);
        ++p;
        std::replace(name.begin(), name.end(), '\\', '/');
        if (name.empty() || name.front() == '/')
            throw std::runtime_error("Unsafe archive member");
        std::istringstream path(name);
        std::string segment;
        while (std::getline(path, segment, '/'))
            if (segment != "*" && !valid_map_name(segment))
                throw std::runtime_error("Unsafe archive member segment");
        if (!offset || name.find('*') != std::string::npos)
            continue;
        if (offset < end || offset > extent.size || size > extent.size - offset || !names.insert(upper(name)).second)
            throw std::runtime_error("Invalid or duplicate archive member");
        result.push_back({name, extent.offset + offset, size, false});
    }
    return result;
}

// [Trailmap: 200-c0fb, 200-bigf, 200-c0fb-entries] Offsets are absolute;
// header end bounds the entry walk, including placeholder entries.
std::map<std::string, std::vector<std::uint8_t>> archive(const DiscInput& disc, const Extent& extent,
                                                         const ImportCancel& cancelled) {
    const auto raw = disc.read(extent.offset, static_cast<std::size_t>(extent.size));
    Bytes b{raw};
    const bool compact = raw.size() >= 6 && b.be(0, 2) == 0xc0fb;
    if (!compact && (raw.size() < 16 || (b.text(0, 4) != "BIGF" && b.text(0, 4) != "BIG4")))
        throw std::runtime_error("Unsupported level archive");
    const unsigned width = compact ? 3 : 4;
    const std::size_t end = compact ? b.be(2, 2) + 4 : b.be(12);
    std::size_t p = compact ? 6 : 16;
    if (end < p || end > raw.size())
        throw std::runtime_error("Invalid BIG header extent");
    std::map<std::string, std::vector<std::uint8_t>> members;
    std::size_t total = 0, entries = 0;
    while (p < end) {
        import_detail::check_cancel(cancelled);
        if (++entries > 65535 || end - p < 2 * width + 1)
            throw std::runtime_error("Invalid BIG entry table");
        const auto offset = b.be(p, width), size = b.be(p + width, width);
        p += 2 * width;
        const auto start = p;
        while (p < end && raw[p])
            ++p;
        if (p == end || p - start > 512)
            throw std::runtime_error("Unterminated BIG member name");
        auto name = b.text(start, p - start);
        ++p;
        std::replace(name.begin(), name.end(), '\\', '/');
        std::istringstream path(name);
        std::string segment;
        while (std::getline(path, segment, '/'))
            if (segment != "*" && !valid_map_name(segment))
                throw std::runtime_error("Unsafe BIG member path");
        if (name.empty() || name.front() == '/')
            throw std::runtime_error("Unsafe BIG member path");
        if (!offset || name.find('*') != std::string::npos)
            continue;
        if (offset < end)
            throw std::runtime_error("BIG member overlaps its table");
        b.range(offset, size);
        auto bytes = decode_refpack(b.data.subspan(offset, size));
        total += bytes.size();
        if (total > 256 * 1024 * 1024)
            throw std::runtime_error("Level archive exceeds import memory limit");
        name = upper(name.substr(name.find_last_of('/') == std::string::npos ? 0 : name.find_last_of('/') + 1));
        if (!members.emplace(name, std::move(bytes)).second)
            throw std::runtime_error("Duplicate level member");
    }
    return members;
}

} // namespace openslope::import_detail
