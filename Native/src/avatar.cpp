#include "openslope/avatar.hpp"
#include "figure.hpp"
#include "openslope/gear.hpp"
#include "openslope/ui_font.hpp"
#include <cstring>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
namespace {
using J = AvatarJoint;

constexpr unsigned id(J j) { return unsigned(j); }

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
                label(out, "STICK TURN", anchor, eye, .025);
                label(out, "CLICK 1ST / 3RD", anchor, eye, 0);
            } else {
                label(out, on_foot ? "STICK WALK" : "STICK STEER / POSTURE", anchor, eye, .100);
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
    if (name == "Chest")
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
        p.run_text[0] = std::string(run_name(run.mode)) + " " + run_clock(run.clock);
        p.run_text[1] = run.phase == RunPhase::Ready       ? "MOUNT TO START"
                        : run.phase == RunPhase::Countdown ? "START IN " + std::to_string(int(std::ceil(run.countdown)))
                                                           : std::string(run_name(run.phase));
        p.run_text[2] = run.checkpoint_notice > 0
                            ? (run.mode == RunMode::Race ? std::string("CHECKPOINT")
                                                         : "CHECKPOINT +" + std::to_string(int(run.checkpoint_bonus)))
                            : "CP " + std::to_string(run.checkpoints) + " LAP " + std::to_string(run.lap) + "/" +
                                  std::to_string(run.passes);
    }
    if (player.reset_pending() && !p.run_text[0].empty())
        p.run_text[1] = "RETURNING TO COURSE";
    if (run.mode != RunMode::Freeride) {
        const auto& score = player.scoring().status();
        p.score_text[0] = "SCORE " + std::to_string(score.banked);
        p.score_text[1] = score.preview ? "TRICK +" + std::to_string(score.preview)
                          : score.resolution && score.result_age < 3
                              ? (score.bailed ? "LOST " : "BANKED ") + std::to_string(score.result)
                              : "LAND TO BANK";
        p.score_text[2] = "BOOST " + std::to_string(player.scoring().meter_segments()) + "/15";
        if (score.multiplier > 1)
            p.score_text[2] += " X" + std::to_string(score.multiplier);
        p.score_result = score.preview ? 0 : score.resolution && score.result_age < 3 ? (score.bailed ? -1 : 1) : 0;
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
                if (i != id(J::Head) && tracking->valid[i] && finite(tracking->joints[i]) &&
                    length(tracking->joints[i] - h) < 2.5) {
                    p.joints[i] = tracking->joints[i];
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
        const auto tracked = [&](J j) {
            return p.tracked_body && tracking->valid[id(j)] && finite(tracking->joints[id(j)]) &&
                   length(tracking->joints[id(j)] - tracking->head) < 2.5;
        };
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
    p.tracked_legs = p.tracked_body && tracking->full_body;
    if (p.tracked_legs)
        for (unsigned i = id(J::LeftHip); i < avatar_joint_count; ++i)
            p.tracked_legs = p.tracked_legs && tracking->valid[i] && finite(tracking->joints[i]) &&
                             length(tracking->joints[i] - tracking->head) < 2.5;
    return p;
}

Avatar::Avatar() {
    const auto bytes = std::span(bundled::stick_figure);
    const auto word = [&](std::size_t offset) {
        if (offset + 4 > bytes.size())
            throw std::runtime_error("Truncated figure");
        std::uint32_t v;
        std::memcpy(&v, bytes.data() + offset, 4);
        return v;
    };
    if (word(0) != 0x46546c67 || word(4) != 2 || word(8) != bytes.size() || word(16) != 0x4e4f534a)
        throw std::runtime_error("Invalid bundled figure");
    const auto json_size = word(12);
    const auto binary_header = std::size_t(20) + json_size;
    if (word(binary_header + 4) != 0x004e4942 || binary_header + 8 + word(binary_header) != bytes.size())
        throw std::runtime_error("Invalid figure binary");
    const auto binary = bytes.subspan(binary_header + 8);
    const auto data = nlohmann::json::parse(bytes.begin() + 20, bytes.begin() + binary_header);
    const auto& nodes = data.at("nodes");
    const auto& skin = data.at("skins").at(0);
    const auto& joints = skin.at("joints");
    if (joints.size() > 128 || nodes.size() > 256)
        throw std::runtime_error("Figure rig exceeds bounds");
    using M = std::array<double, 16>;
    std::vector<M> global(nodes.size());
    std::vector<unsigned> parents(nodes.size(), 0);
    for (unsigned i = 0; i < nodes.size(); ++i)
        for (const auto& child : nodes[i].value("children", nlohmann::json::array()))
            parents.at(child.get<unsigned>()) = i;
    for (unsigned i = 0; i < nodes.size(); ++i) {
        const auto local = nodes[i].value("matrix", M{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1});
        if (i && parents[i] >= i)
            throw std::runtime_error("Figure rig is not ordered");
        auto& m = global[i];
        if (!i)
            m = local;
        else
            for (unsigned c = 0; c < 4; ++c)
                for (unsigned r = 0; r < 4; ++r)
                    for (unsigned k = 0; k < 4; ++k)
                        m[c * 4 + r] += global[parents[i]][k * 4 + r] * local[c * 4 + k];
    }
    const auto position = [&](unsigned node) {
        const auto& m = global.at(node);
        return Vec3{m[12], m[13], m[14]};
    };
    for (unsigned i = 0; i < joints.size(); ++i) {
        const auto node = joints[i].get<unsigned>();
        const auto& m = global.at(node);
        auto head = position(node), tail = head + Vec3{m[4], m[5], m[6]} * .1;
        const auto children = nodes[node].value("children", nlohmann::json::array());
        if (!children.empty() && !nodes[node].at("name").get<std::string>().starts_with("Hand"))
            tail = position(children.at(0).get<unsigned>());
        const auto parent_node = parents[node];
        unsigned parent = i;
        for (unsigned k = 0; k < joints.size(); ++k)
            if (joints[k].get<unsigned>() == parent_node)
                parent = k;
        const auto name = nodes[node].at("name").get<std::string>();
        const std::array<Vec3, 3> axes{{normalized(Vec3{m[0], m[1], m[2]}), normalized(Vec3{m[4], m[5], m[6]}),
                                        normalized(Vec3{m[8], m[9], m[10]})}};
        if (name == "Hand.L" || name == "Hand.R")
            tail = head + axes[1] * .1;
        bones_.push_back({name, head, tail, parent, axes});
    }
    const auto read = [&](unsigned accessor, unsigned component, unsigned type, unsigned lanes) {
        const auto& a = data.at("accessors").at(accessor);
        if (a.at("componentType") != type || a.value("normalized", false) || a.contains("sparse"))
            throw std::runtime_error("Unsupported figure accessor");
        const auto count = a.at("count").get<std::size_t>();
        if (count > 30000)
            throw std::runtime_error("Figure accessor exceeds bounds");
        const auto& b = data.at("bufferViews").at(a.at("bufferView").get<unsigned>());
        const auto stride = b.value("byteStride", std::size_t(component * lanes)),
                   offset = b.value("byteOffset", std::size_t(0)) + a.value("byteOffset", std::size_t(0));
        if (b.value("buffer", 0) != 0 || stride < component * lanes ||
            (count && offset + (count - 1) * stride + component * lanes > binary.size()))
            throw std::runtime_error("Figure accessor outside binary");
        std::vector<double> values;
        values.reserve(count * lanes);
        for (std::size_t i = 0; i < count; ++i)
            for (unsigned lane = 0; lane < lanes; ++lane) {
                const auto* p = binary.data() + offset + i * stride + lane * component;
                double v = 0;
                if (type == 5126) {
                    float f;
                    std::memcpy(&f, p, 4);
                    v = f;
                } else if (type == 5125) {
                    std::uint32_t u;
                    std::memcpy(&u, p, 4);
                    v = u;
                } else {
                    std::uint16_t u;
                    std::memcpy(&u, p, 2);
                    v = u;
                }
                if (!std::isfinite(v))
                    throw std::runtime_error("Non-finite figure value");
                values.push_back(v);
            }
        return values;
    };
    const auto& primitives = data.at("meshes").at(0).at("primitives");
    const auto& attributes = primitives.at(0).at("attributes");
    const auto normals = read(attributes.at("NORMAL").get<unsigned>(), 4, 5126, 3);
    const auto points = read(attributes.at("POSITION").get<unsigned>(), 4, 5126, 3),
               bones = read(attributes.at("JOINTS_0").get<unsigned>(), 2, 5123, 4),
               weights = read(attributes.at("WEIGHTS_0").get<unsigned>(), 4, 5126, 4);
    if (points.size() != normals.size() || points.size() / 3 != bones.size() / 4 || bones.size() != weights.size())
        throw std::runtime_error("Figure attribute counts differ");
    for (std::size_t i = 0; i < points.size() / 3; ++i) {
        const auto bone = unsigned(bones[i * 4]);
        if (bone >= bones_.size() || weights[i * 4] != 1 || weights[i * 4 + 1] != 0 || weights[i * 4 + 2] != 0 ||
            weights[i * 4 + 3] != 0)
            throw std::runtime_error("Figure requires rigid skin weights");
        vertices_.push_back({{points[i * 3], points[i * 3 + 1], points[i * 3 + 2]},
                             {normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]},
                             bone});
    }
    for (const auto& primitive : primitives) {
        if (primitive.value("mode", 4) != 4 || primitive.at("attributes") != attributes)
            throw std::runtime_error("Unsupported figure primitive");
        const auto& material = data.at("materials").at(primitive.at("material").get<unsigned>());
        const auto colour =
            material.at("pbrMetallicRoughness").value("baseColorFactor", std::array<double, 4>{1, 1, 1, 1});
        std::array<float, 3> display{};
        for (unsigned c = 0; c < 3; ++c)
            display[c] = float(colour[c] <= .0031308 ? colour[c] * 12.92 : 1.055 * std::pow(colour[c], 1 / 2.4) - .055);
        const auto indices = read(primitive.at("indices").get<unsigned>(), 4, 5125, 1);
        if (indices.size() % 3)
            throw std::runtime_error("Incomplete figure triangle");
        for (const auto index : indices) {
            if (index >= vertices_.size())
                throw std::runtime_error("Figure index out of bounds");
            corners_.push_back({unsigned(index), display});
        }
    }
    mesh_.reserve(corners_.size() + 20000);
}

