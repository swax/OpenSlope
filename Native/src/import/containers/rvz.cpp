#include "disc.hpp"
#include <algorithm>
#include <array>
#include <bit>
#include <cstring>
#include <memory>
#include <mutex>
#include <zstd.h>

// Independent reader of the public RVZ format description, docs/WiaAndRvz.md.
// Only GameCube images using NONE or Zstandard are admitted in this first slice.
namespace openslope::import_detail {
namespace {
constexpr std::size_t limit = 32 * 1024 * 1024;

std::uint64_t wide(Bytes b, std::size_t p) { return (std::uint64_t(b.be(p)) << 32) | b.be(p + 4); }

void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

std::array<std::uint8_t, 20> sha1(std::span<const std::uint8_t> input) {
    std::vector<std::uint8_t> data(input.begin(), input.end());
    data.push_back(0x80);
    while (data.size() % 64 != 56)
        data.push_back(0);
    const auto bits = std::uint64_t(input.size()) * 8;
    for (int shift = 56; shift >= 0; shift -= 8)
        data.push_back(std::uint8_t(bits >> shift));
    std::array<std::uint32_t, 5> state{0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0};
    for (std::size_t off = 0; off < data.size(); off += 64) {
        std::array<std::uint32_t, 80> w{};
        for (unsigned i = 0; i < 16; ++i)
            w[i] = Bytes{data}.be(off + i * 4);
        for (unsigned i = 16; i < 80; ++i)
            w[i] = std::rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
        auto [a, b, c, d, e] = state;
        for (unsigned i = 0; i < 80; ++i) {
            const auto f = i < 20   ? (b & c) | (~b & d)
                           : i < 40 ? b ^ c ^ d
                           : i < 60 ? (b & c) | (b & d) | (c & d)
                                    : b ^ c ^ d;
            const std::uint32_t k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
            const auto next = std::rotl(a, 5) + f + e + k + w[i];
            e = d;
            d = c;
            c = std::rotl(b, 30);
            b = a;
            a = next;
        }
        const std::array tail{a, b, c, d, e};
        for (unsigned i = 0; i < 5; ++i)
            state[i] += tail[i];
    }
    std::array<std::uint8_t, 20> result{};
    for (unsigned i = 0; i < 20; ++i)
        result[i] = std::uint8_t(state[i / 4] >> (24 - 8 * (i % 4)));
    return result;
}

void digest(std::span<const std::uint8_t> bytes, std::span<const std::uint8_t> expected) {
    const auto hash = sha1(bytes);
    require(std::equal(hash.begin(), hash.end(), expected.begin(), expected.end()), "RVZ header checksum mismatch");
}

struct Rvz {
    DiscInput source;
    unsigned compression{}, chunk{};
    std::uint64_t size{};
    std::array<std::uint8_t, 128> header{};

    struct Raw {
        std::uint64_t start, size;
        unsigned group, count;
    };

    struct Group {
        std::uint64_t offset;
        unsigned bytes, packed;
        bool compressed;
    };

    std::vector<Raw> raw;
    std::vector<Group> groups;

    struct Cached {
        std::size_t index = SIZE_MAX;
        std::vector<std::uint8_t> bytes;
        std::uint64_t age{};
    };

    std::array<Cached, 4> cache;
    std::uint64_t age{};
    std::mutex mutex;

    std::vector<std::uint8_t> decompress(std::span<const std::uint8_t> data, std::size_t maximum) const {
        require(maximum <= limit, "RVZ decoded block exceeds limit");
        if (!compression) {
            require(data.size() <= maximum, "Oversized uncompressed RVZ block");
            return {data.begin(), data.end()};
        }
        std::vector<std::uint8_t> output(maximum);
        const auto n = ZSTD_decompress(output.data(), output.size(), data.data(), data.size());
        require(!ZSTD_isError(n), "Invalid or oversized Zstandard RVZ block");
        output.resize(n);
        return output;
    }

