#include "openslope/audio_resolver.hpp"
#include <fstream>
#include <iostream>
#include <stdexcept>

int main(int argc, char** argv) {
    try {
        if (argc != 3)
            throw std::runtime_error("Supply an authored selector and domain size");
        std::ifstream input(argv[1], std::ios::binary);
        const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
        const auto count = std::stoul(argv[2]);
        const auto groups = openslope::executable_board_groups(bytes, count);
        if (!groups || groups->size() != count)
            throw std::runtime_error("Authored selector is missing");
        std::cout << '[';
        for (std::size_t i = 0; i < count; ++i)
            std::cout << (i ? "," : "") << groups->at(i);
        std::cout << "]\n";
        for (const auto late : {false, true}) {
            unsigned calls = 0;
            bool cancelled = false;
            try {
                openslope::executable_board_groups(bytes, count, [&] { return ++calls > (late ? 8u : 0u); });
            } catch (const std::runtime_error& e) {
                cancelled = std::string(e.what()) == "Import cancelled";
            }
            if (!cancelled)
                throw std::runtime_error("Board selector must propagate cancellation");
        }
        for (const auto invalid : {0u, 257u}) {
            bool rejected = false;
            try {
                openslope::executable_board_groups(bytes, invalid);
            } catch (const std::runtime_error&) {
                rejected = true;
            }
            if (!rejected)
                throw std::runtime_error("Invalid domain accepted");
        }
        std::cout << "PASS: scalar board API validates domains and immediate/mid-analysis cancellation\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
