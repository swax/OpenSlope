#include "assets.hpp"
#include <algorithm>
#include <cctype>
#include <fstream>
#include <map>
#include <set>

namespace openslope::import_detail::gba {
void require(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

void save(const std::filesystem::path& path, const Json& document) {
    std::ofstream file(path, std::ios::binary);
    file << document.dump() << '\n';
    require(bool(file), "Cannot write GBA map document");
}

Json raw(Vec3 p) { return {p.x * 100, -p.z * 100, p.y * 100}; }

Rom::Rom(const DiscInput& disc, const ImportCancel& cancel) : source(disc) {
    require(source.size >= archive_offset + 4 && source.size <= 32 * 1024 * 1024, "Unsupported GBA ROM extent");
    const auto header = source.read(0xa0, 32);
    const Bytes h{header};
    require(h.text(12, 4) == "AXYE" && h.le(18, 1) == 0x96 && h.le(28, 1) == 0,
            "Unsupported SSX Tricky GBA revision (expected AXYE revision 0)");
    unsigned checksum = 0x19;
    for (unsigned i = 0; i < 30; ++i)
        checksum += header[i];
    require((checksum & 255) == 0, "Invalid GBA header checksum");
    const auto count = source.read(archive_offset, 4);
    require(Bytes{count}.le(0) == 215, "Unsupported SSX GBA resource directory");
    const auto bytes = source.read(archive_offset + 4, 215 * 16);
    const Bytes b{bytes};
    std::uint64_t end = archive_offset + 4 + bytes.size();
    for (unsigned i = 0; i < 215; ++i) {
        check_cancel(cancel);
        const auto p = i * 16, flags = b.le(p), length = b.le(p + 4);
        const auto offset = std::uint64_t(archive_offset) + b.le(p + 8);
        require((flags == 1 || flags == 0x12345678) && !b.le(p + 12) && offset == end && offset <= source.size &&
                    length <= source.size - offset,
                "Invalid GBA resource extent");
        resources.push_back({offset, length, flags});
        end = offset + length;
    }
    const auto directory = source.read(directory_offset, name_lookup_offset + 8 - directory_offset);
    const Bytes d{directory};
    std::set<unsigned> names;
    const std::map<std::string, std::string> titles{{"GARIBALDI", "Garibaldi"},       {"SNOWDREAM", "Snowdream"},
                                                    {"ELYSIUM ALPS", "Elysium Alps"}, {"MESABLANCA", "Mesablanca"},
                                                    {"MERQURY", "Merqury City"},      {"MEGAPLEX", "Tokyo Megaplex"},
                                                    {"ALOHA", "Aloha Ice Jam"},       {"ALASKA", "Alaska"}};
    for (unsigned i = 0; i < 8; ++i) {
        const auto index = d.le(name_lookup_offset - directory_offset + i, 1);
        require(index < 8 && names.insert(index).second, "Invalid GBA course-name lookup");
        auto name = d.text(names_offset - directory_offset + index * 16, 16);
        const auto nul = name.find('\0');
        require(nul != name.npos, "Unterminated GBA course name");
        name.resize(nul);
        while (!name.empty() && name.back() == ' ')
            name.pop_back();
        const auto title = titles.find(name);
        require(title != titles.end(), "Unknown GBA course name");
        std::string id = "SSXGBA_" + title->second;
        for (auto& c : id)
            c = c == ' ' ? '_' : char(std::toupper(static_cast<unsigned char>(c)));
        const auto geo = d.le(i * 8, 2), tex = d.le(i * 8 + 2, 2), sky = d.le(i * 8 + 4, 2);
        require(geo < resources.size() && tex < resources.size() && sky < resources.size() && !d.le(i * 8 + 6, 2),
                "Invalid GBA course resources");
        require(Bytes{source.read(resources[geo].offset, 4)}.le(0) == 0x4754524b &&
                    Bytes{source.read(resources[tex].offset, 4)}.le(0) == 0x54544558,
                "Invalid GBA course resource identity");
        courses.push_back({i, geo, tex, sky, id, title->second});
    }
}

std::vector<std::uint8_t> Rom::resource(unsigned id) const {
    require(id < resources.size(), "GBA resource index out of bounds");
    const auto& r = resources[id];
    return source.read(r.offset, r.size);
}

// [Trailmap: 610-art] Zero-filled ring, absolute references and overlapping copies.
std::vector<std::uint8_t> lzss(std::span<const std::uint8_t> data, std::size_t expected, const ImportCancel& cancel,
                               bool padded) {
    require(expected <= 16 * 1024 * 1024, "GBA decompression exceeds limit");
    std::array<std::uint8_t, 4096> ring{};
    unsigned cursor = 0xfee;
    std::size_t at = 0;
    std::vector<std::uint8_t> result;
    result.reserve(expected);
    const auto limit = expected + (padded ? 32 : 0);
    while (at < data.size() && result.size() < limit) {
        check_cancel(cancel);
        const auto flags = data[at++];
        for (unsigned bit = 0; bit < 8 && at < data.size() && result.size() < limit; ++bit) {
            unsigned count = 1, source = 0;
            if (!(flags & (1 << bit))) {
                if (padded && data.size() - at == 1) {
                    ++at;
                    break;
                }
                require(data.size() - at >= 2, "Truncated GBA LZSS copy");
                source = data[at] | ((data[at + 1] & 240) << 4);
                count = (data[at + 1] & 15) + 3;
                at += 2;
            }
            require(count <= limit - result.size(), "GBA LZSS copy exceeds expanded size");
            for (unsigned j = 0; j < count; ++j) {
                const auto value = flags & (1 << bit) ? data[at++] : ring[(source + j) & 4095];
                result.push_back(value);
                ring[cursor] = value;
                cursor = (cursor + 1) & 4095;
            }
        }
    }
    require((padded ? result.size() >= expected : result.size() == expected) && at == data.size(),
            "GBA LZSS extent mismatch");
    return result;
}

Geometry::Geometry(std::span<const std::uint8_t> data, const ImportCancel& cancel) {
    const Bytes b{data};
    require(b.le(0) == 0x4754524b, "Missing GBA GTRK geometry");
    const auto ns = b.le(4), nv = b.le(8), nr = b.le(12), so = b.le(16), vo = b.le(20), po = b.le(24);
    require(ns > 1 && ns <= 65536 && nv > 2 && nv <= 65536 && nr <= 250000 && so == 36 && vo == 36 + ns * 20 &&
                po >= vo + nv * 6 && po - vo - nv * 6 <= 4 && b.le(28) == nr * 10 && b.le(32) == nr * 10,
            "Invalid GBA geometry tables");
    b.range(so, ns * 20);
    b.range(vo, nv * 6);
    b.range(po, nr * 10);
    Vec3 lo{32767, 32767, 32767}, hi{-32768, -32768, -32768};
    for (unsigned i = 0; i < nv; ++i) {
        check_cancel(cancel);
        Vec3 p{double(b.signed16(vo + i * 6)), double(b.signed16(vo + i * 6 + 2)), double(b.signed16(vo + i * 6 + 4))};
        points.push_back(p);
        lo = {std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z)};
        hi = {std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z)};
    }
    centre = (lo + hi) * .5;
    const auto world = [&](Vec3 p) {
        p = (p - centre) * metres_per_unit;
        p.z = -p.z;
        return p;
    };
    for (auto& p : points)
        p = world(p);
    for (unsigned i = 0; i < ns; ++i) {
        const auto p = so + i * 20;
        bool active = false;
        for (unsigned j = 0; j < 20; ++j)
            active |= data[p + j] != 0;
        if (active)
            route.push_back(
                world({double(b.signed16(p + 10)), double(b.signed16(p + 12)), double(b.signed16(p + 14))}));
    }
    require(route.size() >= 2, "GBA course has no section route");
    for (unsigned i = 0; i < nr; ++i) {
        const auto p = po + i * 10;
        Record row{b.le(p, 2), {b.le(p + 2, 2), b.le(p + 4, 2), b.le(p + 6, 2)}, b.le(p + 8, 2)};
        const auto kind = row.tag & 63;
        require(kind <= 7, "Unknown GBA primitive kind");
        const auto count = kind == 6 ? 2u : 3u;
        for (unsigned j = 0; j < count; ++j)
            require(row.vertices[j] < nv, "GBA vertex index out of bounds");
        if (kind == 0 || kind == 1 || kind == 5)
            require(row.last < nv, "GBA quad vertex index out of bounds");
        records.push_back(row);
    }
}

