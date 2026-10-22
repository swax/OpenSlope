#include "openslope/avatar.hpp"
#include "openslope/gear.hpp"
#include "openslope/ui_font.hpp"
#include <stdexcept>

namespace openslope {
namespace {
using J = AvatarJoint;

constexpr unsigned id(J j) { return unsigned(j); }

bool tracked_joint(const AvatarTracking& tracking, J joint) {
    const auto i = id(joint);
    // Runtime legs (including inferred legs) and a seated pelvis must not lift
    // the standing avatar's feet. Upper-body and controller tracking still apply.
    return !(tracking.seated && (joint == J::Hips || i >= id(J::LeftHip))) && tracking.valid[i] &&
           finite(tracking.joints[i]) && length(tracking.joints[i] - tracking.head) < 2.5;
}

Vec3 knee(Vec3 hip, Vec3 ankle, Vec3 bend, double upper, double lower) {
    const auto delta = ankle - hip;
    const auto d = std::clamp(length(delta), std::abs(upper - lower) + .001, upper + lower - .001);
    const auto axis = normalized(delta, {0, -1, 0});
    const auto along = (upper * upper - lower * lower + d * d) / (2 * d),
               height = std::sqrt(std::max(0., upper * upper - along * along));
    const auto fallback = normalized(cross(axis, std::abs(axis.x) < .8 ? Vec3{1, 0, 0} : Vec3{0, 1, 0}));
    return hip + axis * along + normalized(project(bend, axis), fallback) * height;
}

Vec3 align(Vec3 v, Vec3 from, Vec3 to) {
    from = normalized(from);
    to = normalized(to);
    const auto c = std::clamp(dot(from, to), -1., 1.);
    const auto axis = cross(from, to);
    if (c < -.999999)
        return rotate(v, normalized(cross(from, std::abs(from.x) < .8 ? Vec3{1, 0, 0} : Vec3{0, 1, 0})), pi);
    return v + cross(axis, v) + cross(axis, cross(axis, v)) / (1 + c);
}

Vertex vertex(Vec3 p, std::array<float, 3> c) { return {float(p.x), float(p.y), float(p.z), c[0], c[1], c[2]}; }

void quad(std::vector<Vertex>& out, Vec3 a, Vec3 b, Vec3 c, Vec3 d, std::array<float, 3> colour) {
    for (auto p : {a, b, c, a, c, d})
        out.push_back(vertex(p, colour));
}

void tube(std::vector<Vertex>& out, Vec3 a, Vec3 b, double radius, std::array<float, 3> colour) {
    const auto axis = normalized(b - a),
               r = normalized(cross(axis, std::abs(axis.y) < .8 ? Vec3{0, 1, 0} : Vec3{1, 0, 0})), u = cross(axis, r);
    for (unsigned i = 0; i < 12; ++i) {
        const auto t = i * 2 * pi / 12, s = (i + 1) * 2 * pi / 12;
        const auto x = (r * std::cos(t) + u * std::sin(t)) * radius, y = (r * std::cos(s) + u * std::sin(s)) * radius;
        quad(out, a + x, a + y, b + y, b + x, colour);
        out.push_back(vertex(a, colour));
        out.push_back(vertex(a + y, colour));
        out.push_back(vertex(a + x, colour));
        out.push_back(vertex(b, colour));
        out.push_back(vertex(b + x, colour));
        out.push_back(vertex(b + y, colour));
    }
}

// An authored five-column font; pixels become ordinary depth-tested triangles.

void label(std::vector<Vertex>& out, std::string_view text, Vec3 anchor, Vec3 eye, double row,
           std::array<float, 3> ink = {1, 1, 1}) {
    const auto normal = normalized(eye - anchor, {0, 0, 1}), right = normalized(cross({0, 1, 0}, normal), {1, 0, 0}),
               up = normalized(cross(normal, right));
    constexpr double pixel = .002;
    const auto width = double(text.size()) * 6 * pixel;
    const auto base = anchor + up * row - right * (width * .5);
    quad(out, base - right * .003 - up * .003, base + right * (width + .003) - up * .003,
         base + right * (width + .003) + up * .017, base - right * .003 + up * .017, {.035f, .045f, .065f});
    for (std::size_t i = 0; i < text.size(); ++i) {
        const auto bits = ui_glyph(text[i]);
        for (unsigned y = 0; y < 7; ++y)
            for (unsigned x = 0; x < 5; ++x)
                if (bits[y] & (1u << (4 - x))) {
                    const auto p = base + right * (double(i * 6 + x) * pixel) + up * ((6 - y) * pixel) + normal * .0005;
                    quad(out, p, p + right * pixel, p + (right + up) * pixel, p + up * pixel, ink);
                }
    }
}

void controller(std::vector<Vertex>& out, const ControllerPose& grip, unsigned side, bool labels, Vec3 eye,
                bool on_foot) {
    const auto c = controller_draw_pose(grip);
    if (!c.valid)
        return;
    const auto colour = side ? std::array<float, 3>{1, .62f, .14f} : std::array<float, 3>{.52f, .94f, .20f};
    const auto top = c.position + c.up * .04 + c.forward * .015;
    if (c.touch) {
        const auto basis = [&](Vec3 v) {
            return grip.right * (side ? v.x : -v.x) + grip.up * v.y - grip.forward * v.z;
        };
        const auto& model = touch_plus_mesh();
        for (std::size_t i = 0; i < model.indices.size(); i += 3)
            for (const auto k : {0u, side ? 1u : 2u, side ? 2u : 1u}) {
                const auto& v = model.vertices[model.indices[i + k]];
                const auto normal = normalized(basis({v.nx, v.ny, v.nz}));
                const auto light = float(.65 + .35 * std::max(0., dot(normal, normalized(Vec3{-.3, .8, -.5}))));
                out.push_back(vertex(grip.position + basis({v.x, v.y, v.z}), {v.r * light, v.g * light, v.b * light}));
            }
        const auto normal = normalized(grip.up * std::cos(32 * pi / 180) + grip.forward * std::sin(32 * pi / 180));
        const auto right = grip.right * (side ? 1. : -1.), up = normalized(project(grip.forward, normal));
        for (unsigned upper = 0; upper < 2; ++upper) {
            const auto point = grip.position +
                               basis(upper ? Vec3{-.0087, .0031, -.0617} : Vec3{-.0027, .0112, -.0488}) + normal * .001;
            const auto glyph = ui_glyph(side ? (upper ? 'B' : 'A') : (upper ? 'Y' : 'X'));
            constexpr double pixel = .00045;
            for (unsigned y = 0; y < 7; ++y)
                for (unsigned x = 0; x < 5; ++x)
                    if (glyph[y] & (1u << (4 - x))) {
                        const auto p = point + right * ((double(x) - 2.5) * pixel) + up * ((3.5 - y) * pixel);
                        quad(out, p, p + right * pixel, p + (right + up) * pixel, p + up * pixel, {.92f, .92f, .92f});
                    }
        }
    } else {
        tube(out, c.position - c.up * .09, top, .026, {.22f, .25f, .3f});
        tube(out, top - c.up * .014, top + c.up * .014, .043, {.1f, .12f, .17f});
        tube(out, top + c.up * .016 - c.right * .015, top + c.up * .026 - c.right * .015, .011, colour);
        tube(out, c.position + c.forward * .027, c.position + c.forward * .043, .012, {.72f, .77f, .84f});
    }
    if (labels) {
        const auto anchor = top + c.up * .07 + c.forward * .08;
        tube(out, top, anchor, .0015, colour);
        if (c.touch) {
            if (side) {
                label(out, on_foot ? "A JUMP" : "A HOLD / RELEASE JUMP", anchor, eye, .100);
                label(out, on_foot ? "B BOOST / RUN" : "B BOOST", anchor, eye, .075);
                label(out, on_foot ? "TRIGGER MOUNT" : "TRIGGER DISMOUNT", anchor, eye, .050);
                if (on_foot)
                    label(out, "STICK TURN", anchor, eye, .025);
                label(out, "CLICK 1ST / 3RD", anchor, eye, 0);
            } else {
                label(out, on_foot ? "STICK WALK" : "STICK TURN / POSTURE", anchor, eye, .100);
                label(out, on_foot ? "X RECALL BOARD" : "X COURSE RESET", anchor, eye, .075);
                label(out, on_foot ? "TRIGGER MOUNT" : "TRIGGER DISMOUNT", anchor, eye, .050);
                label(out, "Y CONTROLS", anchor, eye, .025);
                if (!on_foot)
                    label(out, "CLICK EXIT RAIL", anchor, eye, 0);
            }
        } else {
            label(out, "SELECT JUMP", anchor, eye, .025);
            label(out, "LEFT MENU RESET", anchor, eye, 0);
            label(out, on_foot ? "RIGHT MENU MOUNT" : "RIGHT MENU DISMOUNT", anchor, eye, -.025);
        }
    }
}

struct BoneTarget {
    Vec3 head, tail;
};

BoneTarget target(std::string_view name, const AvatarPose& p) {
    const auto pair = [&](J a, J b) { return BoneTarget{p.joint(a), p.joint(b)}; };
    if (name == "Hips")
        return pair(J::Hips, J::Spine);
    if (name == "Spine")
        return pair(J::Spine, J::Chest);
    if (name == "Chest" || name == "ChestUpper")
        return pair(J::Chest, J::Neck);
    if (name == "Neck")
        return pair(J::Neck, J::Head);
    if (name == "Head")
        return {p.joint(J::Head), p.joint(J::Head) + p.head_up * .105};
    const bool left = name.ends_with(".L");
    if (name.starts_with("Clavicle"))
        return pair(J::Neck, left ? J::LeftShoulder : J::RightShoulder);
    if (name.starts_with("UpperArm"))
        return pair(left ? J::LeftShoulder : J::RightShoulder, left ? J::LeftElbow : J::RightElbow);
    if (name.starts_with("LowerArm"))
        return pair(left ? J::LeftElbow : J::RightElbow, left ? J::LeftWrist : J::RightWrist);
    if (name.starts_with("Hand")) {
        const auto h = p.joint(left ? J::LeftWrist : J::RightWrist);
        const auto& c = p.controllers[left ? 0 : 1];
        return {h, h + (c.valid ? c.forward : -p.up) * .1};
    }
    if (name.starts_with("Pelvis"))
        return pair(J::Hips, left ? J::LeftHip : J::RightHip);
    if (name.starts_with("UpperLeg"))
        return pair(left ? J::LeftHip : J::RightHip, left ? J::LeftKnee : J::RightKnee);
    if (name.starts_with("LowerLeg"))
        return pair(left ? J::LeftKnee : J::RightKnee, left ? J::LeftAnkle : J::RightAnkle);
    if (name.starts_with("Foot"))
        return pair(left ? J::LeftAnkle : J::RightAnkle, left ? J::LeftToe : J::RightToe);
    throw std::runtime_error("Unknown figure bone");
}
} // namespace

ControllerPose controller_draw_pose(const ControllerPose& grip) {
    auto c = grip;
    c.up = grip.forward;
    c.forward = -grip.up;
    return c;
}

AvatarPose avatar_pose(const Player& player, const AvatarTracking* tracking, const AvatarLook* look) {
    if (tracking && (!finite(tracking->head) || !finite(tracking->forward) || !finite(tracking->up) ||
                     length(cross(tracking->forward, tracking->up)) < .1))
        tracking = nullptr;
    AvatarPose p;
    p.on_foot = player.on_foot();
    const auto root = p.on_foot ? player.render_position() : player.render_board_position();
    const auto& rider = player.rider();
    const auto motion = player.rider_motion();
    const auto crouch = std::clamp(motion.crouch, 0., 1.);
    const auto& run = player.course_run().status();
    if (run.mode != RunMode::Freeride) {
        p.run_text[0] = run_readout(run);
        p.run_text[1] = run_notice(run);
        p.run_text[2] = "CP " + std::to_string(run.checkpoints) + " LAP " + std::to_string(run.lap) + "/" +
                        std::to_string(run.passes);
    }
    if (player.reset_pending() && !p.run_text[0].empty())
        p.run_text[1] = "RETURNING TO COURSE";
    if (run.mode != RunMode::Freeride) {
        const auto& score = player.scoring().status();
        const auto display = trick_display(player.scoring());
        const auto boost =
            score.active ? "BOOST " + std::to_string(player.scoring().meter_segments()) + "/15" : "BOOST UNLIMITED";
        p.score_text[0] = run.mode == RunMode::Showoff ? "SCORE " + std::to_string(score.banked) : boost;
        if (run.mode == RunMode::Showoff) {
            p.score_text[1] = display.state == TrickDisplayState::None
                                  ? "LAND TO BANK"
                                  : (display.state == TrickDisplayState::Live   ? "TRICK +"
                                     : display.state == TrickDisplayState::Lost ? "LOST "
                                                                                : "BANKED ") +
                                        std::to_string(display.points);
            p.score_text[2] = boost;
            p.score_text[3] = display.state == TrickDisplayState::Live ? display.detail : "";
            if (score.multiplier > 1)
                p.score_text[2] += " X" + std::to_string(score.multiplier);
            p.score_result = display.state == TrickDisplayState::Lost     ? -1
                             : display.state == TrickDisplayState::Banked ? 1
                                                                          : 0;
        }
    }
    const auto nose = player.render_forward(), deck_up = player.render_up();
    const auto bank = player.contract().value("steering", "bankMaxDeg") * pi / 180;
    p.up = p.on_foot ? Vec3{0, 1, 0}
                     : normalized(rotate(
                           deck_up, nose,
                           rider.motion == Motion::Ground ? bank * (rider.lean - motion.lean * .4) * rider.lead : 0));
    // Anatomical left/right and bindings stay attached to the same deck ends in switch.
    p.forward = p.on_foot ? normalized(project(rider.forward, p.up)) : normalized(rotate(nose, p.up, -pi * .5));
    const auto right = normalized(cross(p.forward, p.up));
    const auto gait = motion.walking * std::sin(player.walk_phase());
    const auto weight = Vec3{0, 9.8, 0} + motion.acceleration;
    const auto balance = length(weight) > 1 ? normalized(weight) : p.up;
    const auto grounded_balance = rider.grounded && !p.on_foot ? project(balance - p.up, p.up) : Vec3{};
    const auto coil = crouch * (1 - .55 * std::abs(motion.lean));
    const auto hip_height =
        (p.on_foot ? 1.034 : .927 - .23 * std::abs(motion.lean)) - (p.on_foot ? .35 : .22) * coil + .097 * motion.pop;
    auto hips = root + p.up * (hip_height + motion.hip_lag) + grounded_balance * .08;
    if (p.on_foot)
        hips += right * (gait * .015) + p.up * (motion.walking * .012 * std::cos(2 * player.walk_phase()));
    else
        hips -= p.forward * (.05 * motion.lean * rider.lead);
    // Place the feet first, then lower the pelvis to keep both fixed-length legs in reach.
    for (unsigned side = 0; side < 2; ++side) {
        const auto sign = side ? 1. : -1.;
        const auto stride = p.on_foot ? -sign * gait * .18 : 0.;
        p.joints[id(side ? J::RightAnkle : J::LeftAnkle)] =
            p.on_foot ? root + right * (sign * .105) + p.forward * stride + p.up * (.12 + std::max(0., stride) * .2)
                      : root - nose * (sign * .27) + deck_up * .12;
    }
    for (unsigned side = 0; side < 2; ++side) {
        const auto sign = side ? 1. : -1.;
        const auto ankle = p.joint(side ? J::RightAnkle : J::LeftAnkle);
        const auto offset = right * (sign * .105) - p.up * .087;
        const auto delta = hips + offset - ankle;
        constexpr double reach = .4165 + .4182 - .001;
        const auto across = project(delta, p.up);
        const auto allowed = std::sqrt(std::max(0., reach * reach - dot(across, across)));
        hips -= p.up * std::max(0., dot(delta, p.up) - allowed);
    }
    const auto lumbar =
        normalized(p.up + grounded_balance * .2 + p.forward * (.48 * coil + .06 * std::abs(motion.lean)));
    const auto thoracic = normalized(p.up + grounded_balance * .45 + p.forward * (.30 * coil));
    p.joints[id(J::Hips)] = hips;
    p.joints[id(J::Spine)] = hips + lumbar * .14162;
    p.joints[id(J::Chest)] = hips + lumbar * .194;
    p.joints[id(J::Neck)] = p.joint(J::Chest) + thoracic * .244;
    p.joints[id(J::Head)] = p.joint(J::Neck) + thoracic * .075;
    p.head_forward = p.on_foot ? p.forward : nose * double(rider.lead);
    const auto level = normalized(project(Vec3{0, 1, 0}, p.head_forward), p.up);
    p.head_up = p.on_foot
                    ? p.up
                    : normalized(project(deck_up * (rider.grounded ? .2 : .35) + level * (rider.grounded ? .8 : .65),
                                         p.head_forward),
                                 p.up);
    if (!p.on_foot)
        p.head_forward = normalized(rotate(p.head_forward, p.head_up, motion.glance));
    if (look && finite(look->forward) && finite(look->up) && length(cross(look->forward, look->up)) > .1) {
        p.head_forward = normalized(look->forward);
        p.head_up = normalized(project(look->up, p.head_forward));
    }
    if (tracking) {
        p.up = {0, 1, 0};
        p.forward = normalized(project(tracking->forward, p.up), player.camera_forward());
        // A held-out controller pair supplies a wearer frame even while looking over a shoulder.
        const auto& left = tracking->controllers[0];
        const auto& right_hand = tracking->controllers[1];
        if (left.valid && right_hand.valid && finite(left.position) && finite(right_hand.position)) {
            const auto span = project(right_hand.position - left.position, p.up);
            const auto ahead = project((left.position + right_hand.position) * .5 - tracking->head, p.up);
            const auto facing = normalized(cross(p.up, span));
            if (length(span) > .2 && length(ahead) > .12 && dot(facing, normalized(ahead)) > .5)
                p.forward = facing;
        }
        const auto r = normalized(cross(p.forward, p.up));
        const auto h = tracking->head;
        p.head_forward = normalized(tracking->forward, p.forward);
        p.head_up = normalized(project(tracking->up, p.head_forward), p.up);
        p.joints[id(J::Head)] = h - p.head_up * .105 - p.head_forward * .11;
        p.joints[id(J::Neck)] = p.joint(J::Head) - p.up * .075;
        p.joints[id(J::Chest)] = p.joint(J::Neck) - p.up * .244;
        p.joints[id(J::Spine)] = p.joint(J::Chest) - p.up * .05238;
        p.joints[id(J::Hips)] = p.joint(J::Chest) - p.up * .194;
        for (unsigned side = 0; side < 2; ++side)
            p.joints[id(side ? J::RightShoulder : J::LeftShoulder)] =
                p.joint(J::Neck) + r * (side ? .165 : -.165) - p.up * .075;
        if (tracking->body_active && std::isfinite(tracking->confidence) && tracking->confidence > .05f) {
            for (unsigned i = 0; i < avatar_joint_count; ++i)
                if (i != id(J::Head) && tracked_joint(*tracking, J(i))) {
                    p.joints[i] = tracking->joints[i];
                    if (i >= id(J::LeftHip)) {
                        const auto leg_joint = (i - id(J::LeftHip)) % 4;
                        const auto floor_weight = leg_joint == 0 ? 0. : leg_joint == 1 ? .5 : 1.;
                        p.joints[i].y += tracking->floor_offset * floor_weight;
                    }
                    p.tracked_body = true;
                }
        }
        p.controllers = tracking->controllers;
        for (auto& c : p.controllers) {
            for (auto& curl : c.fingers)
                curl = std::isfinite(curl) ? std::clamp(curl, 0., 1.) : 0.;
            if (!finite(c.position) || !finite(c.right) || !finite(c.up) || !finite(c.forward) || length(c.up) < .5 ||
                length(c.forward) < .5 || length(cross(c.forward, c.up)) < .5)
                c.valid = false;
            else {
                c.forward = normalized(c.forward);
                c.right = normalized(cross(c.forward, c.up));
                c.up = normalized(cross(c.right, c.forward));
            }
        }
    }
    p.controller_models = tracking != nullptr;
    if (player.carrying_board()) {
        const auto side = *player.carrying_hand();
        const auto h = grip_hand(player.holding_hand());
        p.controllers[side] = {h.position, h.right, h.up, h.forward, true, true};
    }
    const auto body_right = normalized(cross(p.forward, p.up));
    const auto travel = p.on_foot ? p.forward : nose * double(rider.lead);
    const auto chest_turn = std::atan2(dot(cross(p.forward, travel), p.up), dot(p.forward, travel)) * .25;
    const auto shoulder_right = tracking ? body_right : normalized(rotate(body_right, p.up, chest_turn));
    for (unsigned side = 0; side < 2; ++side) {
        const bool r = side != 0;
        const auto sign = r ? 1. : -1.;
        const J shoulder = r ? J::RightShoulder : J::LeftShoulder, elbow = r ? J::RightElbow : J::LeftElbow,
                wrist = r ? J::RightWrist : J::LeftWrist, hip = r ? J::RightHip : J::LeftHip,
                k = r ? J::RightKnee : J::LeftKnee, ankle = r ? J::RightAnkle : J::LeftAnkle,
                toe = r ? J::RightToe : J::LeftToe;
        const auto tracked = [&](J j) { return p.tracked_body && tracked_joint(*tracking, j); };
        if (!tracked(shoulder))
            p.joints[id(shoulder)] = p.joint(J::Neck) + shoulder_right * (sign * .165) - p.up * .075;
        if (!tracked(wrist))
            p.joints[id(wrist)] = p.joint(shoulder) + shoulder_right * (sign * .19) +
                                  p.forward * (.10 + sign * gait * .16) - p.up * (.49 - .10 * crouch) + motion.hands;
        if (p.controllers[side].valid && finite(p.controllers[side].position) &&
            length(p.controllers[side].position - p.joint(shoulder)) < 2.5) {
            p.joints[id(wrist)] = p.controllers[side].position;
            if (!tracked(elbow)) {
                const auto delta = p.joint(wrist) - p.joint(shoulder);
                const auto distance = length(delta);
                const auto reach = std::clamp(distance, .3162 - .2482 + .001, .3162 + .2482 - .001);
                p.joints[id(shoulder)] = p.joint(wrist) - normalized(delta, -p.up) * reach;
            }
        } else
            p.controllers[side].valid = false;
        if (!p.controllers[side].valid && !tracked(wrist)) {
            const auto delta = p.joint(wrist) - p.joint(shoulder);
            p.joints[id(wrist)] =
                p.joint(shoulder) +
                normalized(delta, -p.up) * std::clamp(length(delta), .3162 - .2482 + .001, .3162 + .2482 - .001);
        }
        if (!tracked(elbow))
            p.joints[id(elbow)] = knee(p.joint(shoulder), p.joint(wrist), -p.forward + body_right * sign, .3162, .2482);
        if (!tracked(hip))
            p.joints[id(hip)] = p.joint(J::Hips) + body_right * (sign * .105) - p.up * .087;
        if (tracking && !tracked(ankle)) {
            const auto stride = p.on_foot && rider.grounded
                                    ? std::sin(player.walk_phase() + side * pi) *
                                          std::min(.18, length(project(rider.velocity, {0, 1, 0})) * .05)
                                    : 0.;
            const auto along = normalized(project(player.render_forward(), {0, 1, 0}), player.camera_forward());
            p.joints[id(ankle)] =
                p.on_foot ? root + project(tracking->head - root, {0, 1, 0}) + body_right * (sign * .105) +
                                p.forward * stride + Vec3{0, .12 + std::max(0., stride) * .2, 0}
                          : root + project(tracking->head - root, {0, 1, 0}) + along * (-sign * .27) + Vec3{0, .12, 0};
        }
        if (!tracked(hip)) {
            const auto delta = p.joint(hip) - p.joint(ankle);
            p.joints[id(hip)] =
                p.joint(ankle) +
                normalized(delta, p.up) * std::clamp(length(delta), .4182 - .4165 + .001, .4165 + .4182 - .001);
        }
        if (!tracked(k))
            p.joints[id(k)] = knee(p.joint(hip), p.joint(ankle), p.forward, .4165, .4182);
        if (!tracked(toe))
            p.joints[id(toe)] = p.joint(ankle) +
                                rotate(p.forward, p.up, p.on_foot || tracking ? 0 : (r ? -3. : 15.) * pi / 180) * .13 -
                                (tracking || p.on_foot ? p.up : deck_up) * .068;
    }
    p.tracked_legs = p.tracked_body && tracking->full_body && !tracking->seated;
    if (p.tracked_legs)
        for (unsigned i = id(J::LeftHip); i < avatar_joint_count; ++i)
            p.tracked_legs = p.tracked_legs && tracking->valid[i] && finite(tracking->joints[i]) &&
                             length(tracking->joints[i] - tracking->head) < 2.5;
    return p;
}

std::span<const Vertex> Avatar::mesh(const AvatarPose& p, bool first_person, bool labels, Vec3 eye,
                                     Vec3 controller_offset, const SceneLighting* scene_lighting,
                                     bool runtime_lighting) {
    // The GLBs face +Z: their +X is anatomical left. This must be a rotation,
    // not the reflected right/up/forward frame used by the old rigid figure.
    const auto left = normalized(cross(p.up, p.forward));
    const auto basis = [&](Vec3 v) { return left * v.x + p.up * v.y + p.forward * v.z; };

    struct Transform {
        Vec3 origin, from, to, target;
        std::array<Vec3, 3> source{}, destination{};
        Vec3 curl_axis{};
        bool framed = false;

        Vec3 map(Vec3 v) const {
            if (framed)
                return destination[0] * dot(v, source[0]) + destination[1] * dot(v, source[1]) +
                       destination[2] * dot(v, source[2]);
            return align(v, from, to);
        }
    };

    std::vector<Transform> transforms;
    transforms.reserve(bones_.size());
    for (const auto& b : bones_) {
        if ((b.name.starts_with("LeftHand") || b.name.starts_with("RightHand")) && b.parent < transforms.size()) {
            const auto& parent = transforms.at(b.parent);
            const auto side = b.name.starts_with("LeftHand") ? 0u : 1u;
            const auto& c = p.controllers[side];
            auto transform = parent;
            transform.origin = b.head;
            transform.target = parent.target + parent.map(basis(b.head - parent.origin));
            transform.framed = true;
            const bool thumb = b.name.find("Thumb") != std::string::npos;
            const auto curl = c.valid ? c.fingers[thumb ? 0 : b.name.find("Index") != std::string::npos ? 1 : 2] : 0.;
            if (bones_[b.parent].name == "Hand.L" || bones_[b.parent].name == "Hand.R") {
                // The palm normal is opposite on the mirrored hands. A line
                // back to the wrist lies in the palm plane and bends sideways.
                const auto palm = parent.map(basis(bones_[b.parent].axes[0])) * (side ? -1. : 1.);
                transform.curl_axis = normalized(cross(parent.map(basis(b.axes[1])), palm));
            }
            const auto angle = curl * (thumb ? .75 : b.name.ends_with("2") ? 1.15 : .85);
            for (unsigned i = 0; i < 3; ++i) {
                const Vec3 axis = i == 0 ? Vec3{1, 0, 0} : i == 1 ? Vec3{0, 1, 0} : Vec3{0, 0, 1};
                transform.source[i] = basis(axis);
                transform.destination[i] = rotate(parent.map(basis(axis)), transform.curl_axis, angle);
            }
            transforms.push_back(transform);
            continue;
        }
        const bool driven =
            b.name == "Hips" || b.name == "Spine" || b.name == "Chest" || b.name == "ChestUpper" || b.name == "Neck" ||
            b.name == "Head" || b.name.starts_with("Clavicle") || b.name.starts_with("UpperArm") ||
            b.name.starts_with("LowerArm") || b.name.starts_with("Hand") || b.name.starts_with("Pelvis") ||
            b.name.starts_with("UpperLeg") || b.name.starts_with("LowerLeg") || b.name.starts_with("Foot");
        if (!driven) {
            if (b.parent < transforms.size()) {
                auto t = transforms[b.parent];
                t.target += t.map(basis(b.head - t.origin));
                t.origin = b.head;
                transforms.push_back(t);
            } else {
                const auto from = basis(b.tail - b.head);
                transforms.push_back({b.head, from, from, p.joint(J::Hips) + basis(b.head - Vec3{0, 1.0364, 0})});
            }
            continue;
        }
        const auto t = target(b.name, p);
        const auto from = basis(b.tail - b.head), to = t.tail - t.head;
        Transform transform{b.head, from, to, t.head};
        // Keep the imported skeleton connected and retain its authored lengths.
        // Moving every joint onto the marker skeleton tears blended coat panels
        // and fitting each segment independently changes rigid box proportions.
        if (b.name != "Hips" && b.parent < transforms.size()) {
            const auto& parent = transforms[b.parent];
            transform.target = parent.target + parent.map(basis(b.head - parent.origin));
        }
        if (b.name == "Hips" || b.name == "Spine" || b.name == "Chest" || b.name == "ChestUpper" || b.name == "Neck") {
            const auto rest_up = normalized(b.tail - b.head),
                       rest_forward = normalized(project({0, 0, 1}, rest_up), {0, 0, 1});
            const auto up = normalized(to, p.up);
            auto forward = p.forward;
            if (b.name == "Chest" || b.name == "ChestUpper" || b.name == "Neck") {
                const auto shoulders = p.joint(J::RightShoulder) - p.joint(J::LeftShoulder);
                forward = normalized(cross(up, shoulders), forward);
            }
            forward = normalized(project(forward, up), p.forward);
            transform.framed = true;
            transform.source = {basis(normalized(cross(rest_up, rest_forward))), basis(rest_up), basis(rest_forward)};
            transform.destination = {normalized(cross(up, forward)), up, forward};
        }
        if (b.name.starts_with("UpperArm") || b.name.starts_with("LowerArm")) {
            const auto side = b.name.ends_with(".L") ? 0u : 1u;
            const auto& hand = p.controllers[side];
            if (hand.valid) {
                if (b.name.starts_with("UpperArm")) {
                    const auto suffix = side ? ".R" : ".L";
                    const auto bone = [&](const std::string& name) -> const Bone& {
                        return *std::find_if(bones_.begin(), bones_.end(),
                                             [&](const auto& value) { return value.name == name; });
                    };
                    const auto& lower = bone(std::string("LowerArm") + suffix);
                    const auto& wrist = bone(std::string("Hand") + suffix);
                    const auto shoulder_joint = side ? J::RightShoulder : J::LeftShoulder,
                               elbow_joint = side ? J::RightElbow : J::LeftElbow,
                               wrist_joint = side ? J::RightWrist : J::LeftWrist;
                    const auto bend = p.joint(elbow_joint) - (p.joint(shoulder_joint) + p.joint(wrist_joint)) * .5;
                    const auto mid =
                        knee(transform.target, hand.position, bend, std::max(.001, length(lower.head - b.head)),
                             std::max(.001, length(wrist.head - lower.head)));
                    transform.to = mid - transform.target;
                } else
                    transform.to = hand.position - transform.target;
            }
        }
        if (b.name == "Hand.L" || b.name == "Hand.R") {
            const auto& c = p.controllers[b.name == "Hand.L" ? 0 : 1];
            if (c.valid) {
                transform.target = c.position;
                transform.framed = true;
                for (unsigned i = 0; i < 3; ++i)
                    transform.source[i] = basis(b.axes[i]);
                transform.destination = {c.right, -c.up, c.forward};
            } else if (b.parent < transforms.size()) {
                // Untracked hands retain their imported wrist angle beneath the forearm.
                const auto anchor = transform.target;
                transform = transforms[b.parent];
                transform.origin = b.head;
                transform.target = anchor;
            }
        }
        if (b.name == "Foot.L" || b.name == "Foot.R") {
            const auto ankle = b.name == "Foot.L" ? J::LeftAnkle : J::RightAnkle,
                       toe = b.name == "Foot.L" ? J::LeftToe : J::RightToe;
            const auto rest_forward = normalized(project(b.axes[1], {0, 1, 0}), {0, 0, 1}),
                       rest_left = normalized(cross({0, 1, 0}, rest_forward));
            const auto forward = normalized(project(p.joint(toe) - p.joint(ankle), p.up), p.forward);
            transform.framed = true;
            transform.source = {basis(rest_left), basis({0, 1, 0}), basis(rest_forward)};
            transform.destination = {normalized(cross(p.up, forward)), p.up, forward};
        }
        if (b.name == "Head") {
            transform.framed = true;
            transform.source = {basis({1, 0, 0}), basis({0, 1, 0}), basis({0, 0, 1})};
            transform.destination = {normalized(cross(p.head_up, p.head_forward)), p.head_up, p.head_forward};
            if (p.controller_models)
                transform.target = t.head;
        }
        transforms.push_back(transform);
    }
    std::vector<Vec3> posed;
    posed.reserve(vertices_.size());
    const auto illumination = runtime_lighting ? SceneLight{}
                              : scene_lighting ? scene_lighting->sample(p.joint(AvatarJoint::Hips))
                                               : SceneLight::fallback();
    std::vector<Vec3> lighting;
    lighting.reserve(vertices_.size());
    std::vector<Vec3> normals;
    normals.reserve(vertices_.size());
    for (const auto& v : vertices_) {
        Vec3 point{}, normal{};
        for (unsigned influence = 0; influence < 4; ++influence) {
            if (v.weights[influence] == 0)
                continue;
            const auto& t = transforms[v.bones[influence]];
            const auto relative = basis(v.position - t.origin);
            point += (t.target + t.map(relative)) * v.weights[influence];
            normal += t.map(basis(v.normal)) * v.weights[influence];
        }
        normal = normalized(normal);
        posed.push_back(point);
        normals.push_back(normal);
        lighting.push_back(runtime_lighting ? Vec3{1, 1, 1} : illumination.evaluate(normal));
    }
    mesh_.clear();
    shadow_.clear();
    for (std::size_t i = 0; i < corners_.size(); i += 3) {
        bool hide = false;
        for (unsigned k = 0; k < 3; ++k) {
            const auto& vertex = vertices_[corners_[i + k].vertex];
            double head_weight = 0;
            for (unsigned influence = 0; influence < 4; ++influence) {
                const auto& name = bones_[vertex.bones[influence]].name;
                if (name == "Head" || name == "Neck")
                    head_weight += vertex.weights[influence];
            }
            hide |= first_person && head_weight > .25;
        }
        for (unsigned k = 0; k < 3; ++k) {
            const auto& c = corners_[i + k];
            auto colour = c.colour;
            colour[0] *= float(lighting[c.vertex].x);
            colour[1] *= float(lighting[c.vertex].y);
            colour[2] *= float(lighting[c.vertex].z);
            auto v = vertex(posed[c.vertex], colour);
            const auto n = normals[c.vertex];
            v.nx = float(n.x);
            v.ny = float(n.y);
            v.nz = float(n.z);
            if (c.textured) {
                v.s = c.uv[0];
                v.t = c.uv[1];
                v.ls = c.uv[2];
                v.lt = c.uv[3];
                v.lh = 1;
                v.lx = c.emissive[0];
                v.ly = c.emissive[1];
                v.lw = c.emissive[2];
            }
            shadow_.push_back(v);
            if (!hide)
                mesh_.push_back(v);
        }
    }
    auto presented = p.controllers;
    for (auto& c : presented)
        c.position += controller_offset;
    for (unsigned i = 0; p.controller_models && i < 2; ++i)
        controller(mesh_, presented[i], i, labels, eye, p.on_foot);
    if (labels && p.controllers[0].valid && !p.run_text[0].empty()) {
        const auto anchor = presented[0].position + Vec3{0, .30, 0} + presented[0].forward * .15;
        for (unsigned i = 0; i < p.run_text.size(); ++i)
            label(mesh_, p.run_text[i], anchor, eye, .06 - i * .025);
        label(mesh_, p.controllers[0].touch ? "Y SHOW / HIDE CONTROLS" : "LEFT SELECT RESTART", anchor, eye, -.015);
    }
    if (labels && p.controllers[1].valid && !p.score_text[0].empty()) {
        const auto anchor = presented[1].position + Vec3{0, .30, 0} + presented[1].forward * .15;
        const auto colour = p.score_result < 0   ? std::array<float, 3>{1, .25f, .2f}
                            : p.score_result > 0 ? std::array<float, 3>{.35f, 1, .3f}
                                                 : std::array<float, 3>{1, 1, 1};
        for (unsigned i = 0; i < p.score_text.size(); ++i)
            label(mesh_, p.score_text[i], anchor, eye, .04 - i * .025, i == 1 ? colour : std::array<float, 3>{1, 1, 1});
    }
    if (mesh_.size() > 120000)
        throw std::runtime_error("Avatar submission exceeds bounds");
    return mesh_;
}
} // namespace openslope
