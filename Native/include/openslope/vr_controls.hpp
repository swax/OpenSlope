#pragma once
#include "math.hpp"
#include <span>
#include <string_view>

namespace openslope {
// Choose an enumerated runtime rate; zero means keep the runtime preference.
float display_refresh_rate(std::span<const float> supported, double target);

struct VrInput {
    bool enabled = false, head = false, stick = false;
    Vec3 gaze{};
    double spin = 0;
};
enum class VrBindingAction {
    Steer,
    Look,
    Boost,
    Jump,
    Board,
    Reset,
    Menu,
    Camera,
    RailExit,
    Grip,
    Squeeze,
    Aim,
    TriggerValue,
    SqueezeValue,
    IndexTouch,
    ThumbTouch
};

struct VrHandInput {
    double trigger = 0, squeeze = 0;
    bool index_touch = false, thumb_touch = false;
};

// Thumb, index and the remaining three fingers have independent sensor groups.
std::array<double, 3> controller_finger_curls(const VrHandInput& input);

struct VrBinding {
    VrBindingAction action;
    std::string_view path;
};

std::span<const VrBinding> touch_bindings();

struct VrButtons {
    double x = 0, y = 0, look = 0;
    bool boost = false, jump = false, board = false, reset = false, menu = false, camera = false;
};

struct VrIntent {
    double steer = 0, posture = 0;
    bool boost = false, jump = false, board = false, reset = false, recall = false;
};

VrIntent vr_intent(const VrButtons& buttons, bool walking);

class VrInputGate {
public:
    bool accept(bool activation_down) {
        if (!activation_down)
            armed_ = true;
        return armed_;
    }

    void release() { armed_ = false; }

private:
    bool armed_ = false;
};

// A resumed frame never catches simulation up across a system pause or focus gap.
class VrFrameClock {
public:
    double step(double display_seconds, bool interactive);

    void reset() {
        active_ = false;
        previous_ = 0;
    }

private:
    bool active_ = false;
    double previous_ = 0;
};

// Height is calibrated independently of room position/yaw and player placement.
class VrHeightCalibration {
public:
    static constexpr double standing_height = 1.65;

    void request() { pending_ = true; }

    bool update(double head_y, bool floor_space);
    bool update_floor(double floor_y);

    double origin_y() const { return origin_y_; }

    double floor_offset() const { return floor_offset_; }

    bool floor_calibrated() const { return !floor_pending_; }

    bool seated() const { return seated_; }

private:
    bool pending_ = true, seated_ = true, floor_pending_ = true;
    double origin_y_ = 0, floor_offset_ = 0;
};

class VrPresentation {
public:
    bool controls = true, third_person = false;
    double yaw = 0;
    void step(double seconds, const VrButtons& buttons, bool walking);

    void release() { menu_held_ = camera_held_ = false; }

    Vec3 camera_offset(Vec3 facing) const;

private:
    bool menu_held_ = false, camera_held_ = false;
};

double vr_axis(double raw, bool precision);
double gaze_yaw(Vec3 gaze, Vec3 reference, Vec3 normal);
double gaze_carve(Vec3 gaze, Vec3 travel, Vec3 normal, Vec3 fallback);
double gaze_turn(Vec3 gaze, Vec3 reference, double maximum_radians, double seconds = 1. / 60);
} // namespace openslope
