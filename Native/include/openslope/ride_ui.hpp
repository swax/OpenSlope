#pragma once
#include "avatar.hpp"
#include "camera.hpp"
#include "desktop_library.hpp"
#include "lighting_mode.hpp"

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
    Avatars,
    SelectAvatar,
    PreviousAvatarPage,
    NextAvatarPage,
    RenderScale,
    Antialiasing,
    Lighting,
    SnowDown,
    SnowUp,
    GraphicsReset,
    Calibrate,
    Recall,
    Maps,
    Games,
    SelectGame,
    LoadMap,
    Previous,
    Next,
    Mode,
    Riders,
    RiderDown,
    RiderUp,
    Exit,
    Sources,
    ChooseIso,
    IsoMapTypes,
    SelectSource,
    ImportMap,
    CancelImport,
    RefreshLibrary
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
    std::string detail{};
};

struct UiResult {
    UiAction action = UiAction::None;
    bool consumed = false;
    std::filesystem::path map{};
    std::string value{};
};

class RideUi {
public:
    bool visible = false, controls = false, stats = false, sound_muted = false, third_person = true, immersive = false,
         library = false, map_picker = false;
    bool audio_options = false, song_picker = false, music_enabled = true, authored_music = false;
    bool graphics_options = false, rider_options = false, loading = false;
    bool avatar_options = false;
    std::string avatar_selection;
    std::vector<AvatarOption> avatar_choices;
    std::size_t avatar_page = 0;
    unsigned render_scale = 150, antialiasing = 4;
    LightingMode lighting = LightingMode::Original;
    double snow_amount = 3, load_progress = 0;
    std::string graphics_readout, load_name, load_stage;
    double master_volume = 1;
    std::string song_selection, current_song;
    std::vector<std::string> song_choices;
    std::size_t song_page = 0;
    std::vector<std::filesystem::path> map_paths;
    bool iso_library = false, importing = false;
    std::vector<std::filesystem::path> iso_paths;
    std::filesystem::path iso_source;
    std::vector<std::pair<std::string, bool>> iso_courses;
    std::map<std::string, std::string> iso_course_names;
    std::map<std::string, std::string> iso_course_types;
    bool all_iso_map_types = false;
    mutable std::map<std::filesystem::path, std::string> map_titles;
    mutable std::map<std::filesystem::path, std::string> map_games;
    std::string library_game;
    std::filesystem::path import_root;
    std::map<std::string, CourseImportStatus> import_rows;
    std::size_t library_scroll = 0;
    std::string library_error;
    std::size_t page = 0;
    std::string notice;
    std::vector<UiButton> buttons() const;
    UiResult pointer(const EquipmentRay& ray, bool down);
    bool riders(UiAction action, Player& player);
    bool scroll_library(double steps);
    void set_iso_courses(const std::vector<DiscCourse>& courses);
    std::vector<std::size_t> visible_iso_courses() const;
    bool has_advanced_iso_courses() const;
    void toggle_iso_map_types();
    std::size_t library_count() const;
    void set_maps(std::vector<std::filesystem::path> paths);
    std::vector<std::string> installed_games() const;
    std::vector<std::size_t> visible_maps() const;
    void select_game(std::string game);

    void frame(UiFrame value) { frame_ = value; }

    const UiFrame& frame() const { return frame_; }

    void release() {
        pressed_ = captured_ = false;
        scroll_drag_ = false;
        hover_ = -1;
    }

    void append_pointer(std::vector<Vertex>& vertices, const EquipmentRay& ray) const;
    void append(std::vector<Vertex>& vertices, const Player& player, bool wrist = false, double fps = 0) const;
    static UiFrame desktop(const CameraPose& camera, double aspect, bool menu = false);
    static UiFrame wrist(const ControllerPose& left, Vec3 eye, Vec3 offset = {});

private:
    std::string map_label(const std::filesystem::path& path) const;
    std::string installed_game(const std::filesystem::path& path) const;
    std::string loading_label() const;
    UiFrame frame_;
    bool pressed_ = false, captured_ = false;
    int hover_ = -1;
    bool scroll_drag_ = false;
    double scroll_remainder_ = 0, scroll_grab_ = 0;
};

void equipment_outline(std::vector<Vertex>& vertices, const Player& player);
EquipmentInput desktop_equipment(const Player& player, const EquipmentRay& ray, bool grip);
} // namespace openslope
