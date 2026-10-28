#include "openslope/appearance.hpp"
#include "openslope/audio_scene.hpp"
#include "openslope/collision.hpp"
#include "openslope/import.hpp"
#include "openslope/paths.hpp"
#include "openslope/player.hpp"
#include "openslope/riding_effects.hpp"
#include "openslope/scene_lighting.hpp"
#include "openslope/world.hpp"
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

using namespace openslope;

namespace {
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
} // namespace

int main(int argc, char** argv) {
    try {
        require(argc >= 2, "Expected a converted Avalanche map");
        auto terrain = Terrain::load(argv[1]);
        if (argc > 2) {
            std::ifstream input(argv[2]);
            const auto expected = nlohmann::json::parse(input).get<std::vector<std::array<std::array<double, 2>, 4>>>();
            require(expected.size() == terrain.patches().size(), "Source UV patch count must agree");
            const std::array<std::array<double, 2>, 4> corners{{{0, 0}, {1, 0}, {0, 1}, {1, 1}}};
            for (std::size_t i = 0; i < expected.size(); ++i)
                for (unsigned corner = 0; corner < 4; ++corner) {
                    const auto uv = terrain.patches()[i].texture_uv(corners[corner][0], corners[corner][1]);
                    require(std::abs(uv[0] - expected[i][corner][0]) < 1e-6 &&
                                std::abs(uv[1] - expected[i][corner][1]) < 1e-6,
                            "Native UV corners must remain attached to source geometry");
                }
            if (expected.size() == 1) {
                const auto mesh = terrain.mesh(1);
                const std::array<unsigned, 4> order{0, 2, 1, 3};
                for (unsigned i = 0; i < 4; ++i) {
                    const auto& vertex = mesh.vertices[i];
                    require(std::abs(vertex.s - expected[0][order[i]][0]) < 1e-6 &&
                                std::abs(vertex.t - expected[0][order[i]][1]) < 1e-6,
                            "Native draw vertices must retain rotated/mirrored source UVs");
                }
            }
        }
        const auto paths = CoursePaths::load(argv[1]);
        const auto spawn = paths.start_pose();
        require(bool(spawn), "Missing explicit course start");
        const auto ground = terrain.intersect(spawn->first + Vec3{0, 2, 0}, spawn->first - Vec3{0, 2, 0});
        require(ground && length(ground->point - spawn->first) < .02, "Spawn must lie on actual terrain");
        require(ground->normal.y > .5, "Start must be rideable");
        const auto appearance = Appearance::load(terrain);
        require(!appearance.images.empty() && appearance.missing.empty(),
                "Terrain textures must load without missing files");
        auto collision = CollisionWorld::load(argv[1]);
        require(collision.triangles() > 0, "World collision mesh must load");
        if (argc > 3) {
            const auto output = std::filesystem::path(argv[1]).parent_path() / "cancelled-music";
            bool cancel = false;
            try {
                extract_course(
                    open_disc(argv[3]), "AVALANCHE_CRS00_00", output,
                    [&](const auto& text) { cancel = text == "Converting Avalanche music"; }, [&] { return cancel; });
                throw std::runtime_error("Music cancellation did not abort");
            } catch (const std::exception&) {
                require(cancel && !std::filesystem::exists(output),
                        "Music cancellation must clean the map staging tree");
            }
        }
        const auto root = std::filesystem::path(argv[1]);
        if (std::filesystem::exists(root / "AvalancheEnvironment.json")) {
            const auto world = World::load(root);
            require(!world.sky.parts.empty(), "Course sky must load");
            for (const auto& part : world.sky.parts)
                require(read_png(root / "Skybox/Textures" / part.texture).width > 0, "Sky textures must resolve");
            require(SceneLighting::load(root).size() > 0, "Course prop/rider light rig must load");
            require(terrain.patches().front().lightmap >= 0, "Terrain must carry baked lighting");
            require(read_png(root / "Lightmaps/0000.png").width == 128, "Baked lighting page must load");
            require(!riding_sprite(root).empty() && !riding_sprite(root, "Sheet").empty(),
                    "Source spray must be available to riding effects");
        }
        if (terrain.patches().size() == 1) {
            require(bool(collision.ray({-10, 5, 25}, {-20, 5, 25})), "Authored reflected wall must block rays");
            require(bool(collision.ray({40, 25, 20}, {30, 25, 20})), "Imported reflected trunk proxy must be solid");
            const std::array<ProbeSphere, 1> a{{{{-10, 5, 25}, .5}}}, b{{{{-20, 5, 25}, .5}}};
            require(!collision.sweep(a, b).empty(), "Source wall must block a swept rider volume");
            const auto snow = collision.ray({-135, 3, 5}, {-135, -3, 5}, true);
            require(snow && snow->surface == 1, "Literal source snow tag must remain board support");
        }
        Player player(std::move(terrain));
        if (std::filesystem::exists(root / "Audio/Music/playlist.json")) {
            AudioScene audio(root);
            const auto initial_decoded = audio.stats().decoded_bytes;
            const auto status = audio.music_status();
            require(!status.songs.empty(), "Imported soundtrack must reach the native song picker");
            audio.music_song(status.songs.front());
            bool audible = false;
            std::array<float, 1600> pcm{};
            for (unsigned i = 0; i < 180; ++i) {
                audio.tick(player, player.rider());
                audio.service();
                audio.mixer().render(pcm);
                for (const auto value : pcm)
                    audible |= std::abs(value) > 1e-7;
            }
            require(audible && audio.stats().music_node >= 1, "Imported soundtrack must produce native PCM");
            require(audio.stats().decoded_bytes <= initial_decoded + 16 * 1024 * 1024,
                    "Native playback must cache only bounded song chunks");
        }
        unsigned grounded = 0;
        for (unsigned i = 0; i < 180; ++i) {
            player.tick({});
            grounded += player.rider().grounded;
            require(finite(player.rider().position) && finite(player.rider().velocity), "Riding must remain finite");
        }
        require(grounded > 45, "Spawned board must land and sustain ground contact");
        const auto ridden = player.rider().position;
        require(length(ridden - spawn->first) > 1, "Board must ride down the course");
        player.warp(spawn->first + Vec3{0, 100, 0}, spawn->second);
        player.reset(true);
        for (unsigned i = 0; i < 180; ++i)
            player.tick({});
        require(finite(player.rider().position), "Manual reset must retain a finite rider");
        const auto after = player.rider().position;
        const auto support = player.terrain().intersect(after + Vec3{0, 3, 0}, after - Vec3{0, 8, 0});
        require(bool(support), "Manual reset must return to supported terrain");
        player.restart_run();
        require(length(player.rider().position - (spawn->first + Vec3{0, 1, 0})) < .05,
                "Restart must return to the recorded start");
        std::cout << "PASS: textured Avalanche terrain, collision, supported spawn, " << grounded
                  << " grounded ticks, riding, manual reset and restart\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Avalanche verification: " << error.what() << '\n';
        return 1;
    }
}
