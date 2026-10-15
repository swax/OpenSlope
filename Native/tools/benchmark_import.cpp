#include "openslope/audio_data.hpp"
#include "openslope/collision.hpp"
#include "openslope/import.hpp"
#include "openslope/music.hpp"
#include "openslope/paths.hpp"
#include "openslope/props.hpp"
#include "openslope/rails.hpp"
#include "openslope/terrain.hpp"
#include "openslope/world.hpp"
#include "openslope/world_logic.hpp"
#include <chrono>
#include <iostream>
#include <map>
#include <nlohmann/json.hpp>

// Use the production importer and input interface on both desktop and Android.
// Each output must be a fresh directory; keep it for byte/pixel comparisons.
int main(int argc, char** argv) {
    try {
        using Clock = std::chrono::steady_clock;
        if (argc == 3 && std::string(argv[1]) == "--validate") {
            const auto root = std::filesystem::path(argv[2]);
            nlohmann::json times;
            const auto measure = [&](const char* name, const auto& operation) {
                const auto begin = Clock::now();
                operation();
                times[name] = std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
            };
            measure("terrain_ms", [&] { static_cast<void>(openslope::Terrain::load(root)); });
            measure("props_ms", [&] { static_cast<void>(openslope::Props::load(root)); });
            measure("world_ms", [&] { static_cast<void>(openslope::World::load(root)); });
            measure("rails_ms", [&] { static_cast<void>(openslope::Rails::load(root)); });
            measure("paths_ms", [&] { static_cast<void>(openslope::CoursePaths::load(root)); });
            measure("collision_ms", [&] { static_cast<void>(openslope::CollisionWorld::load(root)); });
            measure("logic_ms", [&] { static_cast<void>(openslope::WorldLogic::load(root)); });
            std::cout << times.dump(2) << '\n';
            return 0;
        }
        if (argc == 6 && std::string(argv[1]) == "--music") {
            const auto disc = openslope::open_disc(argv[2]);
            const auto graph =
                openslope::MusicGraph::decode(openslope::disc_archive_file(disc, "DATA/AUDIO/MUSIC.BIG", argv[3]));
            const auto audio = openslope::disc_archive_file(disc, "DATA/AUDIO/MUSIC.BIG", argv[4]);
            if (!std::filesystem::create_directory(argv[5]))
                throw std::runtime_error("Music benchmark output already exists");
            double decode_ms = 0, write_ms = 0;
            std::size_t samples = 0;
            for (const auto& sample : graph.samples) {
                const auto begin = Clock::now();
                const auto decoded = openslope::decode_audio_stream(audio, sample.offset);
                const auto ready = Clock::now();
                openslope::write_wave(std::filesystem::path(argv[5]) / sample.wav, decoded.clip);
                decode_ms += std::chrono::duration<double, std::milli>(ready - begin).count();
                write_ms += std::chrono::duration<double, std::milli>(Clock::now() - ready).count();
                samples += decoded.clip.samples.size();
            }
            std::cout << nlohmann::json({{"decode_ms", decode_ms},
                                         {"write_ms", write_ms},
                                         {"samples", samples},
                                         {"chunks", graph.samples.size()}})
                             .dump(2)
                      << '\n';
            return 0;
        }
        if (argc != 2 && argc != 4)
            throw std::runtime_error("Usage: openslope_import_benchmark <iso> [<course> <new-output-directory>]");
        const auto source = openslope::open_disc(argv[1]);
        std::uint64_t bytes = 0, reads = 0;
        double read_ms = 0;
        const openslope::DiscInput disc{source.size, [&](auto offset, auto data) {
                                            const auto begin = Clock::now();
                                            source.read_at(offset, data);
                                            read_ms +=
                                                std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
                                            bytes += data.size();
                                            ++reads;
                                        }};
        std::map<std::string, double> stages;
        auto last = Clock::now();
        const auto begin = last;
        std::string stage = "setup";
        const auto record = [&] {
            const auto now = Clock::now();
            stages[stage] += std::chrono::duration<double, std::milli>(now - last).count();
            last = now;
        };
        nlohmann::json courses = nlohmann::json::array();
        if (argc == 2) {
            stage = "discovery";
            for (const auto& course : openslope::disc_courses(disc))
                courses.push_back(course.name);
        } else {
            openslope::extract_course(disc, argv[2], argv[3], [&](const std::string& message) {
                record();
                stage = message;
                for (const auto prefix : {"Texture ", "Lightmap ", "Particle sprite ", "Saving source ",
                                          "Decoding sound bank ", "Decoding music ", "Decoding intro "})
                    if (message.starts_with(prefix)) {
                        stage = std::string(prefix) + "*";
                        break;
                    }
            });
        }
        record();
        nlohmann::json result = {{"operation", argc == 2 ? "discovery" : "extract"},
                                 {"elapsed_ms", std::chrono::duration<double, std::milli>(last - begin).count()},
                                 {"read_ms", read_ms},
                                 {"read_calls", reads},
                                 {"read_bytes", bytes},
                                 {"stages_ms", stages}};
        if (argc == 2)
            result["courses"] = courses;
        else {
            std::uint64_t output_bytes = 0, output_files = 0;
            for (const auto& entry : std::filesystem::recursive_directory_iterator(argv[3]))
                if (entry.is_regular_file()) {
                    output_bytes += entry.file_size();
                    ++output_files;
                }
            result["course"] = argv[2];
            result["output_bytes"] = output_bytes;
            result["output_files"] = output_files;
        }
        std::cout << result.dump(2) << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
