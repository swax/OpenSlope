#include "openslope/vr_controls.hpp"
#include <stdexcept>

namespace openslope {
float display_refresh_rate(std::span<const float> supported, double target) {
    if (!std::isfinite(target) || target <= 0)
        return 0;
    float below = 0, lowest = 0;
    for (const auto rate : supported) {
        if (!std::isfinite(rate) || rate <= 0)
            continue;
        if (!lowest || rate < lowest)
            lowest = rate;
        if (rate <= target + .01 && rate > below)
            below = rate;
    }
    return below ? below : lowest;
}

double VrFrameClock::step(double display_seconds, bool interactive) {
    if (!std::isfinite(display_seconds)) {
        reset();
        return 0;
    }
    const auto dt = interactive && active_ ? std::max(0., display_seconds - previous_) : 0.;
    previous_ = display_seconds;
    active_ = interactive;
    return dt;
}

bool VrHeightCalibration::update(double head_y, bool floor_space) {
    if (!pending_ || !std::isfinite(head_y))
        return false;
    origin_y_ = head_y - standing_height;
    // Without a physical floor there is no reliable posture measurement.
    // Latch the mode here so a standing player's later crouch keeps leg tracking.
    seated_ = !floor_space || head_y < 1.4;
    floor_pending_ = !seated_;
    floor_offset_ = 0;
    pending_ = false;
    return true;
}

bool VrHeightCalibration::update_floor(double floor_y) {
    if (pending_ || !floor_pending_ || !std::isfinite(floor_y))
        return false;
    floor_offset_ = origin_y_ - floor_y;
    seated_ = origin_y_ + standing_height - floor_y < 1.4;
    floor_pending_ = false;
    return true;
}

std::span<const VrBinding> touch_bindings() {
    static constexpr std::array<VrBinding, 31> bindings{
        {{VrBindingAction::Steer, "/user/hand/left/input/thumbstick"},
         {VrBindingAction::Look, "/user/hand/right/input/thumbstick"},
         {VrBindingAction::Boost, "/user/hand/right/input/b/click"},
         {VrBindingAction::Jump, "/user/hand/right/input/a/click"},
         {VrBindingAction::Board, "/user/hand/left/input/trigger/value"},
         {VrBindingAction::Board, "/user/hand/right/input/trigger/value"},
         {VrBindingAction::Reset, "/user/hand/left/input/x/click"},
         {VrBindingAction::Menu, "/user/hand/left/input/y/click"},
         {VrBindingAction::Menu, "/user/hand/left/input/menu/click"},
         {VrBindingAction::Camera, "/user/hand/right/input/thumbstick/click"},
         {VrBindingAction::RailExit, "/user/hand/left/input/thumbstick/click"},
         {VrBindingAction::Grip, "/user/hand/left/input/grip/pose"},
         {VrBindingAction::Grip, "/user/hand/right/input/grip/pose"},
         {VrBindingAction::Aim, "/user/hand/left/input/aim/pose"},
         {VrBindingAction::Aim, "/user/hand/right/input/aim/pose"},
         {VrBindingAction::Squeeze, "/user/hand/left/input/squeeze/value"},
         {VrBindingAction::Squeeze, "/user/hand/right/input/squeeze/value"},
         {VrBindingAction::TriggerValue, "/user/hand/left/input/trigger/value"},
         {VrBindingAction::TriggerValue, "/user/hand/right/input/trigger/value"},
         {VrBindingAction::SqueezeValue, "/user/hand/left/input/squeeze/value"},
         {VrBindingAction::SqueezeValue, "/user/hand/right/input/squeeze/value"},
         {VrBindingAction::IndexTouch, "/user/hand/left/input/trigger/touch"},
         {VrBindingAction::IndexTouch, "/user/hand/right/input/trigger/touch"},
         {VrBindingAction::ThumbTouch, "/user/hand/left/input/x/touch"},
         {VrBindingAction::ThumbTouch, "/user/hand/left/input/y/touch"},
         {VrBindingAction::ThumbTouch, "/user/hand/right/input/a/touch"},
         {VrBindingAction::ThumbTouch, "/user/hand/right/input/b/touch"},
         {VrBindingAction::ThumbTouch, "/user/hand/left/input/thumbstick/touch"},
         {VrBindingAction::ThumbTouch, "/user/hand/right/input/thumbstick/touch"},
         {VrBindingAction::ThumbTouch, "/user/hand/left/input/thumbrest/touch"},
         {VrBindingAction::ThumbTouch, "/user/hand/right/input/thumbrest/touch"}}};
    return bindings;
}

std::array<double, 3> controller_finger_curls(const VrHandInput& input) {
    const auto value = [](double v) { return std::isfinite(v) ? std::clamp(v, 0., 1.) : 0.; };
    return {input.thumb_touch ? .8 : 0., std::max(input.index_touch ? .2 : 0., value(input.trigger)),
            value(input.squeeze)};
}

VrIntent vr_intent(const VrButtons& b, bool walking) {
    for (const auto x : {b.x, b.y, b.look})
        if (!std::isfinite(x) || std::abs(x) > 1)
            throw std::invalid_argument("Invalid controller axis");
    VrIntent result;
    result.steer = walking ? -b.x : 0;
    result.posture = walking ? b.y : std::abs(b.y) > .1 && std::abs(b.y) >= std::abs(b.x) ? b.y : 0;
    result.boost = b.boost;
    result.jump = b.jump;
    result.board = b.board;
    result.reset = b.reset && !walking;
    result.recall = b.reset && walking;
    return result;
}

void VrPresentation::step(double seconds, const VrButtons& b, bool walking) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid controller presentation step");
    static_cast<void>(vr_intent(b, false));
    if (b.menu && !menu_held_)
        controls = !controls;
    if (b.camera && !camera_held_)
        third_person = !third_person;
    menu_held_ = b.menu;
    camera_held_ = b.camera;
    // Riding turns the whole tracking frame with the left stick; gaze still owns the board.
    yaw -= vr_axis(walking ? b.look : b.x, false) * 120 * pi / 180 * seconds;
}

