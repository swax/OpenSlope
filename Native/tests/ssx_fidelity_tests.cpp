#include "openslope/props.hpp"
#include "openslope/world_logic.hpp"
#include <iostream>
#include <stdexcept>

int main(int argc, char** argv) {
    try {
        if (argc != 2 && argc != 3)
            throw std::runtime_error("Supply the authored SSX map");
        if (argc == 3 && std::string(argv[2]) == "--retail") {
            auto world = openslope::WorldLogic::load(argv[1]);
            const auto scene = openslope::Props::load(argv[1], false, world.flag_models(), world.faceted_models());
            std::vector<openslope::Vec3> observers;
            for (const auto& instance : scene.instances)
                if (instance.visible)
                    observers.push_back((instance.bounds.min + instance.bounds.max) * .5);
            for (unsigned tick = 0; tick < 60; ++tick)
                world.tick(1. / 60, 0, observers);
            if (world.unsupported())
                throw std::runtime_error("Enabled SSX nodes reached an unsupported runtime operation");
            std::cout << "PASS: SSX scene assembly and playback: texture states=" << world.texture_frames().size()
                      << " emitters=" << world.emitters() << " flag models=" << world.flag_models().size() << '\n';
            return 0;
        }
        const auto props = openslope::Props::load(argv[1]);
        if (props.parts.empty() || openslope::prop_alpha_mode(props.parts[0], true) != 1)
            throw std::runtime_error("Crowd-style cutout must remain cutout with fractional edge pixels");
        auto logic = openslope::WorldLogic::load(argv[1]);
        logic.restart(openslope::RunMode::Race);
        const std::array<openslope::Vec3, 1> observer{{{10, 30, -20}}};
        logic.tick(0, 0, observer);
        unsigned before = ~0u;
        for (const auto& texture : logic.texture_frames())
            if (!texture.materials.empty())
                before = texture.materials[0].frame;
        for (unsigned i = 0; i < 10; ++i)
            logic.tick(1. / 60, 0, observer);
        bool changed = false;
        for (const auto& texture : logic.texture_frames())
            if (!texture.materials.empty())
                changed |= texture.materials[0].frame != before;
        if (!changed || !logic.emitters() || logic.unsupported())
            throw std::runtime_error("Imported flipbook/cross-instance emitter must execute: changed=" +
                                     std::to_string(changed) + " emitters=" + std::to_string(logic.emitters()) +
                                     " unsupported=" + std::to_string(logic.unsupported()) +
                                     " frames=" + std::to_string(logic.texture_frames().size()));
        std::cout << "PASS: imported SSX native alpha, texture animation and particle playback\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
