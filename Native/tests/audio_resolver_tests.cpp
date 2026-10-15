#include "openslope/audio_resolver.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>

int main(int argc, char** argv) {
    try {
        if (argc != 2)
            throw std::runtime_error("Supply the authored dispatcher fixture");
        std::ifstream file(argv[1], std::ios::binary);
        const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
        const auto routes = openslope::executable_collision_routes(bytes);
        if (!routes || routes->at(17) != openslope::SoundRoute{2, 0} || routes->contains(0))
            throw std::runtime_error("Authored resolver must preserve ABI outputs and silent cases");
        for (const auto late : {false, true}) {
            unsigned calls = 0;
            bool cancelled = false;
            try {
                openslope::executable_collision_routes(bytes, [&] { return ++calls > (late ? 8u : 0u); });
            } catch (const std::runtime_error& e) {
                cancelled = std::string(e.what()) == "Import cancelled";
            }
            if (!cancelled)
                throw std::runtime_error("Dispatcher analysis must propagate cancellation");
        }
        std::cout << "PASS: dispatcher API retains silent cases and immediate/mid-analysis cancellation\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
