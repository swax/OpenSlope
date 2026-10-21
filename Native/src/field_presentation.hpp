#pragma once
#include "openslope/ai_field.hpp"
#include "openslope/avatar.hpp"
#include "render_math.hpp"

namespace openslope {
inline std::vector<Matrix> append_opponents(const Player& player, Avatar& avatar, std::vector<Vertex>& figures,
                                            Vec3 eye, std::vector<unsigned>* designs = nullptr) {
    std::vector<Matrix> boards;
    if (const auto* field = player.ai_field()) {
        boards.reserve(field->size());
        for (unsigned i = 0; i < field->size(); ++i) {
            const auto& actor = field->rider(i);
            if (length(actor.render_position() - eye) > 400)
                continue;
            const auto body = avatar.mesh(avatar_pose(actor), false, false, eye, {}, &actor.avatar_lighting());
            figures.insert(figures.end(), body.begin(), body.end());
            boards.push_back(board_transform(actor.render_board_position(), actor.render_forward(), actor.render_up()));
            if (designs)
                designs->push_back(actor.board_design());
        }
    }
    return boards;
}

class FieldEffects {
public:
    FieldEffects(const Player& player, Vec3 eye)
        : player_(player), field_(player.ai_field() != nullptr), local_boost_(player.boost_trail_mesh()) {
        if (!field_)
            return;
        const auto add = [&](const Player& actor) {
            const auto append = [](auto& out, auto source, std::size_t capacity, std::size_t group) {
                const auto count = std::min(source.size(), capacity - out.size()) / group * group;
                out.insert(out.end(), source.begin(), source.begin() + count);
            };
            append(sprites_, actor.effects().sprites(), 1024, 1);
            append(wake_, actor.effects().wake(), 594, 6);
            append(sheet_, actor.effects().sheet(), 2286, 18);
            if (&actor == &player_)
                append(boost_, local_boost_.vertices(), 17 * 84, 12);
            else
                append(boost_, actor.boost_trail_mesh().vertices(), 17 * 84, 12);
        };
        add(player);
        std::vector<const Player*> nearby;
        for (unsigned i = 0; i < player.ai_field()->size(); ++i)
            if (const auto& actor = player.ai_field()->rider(i); length(actor.render_position() - eye) <= 100)
                nearby.push_back(&actor);
        std::stable_sort(nearby.begin(), nearby.end(), [&](const auto* a, const auto* b) {
            return length(a->render_position() - eye) < length(b->render_position() - eye);
        });
        for (const auto* actor : nearby)
            add(*actor);
    }

    std::span<const Sprite> sprites() const { return field_ ? sprites_ : player_.effects().sprites(); }

    std::span<const WakeVertex> wake() const { return field_ ? wake_ : player_.effects().wake(); }

    std::span<const SprayVertex> sheet() const { return field_ ? sheet_ : player_.effects().sheet(); }

    std::span<const BoostTrailVertex> boost() const { return field_ ? boost_ : local_boost_.vertices(); }

private:
    const Player& player_;
    bool field_;
    BoostTrailMesh local_boost_;
    std::vector<Sprite> sprites_;
    std::vector<WakeVertex> wake_;
    std::vector<SprayVertex> sheet_;
    std::vector<BoostTrailVertex> boost_;
};
} // namespace openslope