Textures::Textures(std::span<const std::uint8_t> data, const ImportCancel& cancel) {
    const Bytes b{data};
    require(b.le(0) == 0x54544558, "Missing GBA TTEX textures");
    const auto n = b.le(4), desc = b.le(8), colours = b.le(12), pal = b.le(16);
    require(n > 0 && n <= 256 && desc == 44 && colours == 192 && pal == desc + n * 8, "Invalid GBA texture directory");
    b.range(pal, colours * 2);
    unsigned shared = 0;
    bool ordinary = false;
    for (unsigned i = 0; i < n; ++i) {
        const auto flag = b.le(desc + i * 8 + 5, 1);
        flags.push_back(flag);
        if (flag & 1) {
            require(!ordinary, "Non-prefix GBA shared texture pool");
            ++shared;
        } else
            ordinary = true;
    }
    for (unsigned i = 0; i < colours; ++i)
        palette.push_back(std::uint16_t(b.le(pal + i * 2, 2)));
    std::vector<std::uint8_t> pixels;
    for (unsigned pool = 0; pool < 2; ++pool) {
        const auto p = 20 + pool * 12, at = b.le(p), expanded = b.le(p + 4), packed = b.le(p + 8);
        require(expanded == (pool ? n - shared : shared) * 1024, "Invalid GBA texture pool size");
        b.range(at, packed);
        const auto decoded = lzss(data.subspan(at, packed), expanded, cancel);
        pixels.insert(pixels.end(), decoded.begin(), decoded.end());
    }
    opaque = {"gba-opaque", 512, ((n + 15) / 16) * 32 + 1, {}};
    opaque.rgba.resize(opaque.width * opaque.height * 4);
    keyed = opaque;
    keyed.name = "gba-keyed";
    const auto put = [&](Image& image, unsigned x, unsigned y, unsigned colour, bool transparent) {
        require(colour < palette.size(), "GBA palette index out of bounds");
        const auto word = palette[colour];
        const auto at = (y * image.width + x) * 4;
        for (unsigned a = 0; a < 3; ++a) {
            const auto v = (word >> (a * 5)) & 31;
            image.rgba[at + a] = std::uint8_t((v << 3) | (v >> 2));
        }
        image.rgba[at + 3] = transparent && colour == 0 ? 0 : 255;
    };
    for (unsigned i = 0; i < n; ++i)
        for (unsigned y = 0; y < 32; ++y)
            for (unsigned x = 0; x < 32; ++x) {
                const auto colour = pixels[i * 1024 + y * 32 + x];
                put(opaque, (i % 16) * 32 + x, (i / 16) * 32 + y, colour, false);
                put(keyed, (i % 16) * 32 + x, (i / 16) * 32 + y, colour, true);
            }
    for (unsigned i = 0; i < colours; ++i) {
        put(opaque, i, opaque.height - 1, i, false);
        put(keyed, i, keyed.height - 1, i, false);
    }
}

std::array<double, 2> Textures::uv(unsigned material, double u, double v, bool colour) const {
    require(material < (colour ? palette.size() : flags.size()), "Invalid GBA primitive material");
    return colour ? std::array<double, 2>{(material + .5) / opaque.width, (opaque.height - .5) / opaque.height}
                  : std::array<double, 2>{((material % 16) * 32 + u + .5) / opaque.width,
                                          ((material / 16) * 32 + v + .5) / opaque.height};
}
} // namespace openslope::import_detail::gba
