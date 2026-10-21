#include "openslope/gear.hpp"
#include "controller.hpp"
#include "snowboard.hpp"
#include <bit>
#include <map>
#include <nlohmann/json.hpp>
#include <span>
#include <stdexcept>

namespace openslope {
namespace {
Mesh read_art(std::span<const unsigned char> bytes) {
    const auto word = [&](std::size_t i) {
        if (i + 4 > bytes.size())
            throw std::runtime_error("Truncated bundled art");
        return std::uint32_t(bytes[i]) | (std::uint32_t(bytes[i + 1]) << 8) | (std::uint32_t(bytes[i + 2]) << 16) |
               (std::uint32_t(bytes[i + 3]) << 24);
    };
    if (word(0) != 0x46546c67 || word(4) != 2 || word(8) != bytes.size() || word(16) != 0x4e4f534a)
        throw std::runtime_error("Invalid bundled art GLB");
    const auto binary = std::size_t(word(12)) + 20;
    const auto metadata = nlohmann::json::parse(bytes.begin() + 20, bytes.begin() + binary);
    const auto count = metadata.at("accessors").at(0).at("count").get<std::size_t>();
    if (count == 0 || count > 100000 || count % 3 || word(binary + 4) != 0x004e4942 || word(binary) != count * 36 ||
        binary + 8 + count * 36 != bytes.size())
        throw std::runtime_error("Invalid bundled art vertex layout");
    const auto component = [&](std::size_t offset) {
        const auto v = std::bit_cast<float>(word(offset));
        if (!std::isfinite(v))
            throw std::runtime_error("Non-finite bundled art");
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
}
} // namespace

const Mesh& snowboard_mesh() {
    static const Mesh model = [] {
        auto result = read_art(bundled::snowboard);
        double half_length = 0;
        std::map<float, double> widths;
        for (const auto& v : result.vertices) {
            widths[v.z] = std::max(widths[v.z], std::abs(double(v.x)));
            half_length = std::max(half_length, std::abs(double(v.z)));
        }
        for (std::size_t at = 0; at < result.vertices.size(); at += 3) {
            // Sidewalls/caps retain their solid edge ink.
            const auto ny = result.vertices[at].ny;
            const bool face = std::abs(ny) > .5;
            const bool top = ny > 0;
            for (unsigned k = 0; k < 3; ++k) {
                auto& v = result.vertices[at + k];
                const auto half_width = widths.at(v.z);
                v.s = float((top ? .25 : .75) + (half_width > 0 ? (top ? 1 : -1) * v.x / (4 * half_width) : 0));
                v.t = float(.5 + v.z / (2 * half_length));
                v.lx = top ? 0.f : .5f;
                v.lh = face ? 1.f : 0.f;
            }
        }
        return result;
    }();
    return model;
}

const Mesh& touch_plus_mesh() {
    static const Mesh model = read_art(bundled::controller);
    return model;
}
} // namespace openslope
