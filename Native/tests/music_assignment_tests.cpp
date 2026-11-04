#include "import/music_assignment.hpp"
#include <algorithm>
#include <iostream>
#include <map>

using namespace openslope;
using import_detail::assign_map_music;

void check(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

int main(int argc, char** argv) {
    try {
        if (argc == 3) {
            const auto courses = disc_courses(open_disc(argv[1]));
            nlohmann::json report = nlohmann::json::array();
            for (const auto& course : courses)
                report.push_back(assign_map_music(courses, course.name, std::stoul(argv[2])).metadata);
            std::cout << report.dump() << '\n';
            return 0;
        }
        std::vector<DiscCourse> routes;
        for (unsigned i = 0; i < 15; ++i) {
            const auto route = "SSXOT_ROUTE" + std::to_string(100 + i);
            routes.push_back({route + "_DAY"});
            if (i % 3)
                routes.push_back({route + "_NIGHT"});
        }
        std::map<std::string, std::vector<std::size_t>> assigned;
        std::vector<unsigned> coverage(41);
        for (const auto& route : routes) {
            const auto assignment = assign_map_music(routes, route.name, 41);
            const auto key = assignment.metadata.at("Map").get<std::string>();
            check(assignment.indices.size() == 2 || assignment.indices.size() == 3, "41 songs / 15 maps needs 2 or 3");
            if (assigned.contains(key))
                check(assigned.at(key) == assignment.indices, "Day and night must share their assignment");
            else {
                assigned[key] = assignment.indices;
                for (const auto song : assignment.indices)
                    ++coverage.at(song);
            }
        }
        check(assigned.size() == 15 && std::all_of(coverage.begin(), coverage.end(), [](auto n) { return n == 1; }),
              "Each catalogue song must appear once across the base maps");
        std::reverse(routes.begin(), routes.end());
        for (const auto& route : routes) {
            const auto assignment = assign_map_music(routes, route.name, 41);
            check(assigned.at(assignment.metadata.at("Map").get<std::string>()) == assignment.indices,
                  "Discovery order must not change music");
        }
        std::vector<DiscCourse> many;
        for (unsigned i = 0; i < 46; ++i)
            many.push_back({"SSX3_ROUTE" + std::to_string(100 + i)});
        for (unsigned i = 0; i < many.size(); ++i) {
            check(assign_map_music(many, many[i].name, 15).indices == std::vector<std::size_t>{i % 15},
                  "Maps outnumbering songs must cycle one catalogue song each");
            check(assign_map_music(many, many[i].name, many.size()).indices == std::vector<std::size_t>{i},
                  "Equal counts must assign the matching song index");
        }
        check(assign_map_music(many, many[0].name, 0).indices.empty(), "Empty catalogues must stay empty");
        const auto all = assign_map_music(std::span<const DiscCourse>{}, "", 41);
        check(all.indices.size() == 41 && all.indices.front() == 0 && all.indices.back() == 40,
              "Explicit catalogue exports must remain available");
        bool failed = false;
        try {
            assign_map_music(many, "UNKNOWN", 15);
        } catch (const std::exception&) {
            failed = true;
        }
        check(failed, "Unknown maps must not silently receive the whole catalogue");
        std::cout
            << "Music assignment PASS: balanced catalogue partition, stable order, variants, cycling and export\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
