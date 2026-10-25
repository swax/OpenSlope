#include "shared.hpp"
#include <algorithm>
#include <array>
#include <fstream>

namespace openslope::import_detail {
namespace {
void append_be(std::vector<std::uint8_t>& bytes, std::uint32_t v) {
    for (int shift = 24; shift >= 0; shift -= 8)
        bytes.push_back(static_cast<std::uint8_t>(v >> shift));
}

std::uint32_t crc(std::span<const std::uint8_t> bytes) {
    static constexpr auto table = [] {
        std::array<std::uint32_t, 256> values{};
        for (std::uint32_t i = 0; i < values.size(); ++i) {
            auto v = i;
            for (unsigned bit = 0; bit < 8; ++bit)
                v = (v >> 1) ^ ((v & 1) ? 0xedb88320 : 0);
            values[i] = v;
        }
        return values;
    }();
    std::uint32_t v = 0xffffffff;
    for (auto b : bytes)
        v = (v >> 8) ^ table[(v ^ b) & 255];
    return ~v;
}

void chunk(std::ofstream& file, const char* type, std::span<const std::uint8_t> bytes) {
    std::vector<std::uint8_t> block;
    append_be(block, static_cast<std::uint32_t>(bytes.size()));
    block.insert(block.end(), type, type + 4);
    block.insert(block.end(), bytes.begin(), bytes.end());
    const auto checksum = crc(std::span(block).subspan(4));
    append_be(block, checksum);
    file.write(reinterpret_cast<const char*>(block.data()), static_cast<std::streamsize>(block.size()));
}
} // namespace

// PNG byte compression is not part of the portable pixel contract.
void write_png(const std::filesystem::path& path, const Image& image) {
    std::ofstream file(path, std::ios::binary);
    const std::array<std::uint8_t, 8> signature = {137, 80, 78, 71, 13, 10, 26, 10};
    file.write(reinterpret_cast<const char*>(signature.data()), 8);
    std::vector<std::uint8_t> header;
    append_be(header, image.width);
    append_be(header, image.height);
    header.insert(header.end(), {8, 6, 0, 0, 0});
    chunk(file, "IHDR", header);
    std::vector<std::uint8_t> scanlines;
    scanlines.reserve(image.rgba.size() + image.height);
    for (unsigned y = 0; y < image.height; ++y) {
        scanlines.push_back(0);
        const auto start = std::size_t(y) * image.width * 4;
        scanlines.insert(scanlines.end(), image.rgba.begin() + static_cast<std::ptrdiff_t>(start),
                         image.rgba.begin() + static_cast<std::ptrdiff_t>(start + image.width * 4));
    }
    std::vector<std::uint8_t> compressed = {0x78, 0x01};
    compressed.reserve(6 + scanlines.size() + ((scanlines.size() + 65534) / 65535) * 5);
    std::uint32_t a = 1, b = 0;
    // 5552 bytes is the largest batch that cannot overflow 32-bit Adler sums.
    for (std::size_t p = 0; p < scanlines.size();) {
        const auto end = std::min(p + 5552, scanlines.size());
        for (; p < end; ++p) {
            a += scanlines[p];
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    for (std::size_t p = 0; p < scanlines.size();) {
        const auto size = std::min<std::size_t>(65535, scanlines.size() - p);
        compressed.push_back(p + size == scanlines.size() ? 1 : 0);
        compressed.push_back(static_cast<std::uint8_t>(size));
        compressed.push_back(static_cast<std::uint8_t>(size >> 8));
        const auto complement = static_cast<std::uint16_t>(~size);
        compressed.push_back(static_cast<std::uint8_t>(complement));
        compressed.push_back(static_cast<std::uint8_t>(complement >> 8));
        compressed.insert(compressed.end(), scanlines.begin() + static_cast<std::ptrdiff_t>(p),
                          scanlines.begin() + static_cast<std::ptrdiff_t>(p + size));
        p += size;
    }
    append_be(compressed, (b << 16) | a);
    chunk(file, "IDAT", compressed);
    chunk(file, "IEND", {});
    if (!file)
        throw std::runtime_error("Cannot write texture PNG");
}
} // namespace openslope::import_detail
