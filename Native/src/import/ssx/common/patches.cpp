#include "import/ssx/formats.hpp"
#include <array>
#include <nlohmann/json.hpp>

namespace openslope::import_detail {
using Json = nlohmann::json;

std::string patch_document(std::span<const std::uint8_t> records, const std::vector<std::string>& names,
                           const std::vector<Image>& images, bool original) {
    Bytes b{records};
    const auto count = names.size();
    b.range(0, count * 448);
    Json rows = Json::array();
    for (std::size_t i = 0; i < count; ++i) {
        const auto p = i * 448;
        Json points = Json::array(), uv = Json::array(), tile = Json::array();
        // [Trailmap: 220-power-basis] Tensor-product monomial-to-Bernstein
        // conversion, with reversed on-disc row-major coefficient storage.
        std::array<std::array<double, 3>, 16> coefficients{};
        for (std::size_t j = 0; j < 16; ++j)
            for (unsigned axis = 0; axis < 3; ++axis)
                coefficients[j][axis] = b.number(p + 80 + (15 - j) * 16 + axis * 4);
        // t^k = sum(i=k..3) C(i,k)/C(3,k) B_i^3(t). Apply this
        // identity directly in both dimensions; no decoder-specific recurrence.
        constexpr double binomial[4][4] = {{1, 0, 0, 0}, {1, 1, 0, 0}, {1, 2, 1, 0}, {1, 3, 3, 1}};
        for (std::size_t u = 0; u < 4; ++u)
            for (std::size_t v = 0; v < 4; ++v) {
                std::array<double, 3> control{};
                for (std::size_t a = 0; a <= u; ++a)
                    for (std::size_t c = 0; c <= v; ++c) {
                        const double weight = (binomial[u][a] / binomial[3][a]) * (binomial[v][c] / binomial[3][c]);
                        for (unsigned axis = 0; axis < 3; ++axis)
                            control[axis] += coefficients[a * 4 + c][axis] * weight;
                    }
                points.push_back(control);
            }
        for (unsigned c = 0; c < 4; ++c) {
            uv.push_back({b.number(p + 16 + c * 16), b.number(p + 20 + c * 16)});
            tile.push_back(b.number(p + c * 4));
        }
        const auto texture = original ? static_cast<std::int32_t>(b.le(p + 432)) : b.signed16(p + 432);
        const auto lightmap = original ? static_cast<std::int32_t>(b.le(p + 436)) : b.signed16(p + 434);
        if (texture < 0 || static_cast<std::size_t>(texture) >= images.size())
            throw std::runtime_error("Terrain references a missing texture");
        rows.push_back({{"PatchName", names[i]},
                        {"LightMapPoint", tile},
                        {"UVPoints", uv},
                        {"Points", points},
                        {"SurfaceType", b.le(p + (original ? 440 : 424))},
                        {"TrickOnlyPatch", !original && b.signed16(p + 430) < 0},
                        {"TexturePath", images[static_cast<std::size_t>(texture)].name + ".png"},
                        {"LightmapID", lightmap}});
    }
    return Json{{"Patches", rows}}.dump();
}

} // namespace openslope::import_detail
