#include "openslope/import.hpp"
#include <stdexcept>

namespace openslope {
namespace {
constexpr std::size_t unpack_limit = 128 * 1024 * 1024;
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
