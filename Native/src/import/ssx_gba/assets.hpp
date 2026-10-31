#pragma once
#include "import/shared.hpp"
#include "openslope/math.hpp"
#include <array>
#include <nlohmann/json.hpp>

namespace openslope::import_detail::gba {
using Json = nlohmann::json;
inline constexpr unsigned archive_offset = 0x2905c, directory_offset = 0x28606, names_offset = 0x28646,
                          name_lookup_offset = 0x28b64;
inline constexpr double metres_per_unit = .1;
void require(bool condition, const char* message);
void save(const std::filesystem::path& path, const Json& value);
Json raw(Vec3 point);

struct Resource {
    std::uint64_t offset;
    unsigned size, flags;
};

struct Course {
    unsigned index, geometry, textures, background;
    std::string id, title;
};

struct Rom {
    DiscInput source;
    std::vector<Resource> resources;
    std::vector<Course> courses;
    explicit Rom(const DiscInput& source, const ImportCancel& cancel);
    std::vector<std::uint8_t> resource(unsigned id) const;
};

std::vector<std::uint8_t> lzss(std::span<const std::uint8_t> data, std::size_t expected, const ImportCancel& cancel,
                               bool padded = false);

struct Record {
    unsigned tag;
    std::array<unsigned, 3> vertices;
    unsigned last;
};

struct Geometry {
    std::vector<Vec3> points, route;
    std::vector<Record> records;
    Vec3 centre;
    explicit Geometry(std::span<const std::uint8_t> data, const ImportCancel& cancel);
};

struct Textures {
    std::vector<unsigned> flags;
    std::vector<std::uint16_t> palette;
    Image opaque, keyed;
    explicit Textures(std::span<const std::uint8_t> data, const ImportCancel& cancel);
    std::array<double, 2> uv(unsigned material, double u, double v, bool colour = false) const;
};

void write_course(const Rom& rom, const Course& course, const std::filesystem::path& output,
                  const ImportProgress& progress, const ImportCancel& cancel);
void write_audio(const Rom& rom, const std::filesystem::path& output, const ImportCancel& cancel);
void write_music(const Rom& rom, const Course& course, const std::filesystem::path& output,
                 const ImportProgress& progress, const ImportCancel& cancel);
Json write_sky(const Rom& rom, const Course& course, const std::filesystem::path& output, const ImportCancel& cancel);
} // namespace openslope::import_detail::gba