    explicit Rvz(DiscInput input) : source(std::move(input)) {
        const auto head = source.read(0, 0x48);
        Bytes h{head};
        require(h.be(8) <= 0x01000000 && h.be(4) >= h.be(8), "Unsupported RVZ version");
        digest(std::span(head).first(0x34), std::span(head).subspan(0x34, 20));
        require(h.be(12) >= 0xd5 && h.be(12) <= 4096 && wide(h, 0x2c) == source.size, "Invalid RVZ header size");
        size = wide(h, 0x24);
        require(size >= 0x440 && size <= 2ULL * 1024 * 1024 * 1024, "Unsupported RVZ logical disc size");
        const auto desc = source.read(0x48, h.be(12));
        digest(desc, std::span(head).subspan(0x10, 20));
        Bytes d{desc};
        compression = d.be(4);
        chunk = d.be(12);
        require(d.be(0) == 1 && d.be(0x90) == 0, "Only GameCube RVZ images are supported");
        require(compression == 0 || compression == 5,
                "RVZ needs NONE or Zstandard compression; recompress this image in Dolphin");
        require(chunk >= 32768 && chunk <= limit &&
                    (chunk < 0x200000 ? std::has_single_bit(chunk) : chunk % 0x200000 == 0),
                "Invalid RVZ chunk size");
        std::copy_n(desc.begin() + 16, header.size(), header.begin());
        const auto nr = d.be(0xb4), ng = d.be(0xc4);
        require(nr > 0 && nr <= 1024 && ng > 0 && ng <= 1000000, "Invalid RVZ table count");
        require(d.be(0xc0) <= limit && d.be(0xd0) <= limit, "RVZ compressed table exceeds limit");
        const auto raw_bytes = decompress(source.read(wide(d, 0xb8), d.be(0xc0)), std::size_t(nr) * 24);
        const auto group_bytes = decompress(source.read(wide(d, 0xc8), d.be(0xd0)), std::size_t(ng) * 12);
        require(raw_bytes.size() == nr * 24 && group_bytes.size() == ng * 12, "Invalid RVZ table length");
        Bytes r{raw_bytes}, g{group_bytes};
        for (unsigned i = 0; i < nr; ++i) {
            Raw row{wide(r, i * 24), wide(r, i * 24 + 8), r.be(i * 24 + 16), r.be(i * 24 + 20)};
            require(row.start <= size && row.size <= size - row.start && row.group <= ng && row.count <= ng - row.group,
                    "RVZ raw extent is out of bounds");
            const auto aligned = row.start & ~std::uint64_t(32767);
            require(row.count == (row.start - aligned + row.size + chunk - 1) / chunk && row.size > 0,
                    "Invalid RVZ raw group coverage");
            if (!raw.empty())
                require(row.start == raw.back().start + raw.back().size, "Noncontiguous RVZ raw extents");
            raw.push_back(row);
        }
        require(raw.front().start <= 128 && raw.back().start + raw.back().size == size, "Incomplete RVZ disc coverage");
        for (unsigned i = 0; i < ng; ++i) {
            const auto flags = g.be(i * 12 + 4);
            Group row{std::uint64_t(g.be(i * 12)) * 4, flags & 0x7fffffff, g.be(i * 12 + 8), bool(flags >> 31)};
            require(row.offset <= source.size && row.bytes <= source.size - row.offset && row.bytes <= limit &&
                        row.packed <= limit,
                    "RVZ group extent is out of bounds");
            groups.push_back(row);
        }
    }

