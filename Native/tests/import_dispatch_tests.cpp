#include "openslope/import.hpp"
#include <algorithm>
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}

template <typename Action> void fails(Action action, const std::string& message) {
    try {
        action();
    } catch (const std::exception& error) {
        require(std::string(error.what()).find(message) != std::string::npos, error.what());
        return;
    }
    throw std::runtime_error("Expected import failure");
}

openslope::DiscInput input(const std::vector<std::uint8_t>& bytes) {
    return {bytes.size(), [&bytes](std::uint64_t offset, std::span<std::uint8_t> output) {
                require(offset <= bytes.size() && output.size() <= bytes.size() - offset, "Out-of-bounds read");
                std::copy_n(bytes.begin() + static_cast<std::ptrdiff_t>(offset), output.size(), output.begin());
            }};
}
} // namespace

int main() {
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-import-dispatch-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    try {
        std::filesystem::create_directory(root);
        std::vector<std::uint8_t> bytes(17 * 2048);
        const auto disc = input(bytes);
        fails([&] { openslope::disc_courses(disc); }, "No supported game");
        fails([&] { openslope::disc_courses(disc, [] { return true; }); }, "Import cancelled");
        const auto destination = root / "new-map";
        fails([&] { openslope::extract_course(disc, "UNKNOWN", destination); }, "No supported game");
        require(!std::filesystem::exists(destination), "Failed discovery left an import destination");
        bool cancelled = false;
        fails(
            [&] {
                openslope::extract_course(
                    disc, "UNKNOWN", destination, [&](const auto&) { cancelled = true; }, [&] { return cancelled; });
            },
            "Import cancelled");
        require(!std::filesystem::exists(destination), "Cancellation left an import destination");
        fails(
            [&] {
                openslope::extract_course(disc, "UNKNOWN", destination,
                                          [](const auto&) { throw std::runtime_error("Host progress failure"); });
            },
            "Host progress failure");
        require(!std::filesystem::exists(destination), "Progress failure left an import destination");
        fails([&] { openslope::extract_course(disc, "../unsafe", destination); }, "Invalid course name");
        require(!std::filesystem::exists(destination), "Invalid course created a destination");
        std::filesystem::create_directory(destination);
        std::ofstream(destination / "keep.txt") << "existing map";
        fails([&] { openslope::extract_course(disc, "UNKNOWN", destination); }, "already exists");
        require(std::filesystem::file_size(destination / "keep.txt") == 12, "Existing map changed");

        // A valid filesystem does not identify a game. Other GameCube titles
        // remain browsable without being passed to the Avalanche converter.
        const auto be = [&](std::size_t offset, std::uint32_t value) {
            for (unsigned i = 0; i < 4; ++i)
                bytes[offset + i] = static_cast<std::uint8_t>(value >> ((3 - i) * 8));
        };
        const std::string id = "TEST01";
        std::copy(id.begin(), id.end(), bytes.begin());
        be(0x1c, 0xc2339f3d);
        be(0x424, 0x1000);
        be(0x428, 13);
        be(0x1000, 0x01000000);
        be(0x1008, 1);
        require(openslope::disc_directory(disc, "").empty(), "Generic GameCube filesystem failed");
        fails([&] { openslope::disc_courses(disc); }, "No supported game");
        fails([&] { openslope::extract_course(disc, "AVALANCHE_CRS00_00", root / "foreign"); }, "No supported game");
        require(!std::filesystem::exists(root / "foreign"), "Foreign game left an import destination");
        std::filesystem::remove_all(root);
        std::cout << "Importer dispatch, cancellation and destination protection passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::filesystem::remove_all(root);
        std::cerr << error.what() << '\n';
        return 1;
    }
}
