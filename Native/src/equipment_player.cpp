#include "openslope/player.hpp"

namespace openslope {
EquipmentInput Player::equipment_frame(EquipmentInput input) const {
    if (input.relative) {
        for (auto& h : input.hands)
            h.position += rider_.position;
        for (auto& r : input.rays)
            r.origin += rider_.position;
        input.head += rider_.position;
        input.relative = false;
    }
    return input;
}

bool Player::aim_board(const EquipmentRay& ray, bool desktop) const {
    if (!on_foot_ || carry_.held() || reset_pending() || recovering())
        return false;
    const EquipmentPose deck{render_board_position(), render_forward(), render_up()};
    if (desktop &&
        length(equipment_nearest(deck, rider_.position + Vec3{0, 1.65, 0}) - (rider_.position + Vec3{0, 1.65, 0})) > 4)
        return false;
    const auto t = equipment_ray(deck, ray, .1, desktop ? 100 : 4);
    if (!t)
        return false;
    const auto end = ray.origin + normalized(ray.direction) * (*t);
    if (const auto hit = terrain_.intersect(ray.origin, end); hit && hit->t < .99)
        return false;
    if (const auto hit = world_.ray(ray.origin, end); hit && hit->response && hit->t < .99)
        return false;
    return true;
}

void Player::drop_board(bool motion) {
    if (!carry_.held())
        return;
    const auto drop = carry_.release(motion);
    loose_board_ = {
        drop.pose.position, drop.pose.position, drop.velocity, drop.pose.forward, drop.pose.up, false, 1, 0};
    loose_board_.spin = drop.spin;
    loose_board_.thrown = motion;
    holding_hand_ = {};
}

bool Player::equip_held_board() {
    if (!carry_.held() || !on_foot_)
        return false;
    const auto position = rider_.position, velocity = rider_.velocity;
    const auto heading = normalized(project(carry_.pose().forward, {0, 1, 0}), camera_forward());
    const bool airborne = !rider_.grounded;
    const auto serial = placement_serial_;
    warp(position, heading, velocity, rider_.normal);
    rider_.speed_cap = std::max(rider_.speed_cap, length(velocity));
    if (airborne) {
        rider_.grounded = false;
        rider_.motion = Motion::Air;
        rider_.control = Control::Air;
        placement_serial_ = serial;
    }
    return true;
}

bool Player::tick_equipment(const EquipmentInput& raw) {
    const auto input = equipment_frame(raw);
    const auto pressed = grip_press_, released = grip_release_, triggered = trigger_press_;
    grip_press_ = grip_release_ = trigger_press_ = {};
    board_highlight_ = false;
    if (reset_pending() || recovering()) {
        if (carry_.held())
            drop_board(false);
        return false;
    }
    if (carry_.held()) {
        const auto hand = *carry_.hand();
        if (!input.hands[hand].valid)
            drop_board(false);
        else {
            holding_hand_ = input.hands[hand];
            holding_relative_ = raw.relative;
            carry_.follow(holding_hand_, contract_.tick_seconds());
        }
    }
    const auto transition = [&](bool changed) {
        grip_held_ = raw.grip;
        trigger_held_ = raw.trigger;
        grip_press_ = grip_release_ = trigger_press_ = {};
        return changed;
    };
    for (unsigned i = 0; i < 2; ++i) {
        const auto& hand = input.hands[i];
        const EquipmentPose deck{render_board_position(), render_forward(), render_up()};
        const bool summon = hand.valid && equipment_summon(input.head, input.facing, hand.position);
        const bool reach = hand.valid && equipment_distance(deck, hand) <= (carry_.held() ? .35 : 1.5);
        const bool ray = aim_board(input.rays[i], !input.tracked);
        board_highlight_ |= ray || (input.tracked && on_foot_ && (reach || summon));
        if (triggered[i]) {
            if (carry_.held())
                return transition(equip_held_board());
            if (!on_foot_)
                return transition(interact_board());
            if (ray) {
                const auto b = loose_board_;
                warp(b.position, b.forward, b.velocity + (b.grounded ? b.ground_velocity : Vec3{}), b.up);
                rider_.lead = b.lead;
                return transition(true);
            }
        }
        if (!pressed[i] || !hand.valid)
            continue;
        if (carry_.held() && carry_.hand() == i)
            continue;
        const bool airborne = !on_foot_ && !rider_.grounded;
        if (!on_foot_ && !airborne)
            continue;
        if (!summon && !(input.tracked ? reach : ray) && !airborne)
            continue;
        const auto position = rider_.position, velocity = rider_.velocity;
        if (airborne) {
            const auto serial = placement_serial_;
            interact_board();
            placement_serial_ = serial;
            rider_.position = rider_.previous_position = position;
            rider_.velocity = velocity;
        }
        std::optional<Vec3> contact;
        if (!input.tracked && ray) {
            const auto t = equipment_ray(deck, input.rays[i], 0, 100);
            if (t)
                contact = input.rays[i].origin + normalized(input.rays[i].direction) * (*t);
        }
        carry_.grab(i, hand, deck, summon, contact, !input.tracked && !summon);
        holding_hand_ = hand;
        holding_relative_ = raw.relative;
        grip_held_ = raw.grip;
        trigger_held_ = raw.trigger;
    }
    if (carry_.held() && released[*carry_.hand()])
        drop_board(true);
    return false;
}
} // namespace openslope