    const std::vector<std::uint8_t>& group(std::size_t index, std::uint64_t origin, std::size_t expected) {
        for (auto& item : cache)
            if (item.index == index) {
                require(item.bytes.size() == expected, "Conflicting RVZ shared group lengths");
                item.age = ++age;
                return item.bytes;
            }
        const auto& row = groups.at(index);
        std::vector<std::uint8_t> bytes;
        if (!row.bytes)
            bytes.resize(expected);
        else {
            bytes = source.read(row.offset, row.bytes);
            if (row.compressed)
                bytes = decompress(bytes, row.packed ? row.packed : expected);
            if (row.packed) {
                require(bytes.size() == row.packed, "RVZ packed length mismatch");
                Bytes b{bytes};
                std::vector<std::uint8_t> output;
                output.reserve(expected);
                std::size_t at = 0;
                while (at < bytes.size()) {
                    const auto flags = b.be(at);
                    at += 4;
                    const auto count = flags & 0x7fffffff;
                    require(count > 0 && count <= expected - output.size(), "Invalid RVZ packed run");
                    if (!(flags >> 31)) {
                        b.range(at, count);
                        output.insert(output.end(), bytes.begin() + std::ptrdiff_t(at),
                                      bytes.begin() + std::ptrdiff_t(at + count));
                        at += count;
                    } else {
                        b.range(at, 68);
                        std::array<std::uint32_t, 521> state{};
                        for (unsigned i = 0; i < 17; ++i)
                            state[i] = b.be(at + i * 4);
                        at += 68;
                        for (unsigned i = 17; i < 521; ++i)
                            state[i] = (state[i - 17] << 23) ^ (state[i - 16] >> 9) ^ state[i - 1];
                        const auto advance = [&] {
                            for (unsigned i = 0; i < 521; ++i)
                                state[i] ^= state[(i + 489) % 521];
                        };
                        for (unsigned i = 0; i < 4; ++i)
                            advance();
                        const auto skip = std::size_t((origin + output.size()) % 32768);
                        std::size_t emitted = 0;
                        while (emitted < skip + count) {
                            for (auto word : state) {
                                const std::array<std::uint8_t, 4> value{std::uint8_t(word >> 24),
                                                                        std::uint8_t(word >> 18),
                                                                        std::uint8_t(word >> 8), std::uint8_t(word)};
                                for (auto v : value) {
                                    if (emitted >= skip && emitted < skip + count)
                                        output.push_back(v);
                                    ++emitted;
                                }
                            }
                            advance();
                        }
                    }
                }
                bytes = std::move(output);
            }
            require(bytes.size() == expected, "RVZ decoded group length mismatch");
        }
        auto& target =
            *std::min_element(cache.begin(), cache.end(), [](const auto& a, const auto& b) { return a.age < b.age; });
        target = {index, std::move(bytes), ++age};
        return target.bytes;
    }

    void read(std::uint64_t offset, std::span<std::uint8_t> target) {
        const std::lock_guard lock(mutex);
        require(offset <= size && target.size() <= size - offset, "RVZ read outside disc");
        while (!target.empty()) {
            if (offset < 128) {
                const auto n = std::min(target.size(), std::size_t(128 - offset));
                std::copy_n(header.begin() + std::ptrdiff_t(offset), n, target.begin());
                target = target.subspan(n);
                offset += n;
                continue;
            }
            const auto found = std::find_if(raw.begin(), raw.end(), [&](const auto& row) {
                return offset >= row.start && offset - row.start < row.size;
            });
            require(found != raw.end(), "RVZ read in an unmapped extent");
            const auto base = found->start & ~std::uint64_t(32767), relative = offset - base;
            const auto ordinal = relative / chunk;
            const auto within = std::size_t(relative % chunk);
            const auto origin = base + ordinal * chunk;
            const auto expected = std::size_t(std::min(std::uint64_t(chunk), found->start + found->size - origin));
            const auto& data = group(found->group + std::size_t(ordinal), origin, expected);
            const auto n =
                std::min({target.size(), data.size() - within, std::size_t(found->start + found->size - offset)});
            require(n > 0, "Empty RVZ extent");
            std::copy_n(data.begin() + std::ptrdiff_t(within), n, target.begin());
            target = target.subspan(n);
            offset += n;
        }
    }
};
} // namespace

DiscInput rvz_disc(const DiscInput& source) {
    if (source.size < 4 || Bytes{source.read(0, 4)}.be(0) != 0x52565a01)
        return source;
    auto reader = std::make_shared<Rvz>(source);
    return {reader->size,
            [reader](std::uint64_t offset, std::span<std::uint8_t> target) { reader->read(offset, target); }};
}
} // namespace openslope::import_detail
