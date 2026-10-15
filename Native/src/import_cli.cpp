#include "import_internal.hpp"
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
                         "<map-folder> | world <iso> <course> | collision-routes <iso>\n";
            return 1;
        }
        const std::string operation = argv[1];
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
