#pragma once
#include "import_internal.hpp"
#include <algorithm>
#include <optional>

namespace openslope::executable_detail {
using import_detail::Bytes;
constexpr std::uint32_t record_base = 0x40000000, stack_base = 0x7ffef000;
constexpr std::size_t record_limit = 8192;

struct Segment {
    std::uint32_t offset{}, address{}, size{}, memory{}, flags{};
};

struct Range {
    std::size_t begin{}, end{};
};

struct Executable {
    Bytes bytes;
    std::vector<Segment> segments;
    std::vector<Range> text;
    std::optional<std::uint32_t> gp;

    explicit Executable(std::span<const std::uint8_t> data) : bytes{data} {
        if (data.size() < 52 || data.size() > 64 * 1024 * 1024 || bytes.le(0, 1) != 127 || bytes.text(1, 3) != "ELF" ||
            bytes.le(4, 1) != 1 || bytes.le(5, 1) != 1 || bytes.le(6, 1) != 1 || bytes.le(16, 2) != 2 ||
            bytes.le(18, 2) != 8 || bytes.le(20) != 1 || bytes.le(40, 2) != 52)
            throw std::runtime_error("Unsupported executable container");
        const auto ph = bytes.le(28), stride = bytes.le(42, 2), count = bytes.le(44, 2);
        if (stride < 32 || count == 0 || count > 64)
            throw std::runtime_error("Invalid executable load table");
        bytes.range(ph, std::size_t(stride) * count);
        for (unsigned i = 0; i < count; ++i) {
            const auto p = std::size_t(ph) + i * stride;
            if (bytes.le(p) != 1)
                continue;
            Segment s{bytes.le(p + 4), bytes.le(p + 8), bytes.le(p + 16), bytes.le(p + 20), bytes.le(p + 24)};
            if (s.size > s.memory || s.memory > 128 * 1024 * 1024 ||
                std::uint64_t(s.address) + s.memory > 0x100000000ULL)
                throw std::runtime_error("Invalid executable load extent");
            bytes.range(s.offset, s.size);
            for (const auto& previous : segments)
                if (std::uint64_t(s.address) < std::uint64_t(previous.address) + previous.memory &&
                    std::uint64_t(previous.address) < std::uint64_t(s.address) + s.memory)
                    throw std::runtime_error("Overlapping executable load extents");
            for (const auto base : {record_base, stack_base})
                if (std::uint64_t(s.address) < std::uint64_t(base) + record_limit &&
                    std::uint64_t(s.address) + s.memory > base)
                    throw std::runtime_error("Executable overlaps isolated initializer storage");
            segments.push_back(s);
        }
        if (segments.empty())
            throw std::runtime_error("Executable has no loadable data");
        const auto sh = bytes.le(32), ss = bytes.le(46, 2), sc = bytes.le(48, 2);
        if (sh) {
            if (ss < 40 || sc > 1024)
                throw std::runtime_error("Invalid executable section table");
            bytes.range(sh, std::size_t(ss) * sc);
            for (unsigned i = 0; i < sc; ++i) {
                const auto p = std::size_t(sh) + i * ss, offset = std::size_t(bytes.le(p + 16)),
                           length = std::size_t(bytes.le(p + 20));
                if (bytes.le(p + 4) == 0x70000006 && length >= 24) {
                    bytes.range(offset, 24);
                    gp = bytes.le(offset + 20);
                }
                if (bytes.le(p + 4) == 1 && (bytes.le(p + 8) & 4) && length) {
                    bytes.range(offset, length);
                    if (offset % 4 || length % 4)
                        throw std::runtime_error("Unaligned executable code section");
                    const auto address = bytes.le(p + 12);
                    if (std::none_of(segments.begin(), segments.end(), [&](const auto& segment) {
                            return (segment.flags & 1) && offset >= segment.offset && address >= segment.address &&
                                   offset - segment.offset == address - segment.address &&
                                   offset + length <= std::size_t(segment.offset) + segment.size;
                        }))
                        throw std::runtime_error("Executable code section is outside its load extent");
                    text.push_back({offset, offset + length});
                }
            }
        }
        if (text.empty())
            for (const auto s : segments)
                if (s.flags & 1) {
                    if (s.offset % 4 || s.size % 4)
                        throw std::runtime_error("Unaligned executable code extent");
                    text.push_back({s.offset, std::size_t(s.offset) + s.size});
                }
        std::sort(text.begin(), text.end(), [](auto a, auto b) { return a.begin < b.begin; });
        for (std::size_t i = 1; i < text.size(); ++i)
            if (text[i].begin < text[i - 1].end)
                throw std::runtime_error("Overlapping executable code ranges");
    }

    std::optional<std::uint8_t> read(std::uint32_t address) const {
        for (const auto s : segments)
            if (address >= s.address && std::uint64_t(address) - s.address < s.memory) {
                const auto at = address - s.address;
                return at < s.size ? bytes.data[std::size_t(s.offset) + at] : 0;
            }
        return {};
    }
};

struct BootExecutable {
    std::string name;
    std::vector<std::uint8_t> bytes;
};

std::optional<BootExecutable> boot_executable(const DiscInput& disc, const ImportCancel& cancelled);
} // namespace openslope::executable_detail
