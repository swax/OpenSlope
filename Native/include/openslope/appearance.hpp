#pragma once
#include "terrain.hpp"
#include <map>
#include <span>

namespace openslope {
struct RgbaImage { unsigned width{},height{};std::vector<std::uint8_t> pixels; };
// Shared map PNGs are already display-ready. Preserve their byte-domain colour
// and the full lightmap RGBA payload, without applying another brighten or gamma.
RgbaImage read_png(const std::filesystem::path& path);
// Byte-domain area averages; alpha weights colour for straight-alpha textures.
std::vector<RgbaImage> diffuse_mips(const RgbaImage& base);
std::vector<std::string> referenced_images(const Terrain& terrain);
struct Appearance {
    std::map<std::string,RgbaImage> images;
    std::vector<std::string> missing;
    static Appearance load(const std::filesystem::path& root,std::span<const MeshBatch> batches);
    static Appearance load(const Terrain& terrain);
};
// [Trailmap: 160-luminance, 400-lighting] Normalized portable map values.
std::array<double,3> terrain_light(std::array<double,3> base,std::array<double,4> lightmap);
}
