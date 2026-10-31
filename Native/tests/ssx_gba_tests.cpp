#include "openslope/appearance.hpp"
#include "openslope/audio_scene.hpp"
#include "openslope/import.hpp"
#include "openslope/player.hpp"
#include "openslope/world.hpp"
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

using namespace openslope;
using Json = nlohmann::json;

void check(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

Vec3 point(const Json& p) { return {p[0].get<double>() / 100, p[2].get<double>() / 100, -p[1].get<double>() / 100}; }

int main(int argc, char** argv) {
    try {
        check(argc >= 2, "Supply a converted map");
        const std::filesystem::path root = argv[1];
        const auto terrain = Terrain::load(root);
        check(!terrain.patches().empty(), "GBA terrain loads");
        check(Appearance::load(terrain).missing.empty(), "All GBA terrain textures load");
        const auto world = World::load(root);
        check(!world.sky.parts.empty(), "GBA horizon loads in native scene");
        const auto paths = CoursePaths::load(root);
        const auto start = paths.start_pose();
        check(bool(start), "GBA start pose exists");
        Player rider(Terrain::load(root));
        AudioScene audio(root);
        const auto songs = audio.music_status().songs;
        check(songs.size() == 10, "Native player discovers all GBA arrangements");
        audio.music_song(songs.front());
        bool audible = false;
        std::array<float, 1600> pcm{};
        for (unsigned i = 0; i < 60; ++i) {
            audio.tick(rider, rider.rider());
            audio.service();
            audio.mixer().render(pcm);
            for (const auto value : pcm)
                audible |= std::abs(value) > 1e-7;
        }
        check(audible && audio.stats().music_node >= 1, "GBA arrangement plays through native music runtime");
        check(finite(rider.rider().position), "Native rider starts at finite coordinates");
        unsigned ground = 0;
        for (unsigned i = 0; i < 180; ++i) {
            rider.tick({});
            ground += rider.rider().grounded;
        }
        if (ground <= 60) {
            const auto& s = rider.rider();
            std::cerr << "Ground ticks " << ground << "; start " << start->first.x << ',' << start->first.y << ','
                      << start->first.z << "; final " << s.position.x << ',' << s.position.y << ',' << s.position.z
                      << "; velocity " << s.velocity.x << ',' << s.velocity.y << ',' << s.velocity.z << "; motion "
                      << int(s.motion) << "; contacts " << s.world_contacts << '\n';
        }
        check(ground > 60, "Native GBA start has ground support through drop-in");
        rider.reset();
        check(length(rider.rider().position - start->first) < 3, "Native reset returns to adapted start");
        std::ifstream input(root / "Splines.json");
        const auto splines = Json::parse(input).at("Splines");
        unsigned captured = 0;
        for (const auto& spline : splines) {
            const auto& cp = spline.at("Segments").front().at("Points");
            auto a = point(cp[0]), b = point(cp[3]);
            if (a.y < b.y)
                std::swap(a, b);
            const auto heading = normalized(b - a);
            rider.warp(a + (b - a) * .35 + Vec3{0, .25, 0}, heading, heading * 8);
            unsigned moving = 0;
            for (unsigned i = 0; i < 120; ++i) {
                rider.tick({});
                if (rider.rider().motion == Motion::Rail && length(rider.rider().velocity) > 1)
                    ++moving;
            }
            check(moving >= 3, "GBA rail catches a moving native rider");
            ++captured;
        }
        check(captured > 0, "GBA has grind rails");
        if (argc == 3) {
            std::uint64_t bytes = 0;
            auto source = open_disc(argv[2]);
            const auto original = source.read_at;
            source.read_at = [&](std::uint64_t at, std::span<std::uint8_t> out) {
                bytes += out.size();
                original(at, out);
            };
            ImportSession session(source);
            check(session.courses().size() == 8, "Session scans all GBA maps");
            check(bytes < 16384, "GBA discovery reads metadata rather than the whole ROM");
            check(session.courses().size() == 8 && session.stats().scans == 1, "Repeated GBA scans reuse the session");
            const auto destination = root.parent_path() / "cancelled-gba";
            unsigned ticks = 0;
            bool rejected = false;
            try {
                session.extract("SSXGBA_GARIBALDI", destination, {}, [&] { return ++ticks > 5; });
            } catch (const std::exception&) {
                rejected = true;
            }
            check(rejected && !std::filesystem::exists(destination), "Cancelled GBA extraction is cleaned up");
        }
        std::cout << "GBA native scene, ground, spawn/reset and " << captured << " moving rail captures PASS\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
