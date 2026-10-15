#include "openslope/gear.hpp"
#include "snowboard.hpp"
#include <bit>
#include <nlohmann/json.hpp>
#include <span>
#include <stdexcept>

namespace openslope {
const Mesh& snowboard_mesh() {
    static const Mesh model = [] {
        const std::span<const unsigned char> bytes(bundled::snowboard);
        const auto word = [&](std::size_t i) {
            if (i + 4 > bytes.size())
                throw std::runtime_error("Truncated stock snowboard");
            return std::uint32_t(bytes[i]) | (std::uint32_t(bytes[i + 1]) << 8) | (std::uint32_t(bytes[i + 2]) << 16) |
                   (std::uint32_t(bytes[i + 3]) << 24);
        };
        if (word(0) != 0x46546c67 || word(4) != 2 || word(8) != bytes.size() || word(16) != 0x4e4f534a)
            throw std::runtime_error("Invalid stock snowboard GLB");
        const auto binary = std::size_t(word(12)) + 20;
        const auto metadata = nlohmann::json::parse(bytes.begin() + 20, bytes.begin() + binary);
        const auto count = metadata.at("accessors").at(0).at("count").get<std::size_t>();
        if (count == 0 || count > 100000 || count % 3 || word(binary + 4) != 0x004e4942 || word(binary) != count * 36 ||
            binary + 8 + count * 36 != bytes.size())
            throw std::runtime_error("Invalid stock snowboard vertex layout");
        const auto component = [&](std::size_t offset) {
            const auto v = std::bit_cast<float>(word(offset));
            if (!std::isfinite(v))
                throw std::runtime_error("Non-finite stock snowboard");
            return v;
        };
        const auto display = [](float linear) {
            return linear <= .0031308f ? 12.92f * linear : 1.055f * std::pow(linear, 1.f / 2.4f) - .055f;
        };
        Mesh mesh;
        for (std::size_t i = 0; i < count; ++i) {
            const auto at = binary + 8 + i * 36;
            Vertex v{component(at),
                     component(at + 4),
                     component(at + 8),
                     display(component(at + 12)),
                     display(component(at + 16)),
                     display(component(at + 20))};
            v.nx = component(at + 24);
            v.ny = component(at + 28);
            v.nz = component(at + 32);
            mesh.vertices.push_back(v);
            mesh.indices.push_back(std::uint32_t(i));
        }
        return mesh;
    }();
    return model;
}
} // namespace openslope
