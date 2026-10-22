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

DiscInput logical_disc(const DiscInput& input) {
    if (input.size < 17 * 2048)
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

// [Trailmap: 200-refpack-header, 200-refpack-commands] Independent bounded
// implementation of the specified byte commands, including overlapping matches.
std::vector<std::uint8_t> decode_refpack(std::span<const std::uint8_t> input) {
    if (input.size() < 2 || input[1] != 0xfb || (input[0] & 0x7e) != 0x10)
        return {input.begin(), input.end()};
    if (input[0] & 1)
        throw std::runtime_error("RefPack optional-size field order is unsupported");
    std::size_t cursor = 2;
    const unsigned width = input[0] & 0x80 ? 4 : 3;
    const auto next = [&]() -> unsigned {
        if (cursor >= input.size())
            throw std::runtime_error("Truncated RefPack stream");
        return input[cursor++];
    };
    std::size_t size = 0;
    for (unsigned i = 0; i < width; ++i)
        size = (size << 8) | next();
    if (size > unpack_limit)
        throw std::runtime_error("RefPack output exceeds import limit");
    std::vector<std::uint8_t> output;
    output.reserve(size);
    const auto literal = [&](unsigned count) {
        if (count > input.size() - cursor || count > size - output.size())
            throw std::runtime_error("RefPack literal exceeds bounds");
        output.insert(output.end(), input.begin() + static_cast<std::ptrdiff_t>(cursor),
                      input.begin() + static_cast<std::ptrdiff_t>(cursor + count));
        cursor += count;
    };
    for (;;) {
        const auto a = next();
        unsigned literals = 0, distance = 0, count = 0;
        if (a < 0x80) {
            const auto b = next();
            literals = a & 3;
            distance = ((a & 0x60) << 3) + b + 1;
            count = ((a & 0x1c) >> 2) + 3;
        } else if (a < 0xc0) {
            const auto b = next(), c = next();
            literals = b >> 6;
            distance = ((b & 0x3f) << 8) + c + 1;
            count = (a & 0x3f) + 4;
        } else if (a < 0xe0) {
            const auto b = next(), c = next(), d = next();
            literals = a & 3;
            distance = ((a & 0x10) << 12) + (b << 8) + c + 1;
            count = ((a & 0x0c) << 6) + d + 5;
        } else if (a < 0xfc) {
            literal((a & 0x1f) * 4 + 4);
            continue;
        } else {
            literal(a & 3);
            if (output.size() != size)
                throw std::runtime_error("RefPack output size mismatch");
            return output;
        }
        literal(literals);
        if (distance > output.size() || count > size - output.size())
            throw std::runtime_error("RefPack match exceeds bounds");
        for (unsigned i = 0; i < count; ++i)
            output.push_back(output[output.size() - distance]);
    }
}
} // namespace openslope
