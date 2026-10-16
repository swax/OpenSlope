#include "openslope/world_import.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>

int main(int argc, char** argv) {
    try {
        if (argc == 3 && std::string(argv[1]) == "--surface-spray") {
            std::ifstream file(argv[2], std::ios::binary);
            const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(file),
                                                  std::istreambuf_iterator<char>()};
            if (openslope::executable_surface_spray_profile(bytes).empty())
                throw std::runtime_error("Authored surface profile is missing");
            for (const auto late : {false, true}) {
                unsigned calls = 0;
                bool cancelled = false;
                try {
                    openslope::executable_surface_spray_profile(bytes, [&] { return ++calls > (late ? 8u : 0u); });
                } catch (const std::runtime_error& e) {
                    cancelled = std::string(e.what()) == "Import cancelled";
                }
                if (!cancelled)
                    throw std::runtime_error("Surface initializer cancellation did not propagate");
            }
            std::cout << "PASS: surface data API preserves immediate and mid-scan cancellation\n";
            return 0;
        }
        if (argc != 2)
            throw std::runtime_error("Supply the authored executable fixture");
        std::ifstream file(argv[1], std::ios::binary);
        const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
        if (openslope::executable_world_profile(bytes, "GARI").empty())
            throw std::runtime_error("Authored profile is missing");
        if (!openslope::executable_world_profile(bytes, "custom").empty())
            throw std::runtime_error("Unknown course acquired an invented slot");
        for (const auto late : {false, true}) {
            unsigned calls = 0;
            bool cancelled = false;
            try {
                openslope::executable_world_profile(bytes, "GARI", [&] { return ++calls > (late ? 8u : 0u); });
            } catch (const std::runtime_error& e) {
                cancelled = std::string(e.what()) == "Import cancelled";
            }
            if (!cancelled)
                throw std::runtime_error("Initializer scan must propagate cancellation");
        }
        std::cout << "PASS: direct settings API preserves unknown slots and immediate/mid-scan cancellation\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
