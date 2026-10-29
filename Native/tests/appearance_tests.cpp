#include "openslope/appearance.hpp"
#include "openslope/scene_lighting.hpp"
#include "openslope/world.hpp"
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void require(bool condition, const char* message) {
    ++checks;
    if (!condition)
        throw std::runtime_error(message);
}

template <class F> void rejects(F operation, const char* message) {
    bool rejected = false;
    try {
        operation();
    } catch (const std::exception&) {
        rejected = true;
    }
    require(rejected, message);
}
} // namespace

int main(int argc, char** argv) {
    try {
        require(argc == 2, "Supply authored PNG fixtures");
        const auto root = std::filesystem::path(argv[1]);
        const auto actor = SceneLighting::load(root / "rgb_actor_lighting");
        const auto shaded = actor.sample({0, 1, 0}).evaluate({0, 1, 0});
        require(length(shaded - Vec3{.6 * 32 / 255, .6 * 64 / 255, .7 * 128 / 255}) < 1e-6,
                "RGB ground shade must attenuate the actor's separate ambient and directional rig");
        const auto clear = Vec3{.6, .6, .7};
        require(length(actor.sample({0, 9, 0}).evaluate({0, 1, 0}) - clear) < 1e-6,
                "A bright roof above a shaded floor keeps its own actor lighting");
        for (const auto position : {Vec3{20, 1, 0}, Vec3{40, 1, 0}, Vec3{100, 1, 0}, Vec3{0, -1, 0}})
            require(length(actor.sample(position).evaluate({0, 1, 0}) - clear) < 1e-6,
                    "Open snow, legacy pages and missing ground must preserve the player rig");
        for (const auto name : {"vertex_actor_lighting", "vertex_actor_no_instances"}) {
            const auto vertex = SceneLighting::load(root / name);
            const auto sample = vertex.sample({0, 1, 0});
            require(length(sample.ambient - Vec3{.6 * .125, .6 * .25, .6 * .5}) < 1e-6 &&
                        length(sample.keys[0].colour - Vec3{.4 * .125, .4 * .25, .4 * .5}) < 1e-6,
                    "Baked vertex colour must shade the fallback player rig without actor probes");
            require(length(vertex.sample({0, 9, 0}).evaluate({0, 1, 0}) - SceneLight::fallback().evaluate({0, 1, 0})) <
                        1e-6,
                    "A vertex-lit roof keeps its lighting separate from the floor");
            require(length(vertex.sample({20, 1, 0}).ambient - Vec3{.45, .75, .9}) < 1e-6,
                    "Vertex lighting must retain factors above one before actor evaluation");
            for (const auto position : {Vec3{40, 1, 0}, Vec3{100, 1, 0}})
                require(length(vertex.sample(position).evaluate({0, 1, 0}) -
                               SceneLight::fallback().evaluate({0, 1, 0})) < 1e-6,
                        "Missing vertex colours and missing ground preserve the fallback rig");
        }
        require(length(SceneLighting::load(root / "vertex_actor_probed").sample({0, 1, 0}).ambient - Vec3{.3, .4, .5}) <
                    1e-6,
                "Existing local actor probes must not receive vertex-baked shade twice");
        const auto nested = Appearance::load(Terrain::load(root / "nested_riding"));
        require(nested.images.size() == 2 && nested.images.contains("Textures/Particles/part.png") &&
                    nested.missing.empty(),
                "Nested puff, wake and spray textures load through the common scene manifest");
        for (unsigned i = 0; i < 6; ++i)
            rejects(
                [&] {
                    static_cast<void>(referenced_images(Terrain::load(root / ("unsafe_riding_" + std::to_string(i)))));
                },
                "Riding sprite paths still reject traversal, roots, drive names and backslashes");
        const std::vector<std::uint8_t> rgba{255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 64};
        for (const auto name : {"rgba.png", "palette.png", "interlaced.png"}) {
            const auto image = read_png(root / name);
            require(image.width == 2 && image.height == 2 && image.pixels == rgba,
                    "Decode standard PNG variants into top-down RGBA without alpha association");
        }
        const auto rgb = read_png(root / "rgb.png");
        require(rgb.pixels == std::vector<std::uint8_t>({23, 61, 127, 255}),
                "RGB expands to opaque RGBA without gamma conversion");
        const auto odd = diffuse_mips({3, 1, {0, 0, 0, 255, 90, 90, 90, 255, 180, 180, 180, 255}});
        require(odd.size() == 2 && odd.back().pixels == std::vector<std::uint8_t>({90, 90, 90, 255}),
                "Odd mip dimensions retain both edge texels");
        const auto alpha = diffuse_mips({2, 1, {255, 0, 0, 255, 0, 0, 255, 0}});
        require(alpha.back().pixels == std::vector<std::uint8_t>({255, 0, 0, 128}),
                "Transparent colour does not darken reduced edges");
        const auto chain = diffuse_mips({4, 2, std::vector<std::uint8_t>(32, 255)});
        require(chain.size() == 3 && chain[1].width == 2 && chain[1].height == 1 && chain[2].width == 1,
                "Rectangular mip chain reaches 1x1");
        rejects([&] { diffuse_mips({2, 1, {}}); }, "Reject malformed mip storage");
        for (const auto name : {"crc.png", "truncated.png", "oversized.png", "not-png.png"})
            rejects([&] { static_cast<void>(read_png(root / name)); },
                    "Reject corrupt or oversized PNG before rendering");
        const auto terrain = Terrain::load(root / "lighting");
        const auto appearance = Appearance::load(terrain);
        require(appearance.images.size() == 2 && appearance.missing.empty(),
                "Load referenced diffuse and raw RGBA lightmap page");
        require(appearance.images.at("Lightmaps/0000.png").pixels[3] == 255, "Retain lightmap alpha");
        require(Appearance::load(Terrain::load(root / "missing")).missing.size() == 2,
                "Missing custom map images fall back without blocking terrain");
        rejects([&] { static_cast<void>(referenced_images(Terrain::load(root / "unsafe"))); },
                "Reject texture path traversal");
        const auto particle_files = referenced_images(Terrain::load(root / "world_particles"));
        require(std::find(particle_files.begin(), particle_files.end(), "Textures/Particles/part.png") !=
                        particle_files.end() &&
                    std::find(particle_files.begin(), particle_files.end(), "Textures/Particles/str2.png") !=
                        particle_files.end(),
                "World emitter art is included in the portable asset manifest");
        rejects([&] { static_cast<void>(Appearance::load(Terrain::load(root / "corrupt"))); },
                "Present corrupt map image is an error");
        const auto wake = referenced_images(Terrain::load(root / "wake"));
        require(wake.size() == 2 && std::find(wake.begin(), wake.end(), "Textures/wake.png") != wake.end(),
                "Wake-only profile contributes art to the Quest cache manifest without a puff slot");
        rejects([&] { static_cast<void>(referenced_images(Terrain::load(root / "unsafe_wake"))); },
                "Reject wake texture traversal");
        auto world = World::load(root / "sky");
        const auto sky_images = Appearance::load(Terrain::load(root / "sky"));
        world.fit_colours(sky_images);
        require(world.sky.parts.size() == 1 && world.sky.instances.empty(),
                "Model-only sky requires no placement table");
        require(sky_images.images.contains("Skybox/Textures/sky.png"),
                "Nested sky art shares the course image budget and manifest");
        require(std::abs(world.sky_colour[0] - 120.f / 255) < 1e-6 && std::abs(world.fog_colour[0] - 50.f / 255) < 1e-6,
                "Derive clear and horizon colours from their own image rows");
        auto authored = World::load(root / "sky_authored");
        authored.fit_colours(sky_images);
        require(std::abs(authored.sky_colour[0] - 90.f / 255) < 1e-6 && authored.fog_end == 0,
                "Authored sky and disabled fog override seam defaults");
        const auto fog = World::load(root / "fog");
        require(fog.fog_start == 0 && fog.fog_end == 1 && std::abs(fog.fog_colour[0] - 200.f / 255) < 1e-6,
                "Authored fog stores metre distances and byte-domain colour");
        require(world.draw_fog(600) == std::array<float, 2>{300, 600},
                "Distant default sky fog caps to the terrain draw distance");
        require(authored.draw_fog(600) == std::array<float, 2>{300, 600},
                "Distance culling supplies fog even when the authored sky disables it");
        require(fog.draw_fog(600) == std::array<float, 2>{0, 1}, "Preserve authored fog ending before the range gate");
        require(World{}.draw_fog(600) == std::array<float, 2>{300, 600},
                "Maps without sky art also haze the terrain boundary");
        rejects([&] { static_cast<void>(world.draw_fog(0)); }, "Reject invalid fog draw distances");
        for (const auto name :
             {"sky_incomplete", "sky_unsafe", "fog_bad_range", "world_bad_colour", "world_bad_schema"})
            rejects([&] { static_cast<void>(World::load(root / name)); },
                    "Reject incomplete, escaping or invalid world profiles");
        const auto sheet = referenced_images(Terrain::load(root / "sheet"));
        require(sheet.size() == 2 && std::find(sheet.begin(), sheet.end(), "Textures/sheet.png") != sheet.end(),
                "Sheet-only maps contribute their texture independently of puff/wake slots");
        std::cout << "PASS: " << checks << " PNG/material loading checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