Vec3 VrPresentation::camera_offset(Vec3 facing) const {
    return third_person ? -normalized(project(facing, {0, 1, 0}), {0, 0, -1}) * 2 + Vec3{0, 1, 0} : Vec3{};
}

double vr_axis(double raw, bool precision) {
    const auto magnitude = std::clamp((std::abs(raw) - .18) / .82, 0., 1.);
    return std::copysign(precision ? magnitude * magnitude : magnitude, raw);
}

double gaze_yaw(Vec3 gaze, Vec3 reference, Vec3 normal) {
    normal = normalized(normal, {0, 1, 0});
    gaze = project(gaze, normal);
    reference = project(reference, normal);
    if (!finite(gaze) || !finite(reference) || length(gaze) < 1e-6 || length(reference) < 1e-6)
        return 0;
    gaze = normalized(gaze);
    reference = normalized(reference);
    return std::atan2(dot(cross(reference, gaze), normal), std::clamp(dot(reference, gaze), -1., 1.));
}

double gaze_carve(Vec3 gaze, Vec3 travel, Vec3 normal, Vec3 fallback) {
    const auto reference = length(project(travel, normal)) > .5 ? travel : fallback;
    const auto angle = gaze_yaw(gaze, reference, normal) * 180 / pi;
    return std::copysign(std::clamp((std::abs(angle) - 5) / 30, 0., 1.), angle);
}

double gaze_turn(Vec3 gaze, Vec3 reference, double maximum, double seconds) {
    const auto yaw = gaze_yaw(gaze, reference, {0, 1, 0});
    const auto error = std::max(0., std::abs(yaw) - 5 * pi / 180);
    const auto response = seconds <= 0 ? 0. : error <= .05 * pi / 180 ? error : error * -std::expm1(-18 * seconds);
    return std::copysign(std::min(std::max(0., maximum), response), yaw);
}
} // namespace openslope
