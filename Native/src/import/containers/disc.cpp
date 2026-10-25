#include "disc.hpp"
#include "openslope/import.hpp"
#include <algorithm>
#include <cctype>
#include <fstream>
#include <memory>
#include <stdexcept>

namespace openslope {
namespace {
constexpr std::size_t unpack_limit = 128 * 1024 * 1024;
}

std::vector<std::uint8_t> DiscInput::read(std::uint64_t offset, std::size_t length) const {
    if (offset > size || length > size - offset || length > unpack_limit)
        throw std::runtime_error("Disc extent is outside the image or exceeds the import limit");
    std::vector<std::uint8_t> bytes(length);
    read_at(offset, bytes);
    return bytes;
}

DiscInput open_disc(const std::filesystem::path& path) {
    auto stream = std::make_shared<std::ifstream>(path, std::ios::binary);
    if (!*stream)
        throw std::runtime_error("Cannot open disc image");
    const auto length = std::filesystem::file_size(path);
    return {length, [stream](std::uint64_t offset, std::span<std::uint8_t> bytes) {
                stream->clear();
                stream->seekg(static_cast<std::streamoff>(offset));
                stream->read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
                if (!*stream)
                    throw std::runtime_error("Disc image read failed or was truncated");
            }};
}

DiscInput logical_disc(const DiscInput& source) {
    const auto input = import_detail::rvz_disc(source);
    if (input.size < 17 * 2048 || import_detail::gamecube_disc(input))
        return input;
    const auto plain = input.read(16 * 2048, 7);
    if (std::string(plain.begin() + 1, plain.begin() + 6) == "CD001")
        return input;
    if (input.size < 17 * 2352 || input.size % 2352)
        return input;
    const auto raw = input.read(16 * 2352, 31);
    if (std::string(raw.begin() + 25, raw.begin() + 30) != "CD001")
        return input;
    return {input.size / 2352 * 2048, [input](std::uint64_t offset, std::span<std::uint8_t> bytes) {
                while (!bytes.empty()) {
                    const auto sector = offset / 2048;
                    const auto within = std::size_t(offset % 2048);
                    const auto logical = std::min(bytes.size(), 128 * 2048 - within);
                    const auto sectors = (within + logical + 2047) / 2048;
                    // Batch physical reads: FileReaderSync/Android document IO
                    // would otherwise need two host calls for every CD sector.
                    const auto chunk = input.read(sector * 2352, sectors * 2352);
                    for (std::size_t i = 0; i < sectors; ++i) {
                        const auto header = std::span(chunk).subspan(i * 2352, 24);
                        if (header[0] || header[11] || header[15] != 2 || (header[18] & 0x20) ||
                            !std::all_of(header.begin() + 1, header.begin() + 11, [](auto v) { return v == 255; }) ||
                            !std::equal(header.begin() + 16, header.begin() + 20, header.begin() + 20))
                            throw std::runtime_error("Unsupported or corrupt Mode 2 Form 1 sector");
                        const auto skip = i ? 0 : within;
                        const auto count = std::min(bytes.size(), 2048 - skip);
                        std::copy_n(chunk.begin() + std::ptrdiff_t(i * 2352 + 24 + skip), count, bytes.begin());
                        offset += count;
                        bytes = bytes.subspan(count);
                    }
                }
            }};
}

} // namespace openslope
