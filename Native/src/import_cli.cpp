#include "import/avalanche/formats.hpp"
#include "import/ssx/formats.hpp"
#include "openslope/audio_resolver.hpp"
#include "openslope/import.hpp"
#include "openslope/world_import.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

int main(int argc, char** argv) {
    try {
        if (argc < 3) {
            std::cerr << "Usage: openslope_import list <iso> | extract <iso> <course> <Maps-folder> | convert-effects "
                         "<saved-ssf> <Effects.json> | extract-crowd <iso> <map-folder> | convert-crowd <saved-ssh> "
                         "<map-folder> | world <iso> <course> | surface-spray <iso> | collision-routes <iso> | "
                         "board-groups <iso> | adapt-riding-audio <map-folder> | adapt-course-ambience <map-folder> | "
                         "polish-streamed-map <map-folder> | extract-avalanche-music <image> <map-folder> | "
                         "refresh-avalanche-lighting <image> <course> <map-folder>\n";
            return 1;
        }
        const std::string operation = argv[1];
        if (operation == "polish-streamed-map" && argc == 3) {
            std::cout << openslope::polish_streamed_map(argv[2]) << '\n';
            return 0;
        }
        if (operation == "adapt-riding-audio" && argc == 3) {
            std::cout << openslope::adapt_riding_audio(argv[2]) << '\n';
            return 0;
        }
        if (operation == "adapt-course-ambience" && argc == 3) {
            std::cout << openslope::adapt_course_ambience(argv[2]) << '\n';
            return 0;
        }
        if (operation == "convert-effects" && argc == 4) {
            const auto source = std::filesystem::path(argv[2]), output = std::filesystem::path(argv[3]);
            if (std::filesystem::file_size(source) > 64 * 1024 * 1024 || std::filesystem::exists(output))
                throw std::runtime_error("Invalid behavior source or existing Effects destination");
            std::ifstream input(source, std::ios::binary);
            const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(input),
                                                  std::istreambuf_iterator<char>()};
            const auto document = openslope::import_detail::logic_document(bytes, source.stem().string());
            std::ofstream file(output, std::ios::binary);
            file << document << '\n';
            if (!file)
                throw std::runtime_error("Cannot write Effects destination");
            std::cout << "Converted effects " << output.string() << '\n';
            return 0;
        }
        if (operation == "convert-crowd" && argc == 4) {
            const auto source = std::filesystem::path(argv[2]);
            if (std::filesystem::file_size(source) > 64 * 1024 * 1024)
                throw std::runtime_error("Crowd source exceeds limit");
            std::ifstream file(source, std::ios::binary);
            const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(file),
                                                  std::istreambuf_iterator<char>()};
            openslope::import_detail::write_crowd(bytes, argv[3]);
            std::cout << "Added shared crowd frames to " << argv[3] << '\n';
            return 0;
        }
        const auto disc = openslope::open_disc(argv[2]);
        if (operation == "refresh-avalanche-lighting" && argc == 5) {
            using Json = nlohmann::json;
            const auto root = std::filesystem::absolute(argv[4]);
            std::ifstream origin_file(root / "Import.json");
            const auto origin = Json::parse(origin_file);
            if (origin.value("Game", "") != "1080-avalanche" || origin.value("Course", "") != argv[3])
                throw std::runtime_error("Lighting refresh requires the matching imported Avalanche course");
            const auto staging = root / (".openslope-lighting-" +
                                         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
            std::filesystem::create_directory(staging);
            try {
                for (const auto name : {"Patches.json", "Instances.json"})
                    std::filesystem::copy_file(root / name, staging / name);
                const auto lighting = openslope::import_detail::refresh_avalanche_lighting(
                    openslope::logical_disc(disc), argv[3], staging, {});
                const auto apply_lighting = [&](Json& environment) {
                    environment["Lighting"] = lighting;
                    environment["LightingPolicy"] =
                        "source corner RGB and projected colour shadows; separate scenery/rider rigs";
                    if (environment.contains("Deferred"))
                        for (auto& item : environment["Deferred"])
                            if (item == "source-shadow-map")
                                item = "dynamic-shadow-casters";
                };
                auto updated = origin;
                apply_lighting(updated["Environment"]);
                std::ofstream report(staging / "Import.json");
                report << updated.dump() << '\n';
                report.close();
                if (std::filesystem::is_regular_file(root / "AvalancheEnvironment.json")) {
                    std::ifstream input(root / "AvalancheEnvironment.json");
                    auto environment = Json::parse(input);
                    apply_lighting(environment);
                    std::ofstream file(staging / "AvalancheEnvironment.json");
                    file << environment.dump() << '\n';
                    if (!file)
                        throw std::runtime_error("Cannot stage Avalanche environment metadata");
                }
                if (!report)
                    throw std::runtime_error("Cannot stage Avalanche import metadata");
                // Preserve the initial state once; repeated refreshes never replace the backup.
                const auto backup = root / "LightingBackup-v1";
                if (!std::filesystem::exists(backup)) {
                    std::filesystem::create_directory(backup);
                    for (const auto name : {"Patches.json", "Instances.json", "Lights.json", "Import.json",
                                            "AvalancheEnvironment.json", "AvalancheLighting.json"})
                        if (std::filesystem::is_regular_file(root / name))
                            std::filesystem::copy_file(root / name, backup / name);
                    if (std::filesystem::exists(root / "Lightmaps"))
                        std::filesystem::copy(root / "Lightmaps", backup / "Lightmaps",
                                              std::filesystem::copy_options::recursive);
                }
                std::filesystem::create_directories(root / "Lightmaps");
                for (const auto& entry : std::filesystem::recursive_directory_iterator(staging))
                    if (entry.is_regular_file())
                        std::filesystem::copy_file(entry.path(), root / entry.path().lexically_relative(staging),
                                                   std::filesystem::copy_options::overwrite_existing);
                std::filesystem::remove_all(staging);
            } catch (...) {
                std::filesystem::remove_all(staging);
                throw;
            }
            std::cout << "Refreshed Avalanche lighting in " << root.string() << '\n';
            return 0;
        }
        if (operation == "extract-avalanche-music" && argc == 4) {
            const auto logical = openslope::logical_disc(disc);
            const auto songs = openslope::import_detail::write_avalanche_music(
                logical, argv[3], [](const auto& text) { std::cout << text << '\n'; }, {});
            if (!songs)
                throw std::runtime_error("Avalanche soundtrack is unavailable on this image");
            std::cout << "Extracted " << songs << " Avalanche music streams to " << argv[3] << '\n';
            return 0;
        }
        if (operation == "surface-spray" && argc == 3) {
            const auto profile = openslope::disc_surface_spray_profile(disc);
            if (profile.empty())
                throw std::runtime_error("Surface spray data is unavailable in this executable");
            std::cout << profile << '\n';
            return 0;
        }
        if (operation == "extract-crowd" && argc == 4) {
            openslope::import_detail::write_crowd(openslope::disc_file(disc, "DATA/TEXTURES/CROWD.SSH"), argv[3]);
            std::cout << "Added shared crowd frames to " << argv[3] << '\n';
            return 0;
        }

        if (operation == "directory" && argc == 4) {
            for (const auto& entry : openslope::disc_directory(disc, argv[3]))
                std::cout << (entry.directory ? "dir " : "file ") << entry.name << '\t' << entry.bytes << '\n';
            return 0;
        }
        if (operation == "read" && argc == 5) {
            const auto data = openslope::disc_file(disc, argv[3]);
            if (std::filesystem::exists(argv[4]))
                throw std::runtime_error("Read destination already exists");
            std::ofstream file(argv[4], std::ios::binary);
            file.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
            if (!file)
                throw std::runtime_error("Cannot save disc file");
            return 0;
        }
        if (operation == "archive-directory" && argc == 4) {
            for (const auto& entry : openslope::disc_archive_directory(disc, argv[3]))
                std::cout << entry.name << '\t' << entry.bytes << '\n';
            return 0;
        }
        if (operation == "read-archive" && argc == 6) {
            const auto data = openslope::disc_archive_file(disc, argv[3], argv[4]);
            if (std::filesystem::exists(argv[5]))
                throw std::runtime_error("Read destination already exists");
            std::ofstream file(argv[5], std::ios::binary);
            file.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
            if (!file)
                throw std::runtime_error("Cannot save archive member");
            return 0;
        }
        if (operation == "list") {
            for (const auto& course : openslope::disc_courses(disc))
                std::cout << course.name << '\t' << course.archive_bytes << '\n';
            return 0;
        }
        if (operation == "world" && argc == 4) {
            const auto profile = openslope::disc_world_profile(disc, argv[3]);
            if (profile.empty())
                throw std::runtime_error("World settings are unavailable for this course and executable");
            std::cout << profile << '\n';
            return 0;
        }
        if (operation == "board-groups" && argc == 3) {
            const auto groups = openslope::disc_board_groups(disc);
            if (!groups)
                throw std::runtime_error("Board surface selector is unavailable in this executable");
            std::cout << nlohmann::json({{"Schema", "openslope-board-sound-index/v1"},
                                         {"SourceExecutable", groups->executable},
                                         {"SurfaceGroups", groups->surfaces}})
                             .dump(2)
                      << '\n';
            return 0;
        }
        if (operation == "collision-routes" && argc == 3) {
            const auto resolver = openslope::disc_collision_routes(disc);
            if (!resolver)
                throw std::runtime_error("Collision resolver is unavailable in this executable");
            nlohmann::json output = {{"SourceExecutable", resolver->executable}, {"Events", nlohmann::json::object()}};
            for (const auto& [event, route] : resolver->events)
                output["Events"][std::to_string(event)] = {{"Group", route.group}, {"Slot", route.slot}};
            std::cout << output.dump(2) << '\n';
            return 0;
        }
        if (operation != "extract" || argc != 5)
            throw std::runtime_error("Invalid import arguments");
        const std::string name = argv[3];
        if (!openslope::valid_map_name(name))
            throw std::runtime_error("Invalid map name");
        const auto root = std::filesystem::absolute(argv[4]);
        std::filesystem::create_directories(root);
        const auto destination = root / name;
        if (std::filesystem::exists(destination))
            throw std::runtime_error("Map already exists; choose an empty Maps folder for comparison");
        const auto staging =
            root / (".openslope-import-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        openslope::extract_course(disc, name, staging, [](const auto& text) { std::cout << text << '\n'; });
        try {
            std::filesystem::rename(staging, destination);
        } catch (...) {
            std::filesystem::remove_all(staging);
            throw;
        }
        std::cout << "Imported " << destination.string() << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "OpenSlope import: " << e.what() << '\n';
        return 1;
    }
}
