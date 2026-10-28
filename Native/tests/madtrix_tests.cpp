#include "import/containers/pak.hpp"
#include "openslope/appearance.hpp"
#include "openslope/audio_scene.hpp"
#include "openslope/music.hpp"
#include "openslope/paths.hpp"
#include "openslope/player.hpp"
#include "openslope/props.hpp"
#include "openslope/rails.hpp"
#include "openslope/world.hpp"
#include "openslope/world_logic.hpp"
#include <algorithm>
#include <iostream>

namespace {
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

template <typename Action> void fails(Action action) {
    try {
        action();
    } catch (const std::exception& error) {
        require(std::string(error.what()).find("cancelled") != std::string::npos, error.what());
        return;
    }
    throw std::runtime_error("Expected cancellation");
}
} // namespace

int main(int argc, char** argv) {
    try {
        require(argc >= 2, "Expected Mad Trix map");
        auto terrain = openslope::Terrain::load(argv[1]);
        if (terrain.patches().size() == 1) {
            const auto& patch = terrain.patches()[0];
            require(patch.light_colors.has_value(), "Baked colour controls must survive portable loading");
            const auto rgb = patch.light_color(.25, .75);
            require(std::abs(rgb[0] - .2734375) < 1e-9 && std::abs(rgb[1] - .640625) < 1e-9 && rgb[2] == 1,
                    "Bicubic RGB must preserve source axis order and neutral scale");
            const auto mesh = terrain.mesh(4);
            require(mesh.batches.size() == 1 && mesh.batches[0].vertex_lighting &&
                        mesh.vertices[8].r == float(rgb[0]) && mesh.vertices[8].g == float(rgb[1]),
                    "Native textured terrain must receive baked vertex colours");
            auto signed_patch = patch;
            (*signed_patch.light_colors)[5] = {-1, 4, 1};
            const auto mid = signed_patch.light_color(.5, .5);
            require(std::abs(mid[0] - .11669921875) < 1e-9 && mid[1] > 1,
                    "Signed fitted colour handles must interpolate before clamping");
        }
        const auto paths = openslope::CoursePaths::load(argv[1]);
        const auto start = paths.start_pose();
        require(bool(start), "Missing explicit start");
        const auto support =
            terrain.intersect(start->first + openslope::Vec3{0, 2, 0}, start->first - openslope::Vec3{0, 2, 0});
        require(support && support->normal.y > .5 && length(support->point - start->first) < .02,
                "Authored start must lie on rideable terrain");
        require(openslope::Appearance::load(terrain).missing.empty(), "Missing terrain texture");
        if (std::filesystem::exists(std::filesystem::path(argv[1]) / "Effects.json")) {
            const auto props = openslope::Props::load(argv[1]);
            require(!props.instances.empty() && !props.parts.empty(),
                    "Animated props must load through portable props");
            auto logic = openslope::WorldLogic::load(argv[1]);
            const std::array<openslope::Vec3, 1> observers{{{0, 0, 0}}};
            logic.tick(0, 0, observers);
            require(logic.texture_frames().size() == props.instances.size(),
                    "Animated props must install their material players");
            logic.tick(.5, 0, observers);
            for (const auto& frame : logic.texture_frames()) {
                if (!frame.materials.empty())
                    require(frame.materials[0].frame == 1, "Sign pulse must advance its source-texture frames");
                else
                    require(std::abs(frame.uv[0] + .25) < 1e-9 && frame.uv[1] == 0,
                            "Waterfall must scroll downhill through the shared material player");
            }
            require(openslope::Rails::load(argv[1]).segments() == 1, "Authored narrow grind strip must load as a rail");
        }
        if (std::filesystem::exists(std::filesystem::path(argv[1]) / "Skybox")) {
            const auto world = openslope::World::load(argv[1]);
            require(!world.sky.parts.empty() && !world.sky.geometry.indices.empty(), "Sky mesh must load");
            if (terrain.patches().size() == 1) {
                const auto& a = world.sky.geometry.vertices[world.sky.geometry.indices[0]];
                const auto& b = world.sky.geometry.vertices[world.sky.geometry.indices[1]];
                require(a.s == 0 && a.t == 0 && b.s == 0 && b.t == .125f,
                        "Runtime sky UVs must compensate the OBJ V inversion");
                require(a.x == -15 && a.y == -15 && a.z == -50,
                        "Sky vertices must retain the portable axes and centimetre-to-metre conversion");
            }
            for (const auto& part : world.sky.parts)
                require(openslope::read_png(std::filesystem::path(argv[1]) / "Skybox/Textures" / part.texture).width >
                            0,
                        "Sky image must resolve");
        }
        openslope::Player player(std::move(terrain));
        std::unique_ptr<openslope::AudioScene> audio;
        const auto music_root = std::filesystem::path(argv[1]) / "Audio/Music";
        if (std::filesystem::exists(music_root / "playlist.json")) {
            const auto graph = openslope::MusicGraph::load(music_root / "track1/graph.json");
            openslope::MusicCursor cursor;
            for (unsigned i = 0; i < graph.samples.size() + 2; ++i)
                require(openslope::music_advance(graph, cursor, 80) == int(i % graph.samples.size()),
                        "Music must start at the first chunk and loop the complete source track");
            audio = std::make_unique<openslope::AudioScene>(argv[1]);
            require(audio->music_status().songs.size() == 2, "Imported music playlist must reach the native player");
            audio->music_song("track1");
        }
        bool heard_music = false;
        unsigned grounded = 0;
        for (unsigned i = 0; i < 180; ++i) {
            const auto before = player.rider();
            player.tick({});
            if (audio) {
                audio->tick(player, before);
                audio->service();
                std::array<float, 1600> pcm{};
                audio->mixer().render(pcm);
                heard_music |= std::any_of(pcm.begin(), pcm.end(), [](float v) { return std::abs(v) > .00001f; });
            }
            grounded += player.rider().grounded;
            require(finite(player.rider().position) && finite(player.rider().velocity), "Non-finite rider");
        }
        require(grounded > 45, "Rider must sustain ground contact");
        require(!audio || (heard_music && audio->stats().music_node >= 1),
                "Imported source music must actually reach the native audio mixer while riding");
        require(length(player.rider().position - start->first) > 1, "Board must move downhill");
        player.warp(start->first + openslope::Vec3{0, 100, 0}, start->second);
        const auto serial = player.placement_serial();
        player.reset(true);
        require(player.reset_pending(), "Manual reset must schedule course recovery");
        bool placed = false;
        unsigned reset_grounded = 0;
        for (unsigned i = 0; i < 180; ++i) {
            player.tick({});
            const auto after = player.rider().position;
            require(finite(after) && finite(player.rider().velocity), "Reset must keep the rider finite");
            if (!placed && player.placement_serial() != serial) {
                // Check the actual recovery placement. Real courses can have
                // a drop/jump within the following three seconds of riding.
                const auto ground =
                    player.terrain().intersect(after + openslope::Vec3{0, .1, 0}, after - openslope::Vec3{0, 2, 0});
                require(ground && ground->normal.y > .5 && length(ground->point - after) < 1.1,
                        "Reset must place the rider one metre above rideable terrain");
                placed = true;
            }
            reset_grounded += placed && player.rider().grounded;
        }
        require(placed && player.last_course_recovery().has_value() && reset_grounded > 10,
                "Manual reset must complete and restore ground contact");
        player.restart_run();
        require(length(player.rider().position - (start->first + openslope::Vec3{0, 1, 0})) < .05,
                "Restart must use the authored start");
        if (argc > 2) {
            const auto disc = openslope::logical_disc(openslope::open_disc(argv[2]));
            const auto courses = openslope::disc_courses(disc);
            require(!courses.empty(), "Missing courses");
            std::size_t discovery_bytes = 0;
            const openslope::DiscInput counted{disc.size, [&](auto offset, auto bytes) {
                                                   discovery_bytes += bytes.size();
                                                   disc.read_at(offset, bytes);
                                               }};
            require(openslope::disc_courses(counted).size() == courses.size() && discovery_bytes < 65536,
                    "Course discovery must avoid full package/geometry reads");
            fails([&] { openslope::disc_courses(disc, [] { return true; }); });
            openslope::import_detail::Iso iso(disc);
            const auto entries = iso.children(iso.find("DATA"));
            const auto extent = std::find_if(entries.begin(), entries.end(),
                                             [](const auto& entry) { return entry.name != "E942715C.DAT"; });
            require(extent != entries.end(), "Missing fixture package");
            const openslope::import_detail::Pak pak(disc, *extent);
            const auto zeros = pak.file("UNUSED.BIN");
            require(zeros.size() == 65539 &&
                        std::all_of(zeros.begin(), zeros.begin() + 65536, [](auto v) { return !v; }) &&
                        std::string(zeros.end() - 3, zeros.end()) == "XYZ",
                    "Chunk reassembly, seeded dictionary and case-insensitive hashes must agree");
            const auto destination = std::filesystem::path(argv[1]).parent_path() / "cancelled";
            for (const auto stage :
                 {"Converting Mad Trix music", "Decoding Mad Trix terrain textures", "Converting Mad Trix sky dome",
                  "Validating Mad Trix terrain and authored start"}) {
                bool cancel = false;
                fails([&] {
                    openslope::extract_course(
                        disc, courses.front().name, destination, [&](const auto& text) { cancel = text == stage; },
                        [&] { return cancel; });
                });
                require(!std::filesystem::exists(destination), "Cancelled extraction must remove new output");
            }
        }
        std::cout << "PASS: textured Mad Trix terrain, supported start, " << grounded << " grounded ticks, "
                  << reset_grounded << " after reset, riding/reset/restart";
        if (argc > 2)
            std::cout << " and bounded package cancellation";
        std::cout << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
