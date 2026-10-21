#include "openslope/appearance.hpp"
#include "openslope/model_animation.hpp"
#include "openslope/props.hpp"
#include "openslope/world_logic.hpp"
#include <iostream>
#include <stdexcept>

int main(int argc, char** argv) {
    try {
        if (argc != 2 && argc != 3 && argc != 5)
            throw std::runtime_error("Supply the authored SSX map");
        if (argc == 5 && std::string(argv[2]) == "--gem") {
            const auto host = std::stoull(argv[3]);
            const auto tier = std::stod(argv[4]);
            auto world = openslope::WorldLogic::load(argv[1]);
            world.restart(openslope::RunMode::Showoff);
            const auto props = openslope::Props::load(argv[1]);
            if (host >= props.instances.size())
                throw std::runtime_error("Missing gem placement");
            const auto model = props.instances[host].model;
            const auto clips = openslope::PropClips::load(argv[1]);
            if (clips.frames(model) <= 0 || clips.delta(model, 0) == clips.delta(model, 30))
                throw std::runtime_error("SSX source model animation does not rotate the gem");
            const std::array<openslope::Vec3, 1> eye{{props.instances[host].bounds.center()}};
            world.tick(0, 0, eye);
            for (unsigned i = 0; i < 30; ++i)
                world.tick(1. / 60, 0, eye);
            if (std::none_of(world.motions().begin(), world.motions().end(), [&](const auto& motion) {
                    return motion.instance == host && motion.previous != motion.current;
                }))
                throw std::runtime_error("Imported persistent graph does not spin the gem");
            world.take_actions();
            world.contact(host, 12, true);
            const auto actions = world.take_actions();
            if (std::none_of(actions.begin(), actions.end(),
                             [&](const auto& action) {
                                 return action.kind == openslope::WorldActionKind::Multiplier && action.value == tier;
                             }) ||
                (world.flags()[host] & (openslope::WorldDraw | openslope::WorldCollide)))
                throw std::runtime_error("Gem contact did not award its tier and clear draw/collision together");
            world.contact(host, 12, true);
            if (!world.take_actions().empty())
                throw std::runtime_error("Collected gem can reward twice");
            world.restart(openslope::RunMode::Showoff);
            if (!(world.flags()[host] & openslope::WorldDraw))
                throw std::runtime_error("Restart does not restore the collected gem");
            world.restart(openslope::RunMode::Freeride);
            if (world.flags()[host] & openslope::WorldDraw)
                throw std::runtime_error("Showoff gem leaked into Freeride");
            if (world.unsupported())
                throw std::runtime_error("SSX gem reached an unsupported runtime operation");
            std::cout << "PASS: imported SSX gem spin, x" << tier << " collection, tombstone, restart and mode gate\n";
            return 0;
        }
        const auto appearance = openslope::Appearance::load(openslope::Terrain::load(argv[1]));
        if (!appearance.images.contains("Textures/Particles/part.png") || !appearance.missing.empty())
            throw std::runtime_error("Imported SSX terrain and nested riding sprites must load together");
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
