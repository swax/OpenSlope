#include "pak.hpp"
#include <algorithm>

namespace openslope::import_detail {
namespace {
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
} // namespace

// [Trailmap: 550-package] Reflected CRC with zero seed and no final complement;
// the package's ASCII fold clears bit five, including in punctuation.
std::uint32_t Pak::name_hash(std::string_view name) {
    std::uint32_t result = 0;
    for (const unsigned char c : name) {
        result ^= c & 0xdf;
        for (unsigned bit = 0; bit < 8; ++bit)
            result = (result >> 1) ^ ((result & 1) ? 0xedb88320u : 0);
    }
    return result;
}

Pak::Pak(const DiscInput& disc, const Extent& extent, const ImportCancel& cancel) : disc_(disc), extent_(extent) {
    require(!extent.directory && extent.size >= 28 && extent.offset <= disc.size &&
                extent.size <= disc.size - extent.offset,
            "Invalid PAK extent");
    check_cancel(cancel);
    const auto tail = disc.read(extent.offset + extent.size - 12, 12);
    const Bytes footer{tail};
    const auto index_size = footer.le(0), strings_size = footer.le(4), data_size = footer.le(8);
    require(index_size >= 16 && index_size <= 16 * 1024 * 1024 && strings_size <= 16 * 1024 * 1024 &&
                std::uint64_t(data_size) + index_size + strings_size + 12 == extent.size &&
                (index_size - 16) % 100 == 0,
            "Invalid PAK index bounds");
    const auto bytes = disc.read(extent.offset + data_size, index_size);
    const Bytes index{bytes};
    require(index.text(0, 4) == "PGRP" && index.le(8) > 0 && index.le(8) <= 65535, "Unsupported PAK group header");
    for (std::size_t p = 16; p < bytes.size(); p += 100) {
        check_cancel(cancel);
        require(index.text(p, 4) == "PFIL", "Unsupported PAK file record");
        const auto id = index.le(p + 16), chunk = index.le(p + 12, 2), count = index.le(p + 14, 2);
        const auto size = index.le(p + 48), offset = index.le(p + 52), packed = index.le(p + 56),
                   source = index.le(p + 60), total = index.le(p + 64);
        require(count > 0 && count <= 2048 && chunk < count && total > 0 && total <= 128 * 1024 * 1024 && size > 0 &&
                    size <= 65536 && offset <= total && size <= total - offset && packed > 0 && source <= data_size &&
                    packed <= data_size - source,
                "Invalid PAK chunk bounds");
        auto& variants = members_[id];
        if (!chunk)
            variants.emplace_back();
        require(!variants.empty(), "Incomplete PAK member");
        auto& member = variants.back();
        if (member.chunks.empty()) {
            member.size = total;
            member.count = count;
        }
        require(member.size == total && member.count == count && member.chunks.size() == chunk &&
                    offset == (chunk ? member.chunks.back().offset + member.chunks.back().size : 0),
                "Incomplete or duplicate PAK member");
        const auto compressed = index.le(p + 84);
        const auto maximum = index.le(p + 74, 1), fill = index.le(p + 75, 1), window = index.le(p + 76, 2);
        require(index.le(p + 72, 2) == 0x2091 && index.le(p + 80) == size &&
                    (compressed ? compressed == packed : size == packed),
                "Unsupported PAK compression header");
        if (compressed)
            require(window >= 256 && window <= 32768 && std::has_single_bit(window) && maximum >= 3 &&
                        maximum < window && maximum <= (255u >> (std::countr_zero(window) - 8)) + 3,
                    "Unsupported PAK compression window");
        member.chunks.push_back({source, packed, size, offset, window, maximum, fill, compressed != 0});
    }
    std::size_t count = 0;
    for (const auto& [id, variants] : members_)
        for (const auto& member : variants) {
            ++count;
            require(member.chunks.size() == member.count &&
                        member.chunks.back().offset + member.chunks.back().size == member.size,
                    "Truncated PAK member");
        }
    require(count == index.le(8), "PAK member count disagrees with index");
}

bool Pak::contains(std::string_view name) const { return members_.contains(name_hash(name)); }

std::vector<std::uint8_t> Pak::file(std::string_view name, const ImportCancel& cancel) const {
    const auto found = members_.find(name_hash(name));
    if (found == members_.end())
        throw std::runtime_error("PAK has no " + std::string(name));
    require(found->second.size() == 1, "PAK member name is ambiguous (multiple source variants)");
    return read(found->second.front(), cancel);
}

std::vector<std::uint8_t> Pak::equivalent_file(std::string_view name, const ImportCancel& cancel) const {
    const auto found = members_.find(name_hash(name));
    if (found == members_.end())
        throw std::runtime_error("PAK has no " + std::string(name));
    require(found->second.size() <= 32, "Too many equivalent PAK resource variants");
    std::size_t total = 0;
    for (const auto& member : found->second) {
        total += member.size;
        require(total <= 16 * 1024 * 1024, "Equivalent PAK resources exceed size limit");
    }
    auto result = read(found->second.front(), cancel);
    for (std::size_t i = 1; i < found->second.size(); ++i)
        require(result == read(found->second[i], cancel), "PAK resource variants differ");
    return result;
}

std::vector<std::uint8_t> Pak::read(const Member& member, const ImportCancel& cancel) const {
    std::vector<std::uint8_t> result;
    result.reserve(member.size);
    for (const auto& chunk : member.chunks) {
        check_cancel(cancel);
        const auto data = disc_.read(extent_.offset + chunk.source, chunk.packed);
        if (!chunk.compressed) {
            result.insert(result.end(), data.begin(), data.end());
            continue;
        }
        std::vector<std::uint8_t> ring(chunk.window, std::uint8_t(chunk.fill));
        auto write = chunk.window - chunk.maximum;
        const auto mask = chunk.window - 1;
        const auto bits = std::countr_zero(chunk.window);
        std::size_t cursor = 0;
        const auto end = result.size() + chunk.size;
        const auto emit = [&](std::uint8_t value) {
            require(result.size() < end, "PAK decompression exceeds declared size");
            result.push_back(value);
            ring[write] = value;
            write = (write + 1) & mask;
        };
        while (cursor < data.size()) {
            check_cancel(cancel);
            const auto flags = data[cursor++];
            for (unsigned bit = 0; bit < 8 && cursor < data.size(); ++bit) {
                if (flags & (1u << bit))
                    emit(data[cursor++]);
                else {
                    require(data.size() - cursor >= 2, "Truncated PAK back-reference");
                    const auto a = data[cursor++], b = data[cursor++];
                    const auto source = a | ((unsigned(b) >> (16 - bits)) << 8);
                    const auto length = (unsigned(b) & (255u >> (bits - 8))) + 3;
                    require(length <= chunk.maximum, "Invalid PAK back-reference length");
                    for (unsigned i = 0; i < length; ++i)
                        emit(ring[(source + i) & mask]);
                }
            }
        }
        require(result.size() == end, "Truncated PAK compressed member");
    }
    return result;
}
} // namespace openslope::import_detail
