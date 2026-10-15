#pragma once
#include "avatar.hpp"
#include "camera.hpp"

namespace openslope {
enum class UiAction {
    None,
    Resume,
    Restart,
    View,
    Controls,
    Sound,
    Stats,
    Calibrate,
    Recall,
    HeadSteer,
    Maps,
    LoadMap,
    Previous,
    Next,
    Mode,
    Exit
};

struct UiFrame {
    Vec3 origin{}, right{1, 0, 0}, down{0, -1, 0};
    bool valid = false;
};

struct UiButton {
    double x, y, w, h;
    std::string text;
    UiAction action;
    std::filesystem::path map{};
};

struct UiResult {
    UiAction action = UiAction::None;
    bool consumed = false;
    std::filesystem::path map{};
};

class RideUi {
public:
    bool visible = false, controls = false, stats = false, sound_muted = false, third_person = true, head_steer = false,
         immersive = false, library = false;
    std::vector<std::filesystem::path> map_paths;
    std::size_t page = 0;
    std::string notice;
    std::vector<UiButton> buttons() const;
    UiResult pointer(const EquipmentRay& ray, bool down);

    void frame(UiFrame value) { frame_ = value; }

    const UiFrame& frame() const { return frame_; }

    void release() {
        pressed_ = captured_ = false;
        hover_ = -1;
    }

    void append_pointer(std::vector<Vertex>& vertices, const EquipmentRay& ray) const;
    void append(std::vector<Vertex>& vertices, const Player& player, bool wrist = false, double fps = 0) const;
    static UiFrame desktop(const CameraPose& camera, double aspect, bool menu = false);
    static UiFrame wrist(const ControllerPose& left, Vec3 eye, Vec3 offset = {});

private:
    UiFrame frame_;
    bool pressed_ = false, captured_ = false;
    int hover_ = -1;
};

void equipment_outline(std::vector<Vertex>& vertices, const Player& player);
EquipmentInput desktop_equipment(const Player& player, const EquipmentRay& ray, bool grip, bool trigger);
} // namespace openslope
