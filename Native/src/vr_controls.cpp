#include "openslope/vr_controls.hpp"
#include <stdexcept>

namespace openslope {
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

std::span<const VrBinding> touch_bindings() {
    static constexpr std::array<VrBinding, 17> bindings{
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
         {VrBindingAction::Squeeze, "/user/hand/right/input/squeeze/value"}}};
    return bindings;
}

VrIntent vr_intent(const VrButtons& b, bool walking) {
    for (const auto x : {b.x, b.y, b.look})
        if (!std::isfinite(x) || std::abs(x) > 1)
            throw std::invalid_argument("Invalid controller axis");
    VrIntent result;
    result.steer = walking ? -b.x : -vr_axis(b.x, true);
    result.spin = -vr_axis(b.x, false);
    result.posture = walking ? b.y : std::abs(b.y) > .1 && std::abs(b.y) >= std::abs(b.x) ? b.y : 0;
    result.stick = std::abs(b.x) > .18;
    result.boost = b.boost;
    result.jump = b.jump;
    result.board = b.board;
    result.reset = b.reset && !walking;
    result.recall = b.reset && walking;
    return result;
}

void VrPresentation::step(double seconds, const VrButtons& b) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid controller presentation step");
    static_cast<void>(vr_intent(b, false));
    if (b.menu && !menu_held_)
        controls = !controls;
    if (b.camera && !camera_held_)
        third_person = !third_person;
    menu_held_ = b.menu;
    camera_held_ = b.camera;
    yaw -= vr_axis(b.look, false) * 120 * pi / 180 * seconds;
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

double gaze_turn(Vec3 gaze, Vec3 reference, double maximum) {
    const auto yaw = gaze_yaw(gaze, reference, {0, 1, 0});
    return std::abs(yaw) <= 5 * pi / 180 ? 0 : std::clamp(yaw, -maximum, maximum);
}
} // namespace openslope
