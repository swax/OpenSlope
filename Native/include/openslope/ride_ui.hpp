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
    Music,
    MasterMute,
    VolumeDown,
    VolumeUp,
    Songs,
    SelectSong,
    PreviousSongPage,
    NextSongPage,
    Stats,
    Graphics,
    RenderScale,
    Antialiasing,
    SnowDown,
    SnowUp,
    GraphicsReset,
    Calibrate,
    Recall,
    HeadSteer,
    Maps,
    LoadMap,
    Previous,
    Next,
    Mode,
    Riders,
    RiderDown,
    RiderUp,
    Exit
};

struct UiFrame {
    Vec3 origin{}, right{1, 0, 0}, down{0, -1, 0};
    bool valid = false;
    bool screen = false;
    double screen_width = 2, screen_height = 2;
};

struct UiButton {
    double x, y, w, h;
    std::string text;
    UiAction action;
    std::filesystem::path map{};
    std::string value{};
};

struct UiResult {
    UiAction action = UiAction::None;
    bool consumed = false;
    std::filesystem::path map{};
    std::string value{};
};

class RideUi {
public:
    bool visible = false, controls = false, stats = false, sound_muted = false, third_person = true, head_steer = false,
         immersive = false, library = false, map_picker = false;
    bool audio_options = false, song_picker = false, music_enabled = true, authored_music = false;
    bool graphics_options = false, rider_options = false, loading = false;
    unsigned render_scale = 150, antialiasing = 4;
    double snow_amount = 3, load_progress = 0;
    std::string graphics_readout, load_name, load_stage;
    double master_volume = 1;
    std::string song_selection, current_song;
    std::vector<std::string> song_choices;
    std::size_t song_page = 0;
    std::vector<std::filesystem::path> map_paths;
    std::size_t page = 0;
    std::string notice;
    std::vector<UiButton> buttons() const;
    UiResult pointer(const EquipmentRay& ray, bool down);
    bool riders(UiAction action, Player& player);

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
