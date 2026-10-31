#include "assets.hpp"
#include <fstream>
#include <iomanip>

namespace openslope::import_detail::gba {
Json write_sky(const Rom& rom, const Course& course, const std::filesystem::path& output, const ImportCancel& cancel) {
    const auto source = rom.resource(course.background);
    require(Bytes{source}.le(0) == 0x01234567, "Unknown GBA horizon compression");
    const auto decoded = lzss(std::span(source).subspan(4), 8704, cancel, true);
    const Bytes b{decoded};
    Image panorama{"gba-horizon", 1024, 512, {}};
    panorama.rgba.resize(panorama.width * panorama.height * 4);
    for (unsigned y = 0; y < panorama.height; ++y)
        for (unsigned x = 0; x < panorama.width; ++x) {
            std::array<std::uint8_t, 4> colour{184, 218, 242, 255};
            if (y >= 224 && y < 352) {
                const auto sx = x / 4, sy = (y - 224) / 2, tile = (sx / 64) * 64 + (sy / 8) * 8 + (sx % 64) / 8,
                           index = tile * 64 + (sy % 8) * 8 + sx % 8;
                const auto packed = decoded[512 + index / 2];
                const auto palette = (packed >> ((index % 2) * 4)) & 15;
                if (palette) {
                    const auto word = b.le(palette * 2, 2);
                    for (unsigned a = 0; a < 3; ++a) {
                        const auto v = (word >> (a * 5)) & 31;
                        colour[a] = std::uint8_t((v << 3) | (v >> 2));
                    }
                }
            }
            if (y >= 352)
                colour = {210, 226, 239, 255};
            std::copy(colour.begin(), colour.end(), panorama.rgba.begin() + (y * panorama.width + x) * 4);
        }
    const auto sky = output / "Skybox";
    std::filesystem::create_directories(sky / "Textures");
    std::filesystem::create_directories(sky / "Meshes");
    write_png(sky / "Textures/gba-horizon.png", panorama);
    std::ofstream obj(sky / "Meshes/gba-horizon.obj");
    obj << std::setprecision(12);
    unsigned vertex = 0;
    for (unsigned y = 0; y < 16; ++y)
        for (unsigned x = 0; x < 64; ++x) {
            const auto emit = [&](unsigned xx, unsigned yy) {
                const double u = xx / 64., v = yy / 16., angle = u * 2 * pi, latitude = (.5 - v) * pi;
                const auto p = raw({1000 * std::cos(latitude) * std::sin(angle), 1000 * std::sin(latitude),
                                    1000 * std::cos(latitude) * std::cos(angle)});
                obj << "v " << p[0].get<double>() << ' ' << p[1].get<double>() << ' ' << p[2].get<double>() << "\nvt "
                    << u << ' ' << 1 - v << '\n';
            };
            emit(x, y);
            emit(x + 1, y);
            emit(x, y + 1);
            emit(x + 1, y + 1);
            obj << "f " << vertex + 1 << '/' << vertex + 1 << ' ' << vertex + 2 << '/' << vertex + 2 << ' '
                << vertex + 3 << '/' << vertex + 3 << '\n';
            obj << "f " << vertex + 2 << '/' << vertex + 2 << ' ' << vertex + 4 << '/' << vertex + 4 << ' '
                << vertex + 3 << '/' << vertex + 3 << '\n';
            vertex += 4;
        }
    require(bool(obj), "Cannot write GBA sky mesh");
    save(sky / "Materials.json",
         {{"Materials", {{{"TexturePath", "gba-horizon.png"}, {"AlphaMode", "opaque"}, {"RepeatTexture", false}}}}});
    save(sky / "Models.json",
         {{"Models",
           {{{"ModelName", "GBA horizon dome"},
             {"ModelObjects",
              {{{"ParentID", -1}, {"MeshData", {{{"MeshPath", "gba-horizon.obj"}, {"MaterialID", 0}}}}}}}}}}});
    save(sky / "Instances.json", {{"Instances", Json::array()}});
    return {{"Available", true},
            {"SourceResource", course.background},
            {"SourceImageSize", {256, 64}},
            {"Policy", "Original tiled 2D horizon wrapped onto a dome; upper sky and ground fill authored"}};
}
} // namespace openslope::import_detail::gba
