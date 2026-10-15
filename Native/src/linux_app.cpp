#include "openxr_app.hpp"
#include <iostream>

int main(int argc, char** argv) {
    try {
        std::filesystem::path map;
        openslope::XrPlatform platform;
        auto mode = openslope::RunMode::Freeride;
        for (int i = 1; i < argc; ++i) {
            const std::string option = argv[i];
            if (option == "--mode" && i + 1 < argc)
                mode = openslope::run_mode(argv[++i]);
            else if (option == "--head-steering")
                platform.head_steering = true;
            else if (map.empty() && !option.starts_with("--"))
                map = option;
            else
                throw std::runtime_error(
                    "openslope_player [map folder] [--mode freeride|race|showoff] [--head-steering]");
        }
        openslope::Player player(map.empty() ? openslope::Terrain::demo() : openslope::Terrain::load(map));
        if (mode != openslope::RunMode::Freeride)
            player.configure_run(mode);
        return openslope::run_openxr(player, platform);
    } catch (const std::exception& e) {
        std::cerr << "OpenSlope native: " << e.what() << '\n';
        return 1;
    }
}