std::span<const Vertex> Avatar::mesh(const AvatarPose& p, bool first_person, bool labels, Vec3 eye,
                                     Vec3 controller_offset) {
    const auto right = normalized(cross(p.forward, p.up));
    const auto basis = [&](Vec3 v) { return right * v.x + p.up * v.y + p.forward * v.z; };

    struct Transform {
        Vec3 origin, from, to, target;
        double scale;
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
        if (b.name.starts_with("LeftHand") || b.name.starts_with("RightHand")) {
            const auto& parent = transforms.at(b.parent);
            const auto side = b.name.starts_with("LeftHand") ? 0u : 1u;
            const auto& c = p.controllers[side];
            auto transform = parent;
            transform.origin = b.head;
            transform.target = parent.target + parent.map(basis(b.head - parent.origin));
            transform.framed = true;
            const bool thumb = b.name.find("Thumb") != std::string::npos;
            const auto curl = c.valid ? c.fingers[thumb ? 0 : b.name.find("Index") != std::string::npos ? 1 : 2] : 0.;
            if (bones_[b.parent].name == "Hand.L" || bones_[b.parent].name == "Hand.R")
                transform.curl_axis =
                    normalized(cross(parent.map(basis(b.axes[1])), c.position - transform.target), c.right);
            const auto angle = curl * (thumb ? .75 : b.name.ends_with("2") ? 1.15 : .85);
            for (unsigned i = 0; i < 3; ++i) {
                const Vec3 axis = i == 0 ? Vec3{1, 0, 0} : i == 1 ? Vec3{0, 1, 0} : Vec3{0, 0, 1};
                transform.source[i] = basis(axis);
                transform.destination[i] = rotate(parent.map(basis(axis)), transform.curl_axis, angle);
            }
            transforms.push_back(transform);
            continue;
        }
        const auto t = target(b.name, p);
        const auto from = basis(b.tail - b.head), to = t.tail - t.head;
        Transform transform{b.head, from, to, t.head, std::clamp(length(to) / std::max(.001, length(from)), .5, 1.5)};
        if (b.name == "Hand.L" || b.name == "Hand.R") {
            const auto& c = p.controllers[b.name == "Hand.L" ? 0 : 1];
            if (c.valid) {
                transform.framed = true;
                for (unsigned i = 0; i < 3; ++i)
                    transform.source[i] = basis(b.axes[i]);
                transform.destination = {c.right, -c.up, c.forward};
            }
        }
        if (b.name == "Head") {
            transform.framed = true;
            transform.source = {basis({1, 0, 0}), basis({0, 1, 0}), basis({0, 0, 1})};
            transform.destination = {normalized(cross(p.head_forward, p.head_up)), p.head_up, p.head_forward};
        }
        transforms.push_back(transform);
    }
    std::vector<Vec3> posed;
    posed.reserve(vertices_.size());
    std::vector<double> lighting;
    lighting.reserve(vertices_.size());
    for (const auto& v : vertices_) {
        const auto& t = transforms[v.bone];
        auto relative = basis(v.position - t.origin);
        const auto axis = normalized(t.from);
        if (!t.framed)
            relative += axis * (dot(relative, axis) * (t.scale - 1));
        posed.push_back(t.target + t.map(relative));
        const auto normal = normalized(t.map(basis(v.normal)));
        lighting.push_back(.60 + .40 * std::max(0., dot(normal, normalized(Vec3{-.3, .8, -.5}))));
    }
    mesh_.clear();
    for (std::size_t i = 0; i < corners_.size(); i += 3) {
        bool hide = false;
        for (unsigned k = 0; k < 3; ++k) {
            const auto& name = bones_[vertices_[corners_[i + k].vertex].bone].name;
            hide |= first_person && (name == "Head" || name == "Neck");
        }
        if (!hide)
            for (unsigned k = 0; k < 3; ++k) {
                const auto& c = corners_[i + k];
                auto colour = c.colour;
                for (auto& value : colour)
                    value *= float(lighting[c.vertex]);
                mesh_.push_back(vertex(posed[c.vertex], colour));
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
    if (mesh_.size() > 60000)
        throw std::runtime_error("Avatar submission exceeds bounds");
    return mesh_;
}
} // namespace openslope
