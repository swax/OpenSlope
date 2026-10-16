#include "openslope/ride_ui.hpp"
#include "openslope/ai_field.hpp"
#include "openslope/ui_font.hpp"
#include "openslope/version.hpp"
#include <cctype>

namespace openslope {
namespace {
using Colour = std::array<float, 3>;
constexpr Colour ink{.88f, .94f, 1}, muted{.47f, .60f, .70f}, accent{.22f, .94f, .75f}, panel{.025f, .045f, .07f};
constexpr double library_top = .30, library_height = .435;

void quad(std::vector<Vertex>& out, Vec3 a, Vec3 b, Vec3 c, Vec3 d, Colour col) {
    for (const auto p : {a, b, c, a, c, d})
        out.push_back({float(p.x), float(p.y), float(p.z), col[0], col[1], col[2]});
}

struct Canvas {
    std::vector<Vertex>& out;
    UiFrame f;

    Vec3 point(double x, double y, double z = 0) const {
        if (f.screen)
            return {(x - .5) * f.screen_width, (y - .5) * f.screen_height, 0};
        return f.origin + f.right * x + f.down * y - normalized(cross(f.right, f.down)) * z;
    }

    void rect(double x, double y, double w, double h, Colour c, double layer = 0) const {
        quad(out, point(x, y, layer), point(x + w, y, layer), point(x + w, y + h, layer), point(x, y + h, layer), c);
    }

    void text(std::string value, double x, double y, double size, Colour c = ink) const {
        if (value.size() > 42)
            value = value.substr(0, 39) + "...";
        for (std::size_t n = 0; n < value.size(); ++n) {
            const auto bits = ui_glyph(char(std::toupper(static_cast<unsigned char>(value[n]))));
            for (unsigned v = 0; v < 7; ++v)
                for (unsigned u = 0; u < 5; ++u)
                    if (bits[v] & (1u << (4 - u)))
                        rect(x + (double(n) * 6 + u) * size, y + v * size * length(f.right) / length(f.down),
                             size * .86, size * .86 * length(f.right) / length(f.down), c, .0008);
        }
    }
};
} // namespace

std::vector<UiButton> RideUi::buttons() const {
    if (loading)
        return importing ? std::vector<UiButton>{{.06, .85, .88, .085, "CANCEL", UiAction::CancelImport}}
                         : std::vector<UiButton>{};
    if (graphics_options) {
        const auto y = immersive ? .36 : .55;
        std::vector<UiButton> list;
        if (!immersive) {
            list.push_back(
                {.06, .31, .88, .085, "RENDER SCALE: " + std::to_string(render_scale) + "%", UiAction::RenderScale});
            list.push_back(
                {.06, .43, .88, .085,
                 antialiasing == 1 ? "ANTI-ALIASING: OFF" : "ANTI-ALIASING: " + std::to_string(antialiasing) + "X MSAA",
                 UiAction::Antialiasing});
        }
        list.push_back({.06, y, .18, .085, "-", UiAction::SnowDown});
        list.push_back(
            {.27, y, .46, .085, "SNOW: " + std::to_string(int(std::round(snow_amount))) + " / 10", UiAction::None});
        list.push_back({.76, y, .18, .085, "+", UiAction::SnowUp});
        list.push_back({.06, y + .12, .42, .085, stats ? "STATS: ON" : "STATS: OFF", UiAction::Stats});
        list.push_back({.52, y + .12, .42, .085, "DEFAULTS", UiAction::GraphicsReset});
        list.push_back({.06, .85, .88, .085, "BACK TO MENU", UiAction::Graphics});
        return list;
    }
    if (audio_options) {
        if (song_picker) {
            std::vector<UiButton> list{
                {.06, .30, .88, .075, song_selection.empty() ? "RANDOM (SELECTED)" : "RANDOM", UiAction::SelectSong}};
            for (std::size_t i = song_page * 5; i < std::min(song_choices.size(), song_page * 5 + 5); ++i)
                list.push_back({.06,
                                .39 + double(i - song_page * 5) * .09,
                                .88,
                                .075,
                                (song_selection == song_choices[i] ? "> " : "") + song_choices[i],
                                UiAction::SelectSong,
                                {},
                                song_choices[i]});
            list.push_back({.06, .85, .26, .085, "PREV", UiAction::PreviousSongPage});
            list.push_back({.37, .85, .26, .085, "BACK", UiAction::Songs});
            list.push_back({.68, .85, .26, .085, "NEXT", UiAction::NextSongPage});
            return list;
        }
        return {{.06, .34, .18, .10, "-", UiAction::VolumeDown},
                {.27, .34, .46, .10,
                 master_volume == 0 ? "MUTED / RESTORE"
                                    : "VOLUME: " + std::to_string(int(std::round(master_volume * 100))) + "% / MUTE",
                 UiAction::MasterMute},
                {.76, .34, .18, .10, "+", UiAction::VolumeUp},
                {.06, .48, .88, .10, music_enabled ? "MUSIC: ON" : "MUSIC: OFF", UiAction::Music},
                {.06, .62, .88, .10,
                 authored_music ? "AUTHORED TRACK" : "SONG: " + (song_selection.empty() ? "RANDOM" : song_selection),
                 authored_music ? UiAction::None : UiAction::Songs},
                {.06, .85, .88, .085, "BACK TO MENU", UiAction::Sound}};
    }
    if (library) {
        std::vector<UiButton> list;
        const auto count = library_count(),
                   start = immersive ? page * 5 : std::min(library_scroll, count > 5 ? count - 5 : 0);
        for (std::size_t i = start; i < std::min(count, start + 5); ++i) {
            const auto y = .30 + double(i - start) * .09;
            if (!iso_library)
                list.push_back({.06, y, .88, .075, map_paths[i].filename().string(), UiAction::LoadMap, map_paths[i]});
            else if (iso_source.empty())
                list.push_back(
                    {.06, y, .88, .075, iso_paths[i].filename().string(), UiAction::SelectSource, iso_paths[i]});
            else {
                const auto& [name, installed] = iso_courses[i];
                const auto found = import_rows.find(name);
                const auto* status = found == import_rows.end() ? nullptr : &found->second;
                if (installed)
                    list.push_back({.06, y, .88, .075, "PLAY " + name, UiAction::LoadMap, import_root / name});
                else if (status && (status->phase == CourseImportPhase::Queued ||
                                    status->phase == CourseImportPhase::Extracting)) {
                    list.push_back({.06,
                                    y,
                                    .70,
                                    .075,
                                    (status->phase == CourseImportPhase::Queued ? "QUEUED " : "EXTRACTING ") + name,
                                    UiAction::None,
                                    {},
                                    {},
                                    status->progress});
                    list.push_back({.78, y, .16, .075, "X", UiAction::CancelImport, {}, name});
                } else
                    list.push_back({.06, y, .88, .075, "EXTRACT " + name, UiAction::ImportMap, iso_source, name,
                                    status && status->phase != CourseImportPhase::Ready ? status->progress : ""});
            }
        }
        if (!immersive) {
            list.push_back({.06, .75, .42, .075, "REFRESH", UiAction::RefreshLibrary});
            list.push_back({.52, .75, .42, .075, iso_library ? "INSTALLED MAPS" : "ISO SOURCES", UiAction::Sources});
        }
        if (immersive)
            list.push_back({.06, .85, .26, .085, "PREV", UiAction::Previous});
        list.push_back(
            {immersive ? .37 : .06, .85, immersive ? .26 : .88, .075,
             iso_library && !iso_source.empty() ? "ISOS" : "BACK",
             iso_library ? (iso_source.empty() ? UiAction::Sources : UiAction::SelectSource) : UiAction::Maps});
        if (immersive)
            list.push_back({.68, .85, .26, .085, "NEXT", UiAction::Next});
        return list;
    }
    if (rider_options)
        return {{.06, .36, .42, .12, "FEWER", UiAction::RiderDown},
                {.52, .36, .42, .12, "MORE", UiAction::RiderUp},
                {.06, .85, .88, .085, "BACK TO MENU", UiAction::Riders}};
    if (controls)
        return {{.06, .85, .88, .085, "BACK TO MENU", UiAction::Controls}};
    std::vector<UiButton> list{
        {.06, .30, .42, .095, "RESUME", UiAction::Resume},
        {.52, .30, .42, .095, "RESTART", UiAction::Restart},
        {.06, .42, .42, .095, third_person ? "VIEW: 3RD PERSON" : "VIEW: 1ST PERSON", UiAction::View},
        {.52, .42, .42, .095, "CONTROLS", UiAction::Controls},
        {.06, .54, .42, .095, "AUDIO", UiAction::Sound},
        {.52, .54, .42, .095, "GRAPHICS", UiAction::Graphics},
        {.06, .66, .42, .095, immersive ? "RECALL BOARD" : "MODE / NEW RUN",
         immersive ? UiAction::Recall : UiAction::Mode},
        {.52, .66, .42, .095, immersive ? "RECENTER VIEW" : "MAP LIBRARY",
         immersive ? UiAction::Calibrate : UiAction::Maps},
        {.06, .78, .42, .095, immersive ? (head_steer ? "HEAD STEER: ON" : "HEAD STEER: OFF") : "RECALL BOARD",
         immersive ? UiAction::HeadSteer : UiAction::Recall},
        {.52, .78, .42, .095, immersive && map_picker ? "MAP LIBRARY" : "EXIT",
         immersive && map_picker ? UiAction::Maps : UiAction::Exit}};
    if (immersive && map_picker)
        list.push_back({.06, .895, .88, .065, "EXIT APP", UiAction::Exit});
    return list;
}

bool RideUi::riders(UiAction action, Player& player) {
    if (action == UiAction::Riders) {
        rider_options = !rider_options;
        notice.clear();
        return true;
    }
    if (action != UiAction::RiderDown && action != UiAction::RiderUp)
        return false;
    const auto count = player.ai_field() ? player.ai_field()->size() : 0;
    try {
        player.ai_riders(action == UiAction::RiderUp ? std::min(16u, count + 1) : count ? count - 1 : 0);
        notice.clear();
    } catch (const std::exception&) {
        notice = "OPPONENTS UNAVAILABLE ON THIS MAP";
    }
    return true;
}

std::size_t RideUi::library_count() const {
    return iso_library ? (iso_source.empty() ? iso_paths.size() : iso_courses.size()) : map_paths.size();
}

bool RideUi::scroll_library(double steps) {
    if (!visible || !library || immersive || loading)
        return false;
    if (!std::isfinite(steps))
        throw std::invalid_argument("Invalid library scroll");
    scroll_remainder_ += std::clamp(steps, -1000., 1000.);
    const auto whole = std::trunc(scroll_remainder_);
    scroll_remainder_ -= whole;
    const auto count = library_count(), limit = count > 5 ? count - 5 : 0;
    library_scroll = std::size_t(std::clamp(double(library_scroll) - whole, 0., double(limit)));
    return true;
}

UiResult RideUi::pointer(const EquipmentRay& ray, bool down) {
    hover_ = -1;
    bool inside = false;
    if (visible && frame_.valid && ray.valid) {
        const auto normal = normalized(cross(frame_.right, frame_.down));
        const auto d = dot(ray.direction, normal);
        if (std::abs(d) > 1e-8) {
            const auto t = dot(frame_.origin - ray.origin, normal) / d;
            if (t >= 0 && t <= 4) {
                const auto delta = ray.origin + ray.direction * t - frame_.origin;
                const auto x = dot(delta, frame_.right) / dot(frame_.right, frame_.right),
                           y = dot(delta, frame_.down) / dot(frame_.down, frame_.down);
                inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
                const auto count = library_count();
                if (library && !immersive && !loading && count > 5 && down &&
                    (scroll_drag_ ||
                     (!pressed_ && x >= .95 && x <= .985 && y >= library_top && y <= library_top + library_height))) {
                    const auto thumb = std::max(.035, library_height * 5 / double(count)),
                               travel = library_height - thumb;
                    const auto top =
                        library_top + travel * double(std::min(library_scroll, count - 5)) / double(count - 5);
                    if (!scroll_drag_)
                        scroll_grab_ = y >= top && y <= top + thumb ? y - top : thumb / 2;
                    scroll_drag_ = captured_ = true;
                    library_scroll = std::size_t(
                        std::round(std::clamp((y - library_top - scroll_grab_) / travel, 0., 1.) * double(count - 5)));
                    pressed_ = true;
                    return {UiAction::None, true};
                }
                const auto list = buttons();
                for (unsigned i = 0; i < list.size(); ++i) {
                    const auto& b = list[i];
                    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
                        hover_ = int(i);
                }
            }
        }
    }
    UiResult result;
    if (down && !pressed_ && inside) {
        captured_ = true;
        if (hover_ >= 0) {
            const auto list = buttons();
            const auto& b = list[std::size_t(hover_)];
            result.action = b.action;
            result.map = b.map;
            result.value = b.value;
        }
    }
    result.consumed = captured_ || inside;
    if (!down) {
        captured_ = false;
        scroll_drag_ = false;
    }
    pressed_ = down;
    return result;
}

UiFrame RideUi::desktop(const CameraPose& c, double aspect, bool menu) {
    const auto right = normalized(cross(c.forward, c.up)), up = normalized(cross(right, c.forward));
    const auto height = .50 * std::tan(c.fov / 2) * (menu ? 1.20 : 1.96);
    // The menu's row spacing is shared with the wrist panel. Keep its physical
    // aspect while shrinking so square font pixels cannot overlap adjacent rows.
    const auto width = menu ? std::min(height * std::min(aspect, 1.34), .95) : height * aspect;
    return {c.eye + c.forward * .50 - right * (width * .5) + up * (height * .5),
            right * width,
            -up * height,
            true,
            true,
            2 * width / (std::tan(c.fov / 2) * aspect),
            2 * height / std::tan(c.fov / 2)};
}

UiFrame RideUi::wrist(const ControllerPose& c, Vec3, Vec3 offset) {
    if (!c.valid)
        return {};
    const auto centre = c.position + offset + c.forward * .34 + c.up * .025;
    const auto right = c.right, up = c.forward;
    return {centre - right * .23 + up * .17, right * .46, -up * .34, true};
}

void RideUi::append(std::vector<Vertex>& out, const Player& p, bool wrist, double fps) const {
    if (!frame_.valid)
        return;
    const Canvas c{out, frame_};
    const auto speed = std::to_string(int(length(p.rider().velocity) * 3.6));
    const auto& run = p.course_run().status();
    if (wrist && !visible) {
        c.rect(0, 0, 1, .17, panel);
        c.rect(0, 0, .012, .17, accent);
        c.text(speed + " KM/H  " +
                   (p.carrying_board() ? "IN HAND"
                    : p.on_foot()      ? "ON FOOT"
                                       : "RIDING"),
               .04, .035, .006, accent);
        c.text("Y MENU  /  A JUMP  /  B BOOST", .04, .11, .0036, muted);
        if (stats)
            c.text("FPS " + std::to_string(int(fps)), .04, .20, .004, muted);
        if (const auto* field = p.ai_field())
            c.text("PLACE " + std::to_string(field->place() + 1) + " / " + std::to_string(field->size() + 1), .04, .27,
                   .004, accent);
        return;
    }
    if (visible) {
        c.rect(0, 0, 1, 1, panel);
        c.rect(0, 0, 1, .012, accent);
        c.text("OPEN SLOPE " + std::string(application_version()), .06, .045, .005, accent);
        c.text(loading ? (importing ? (iso_courses.empty() ? "READING ISO" : "EXTRACTING COURSE") : "LOADING COURSE")
               : rider_options    ? "OPPONENTS"
               : graphics_options ? "GRAPHICS"
               : audio_options    ? (song_picker ? "CHOOSE SONG" : "AUDIO")
               : library          ? (iso_library ? (iso_source.empty() ? "ISO SOURCES" : "ISO COURSES") : "MAP LIBRARY")
               : controls         ? "CONTROLS"
                                  : "ON THE MOUNTAIN",
               .06, .13, .008);
        c.text(loading            ? load_name
               : graphics_options ? (immersive ? "SNOWFALL / DISPLAY STATS" : "SCENE QUALITY / WEATHER")
               : library
                   ? (iso_library ? (iso_source.empty() ? "SUPPORT: SSX TRICKY (PS2)" : iso_source.filename().string())
                                  : "INSTALLED / CUSTOM MAPS")
               : audio_options ? (authored_music ? "AUTHORED MOUNTAIN MUSIC"
                                                 : "RUN SONG: " + (current_song.empty() ? "NO TRACK" : current_song))
                               : speed + " KM/H  /  " +
                                     (p.carrying_board() ? "CARRYING"
                                      : p.on_foot()      ? "ON FOOT"
                                                         : "RIDING"),
               .06, .235, audio_options ? .0036 : .004, muted);
        if (!audio_options && !graphics_options && !rider_options && !loading && !library)
            c.text(std::string(run_name(run.mode)), .70, .235, .0035, accent);
        if (loading) {
            c.text(load_stage, .06, .38, .004, ink);
            c.rect(.06, .52, .88, .035, {.10f, .16f, .20f});
            if (importing)
                c.rect(.06 + .66 * std::clamp(load_progress, 0., 1.), .52, .22, .035, accent);
            else
                c.rect(.06, .52, .88 * std::clamp(load_progress, 0., 1.), .035, accent);
            c.text(importing ? "EXTRACT ONCE / PLAY FROM MAPS" : "PREPARING YOUR COURSE", .06, .62, .0038, muted);
        }
        if (library && !loading) {
            if (!library_error.empty() && iso_library && iso_courses.empty()) {
                c.text("THIS COURSE SOURCE COULD NOT BE OPENED", .06, .34, .0037, ink);
                c.text(library_error, .06, .43, .0032, muted);
                c.text("SUPPORTED: SSX TRICKY (PS2)", .06, .52, .0037, muted);
            } else if (iso_library && iso_source.empty() && iso_paths.empty()) {
                c.text("PUT .ISO FILES BESIDE THE EXE", .06, .37, .004, ink);
                c.text("THEN CHOOSE REFRESH", .06, .45, .0037, muted);
                c.text("OR ADD CUSTOM COURSES TO MAPS", .06, .54, .0037, muted);
            } else if (!iso_library && map_paths.empty() && !immersive) {
                c.text("NO INSTALLED MAPS YET", .06, .37, .004, ink);
                c.text("CHOOSE ISO SOURCES TO GET STARTED", .06, .45, .0037, muted);
            }
        }
        if (graphics_options) {
            c.text(!graphics_readout.empty() && !immersive ? graphics_readout : "0 CLEAR / 3 AMBIENT / 10 BLIZZARD",
                   .06, .79, .0027, muted);
        }
        if (rider_options && !loading) {
            const auto count = p.ai_field() ? p.ai_field()->size() : 0;
            c.text("AI RIDERS: " + std::to_string(count) + " / 16", .06, .56, .006, accent);
            c.text("ZERO FOR A SOLO MOUNTAIN", .06, .68, .0038, muted);
        }
        if (controls && !library && !audio_options && !graphics_options && !rider_options && !loading) {
            const std::array<std::string, 10> rows =
                wrist
                    ? std::array<std::string, 10>{"A   JUMP / DOUBLE JUMP FLY",      "B   AIM BOOST / BOARD THRUST",
                                                  "LEFT STICK   WALK / FLY / STEER", "RIGHT STICK   TURN / CLICK VIEW",
                                                  "TRIGGER   POINT TO RIDE",         "GRIP   PICK UP / PASS / THROW",
                                                  "GRIP BEHIND HEAD   SUMMON",       "AIR GRIP   TAKE BOARD OFF",
                                                  "HELD TRIGGER   RE-EQUIP",         "Y   SHOW / HIDE WRIST"}
                    : std::array<std::string, 10>{
                          "W S WALK / A D STRAFE OR CARVE",    "SPACE   JUMP / DOUBLE JUMP FLY",
                          "SHIFT   BOOST / HELD BOARD THRUST", "LMB DRAG   LOOK / TURN ON FOOT",
                          "RMB ON BOARD   CARRY / THROW",      "E   SPAWN AND RIDE / STEP OFF",
                          "CTRL   CROUCH / FLY DOWN",          "WHEEL   ZOOM   G   NEARBY BOARD",
                          "R   COURSE RESET   T   RESTART",    "V   VIEW   ESC   MENU"};
            for (unsigned i = 0; i < rows.size(); ++i)
                c.text(rows[i], .06, .31 + i * .048, .0037, i == 4 || i == 5 ? accent : ink);
        }
        if (library && !immersive && !loading) {
            const auto count = library_count();
            if (count > 5) {
                const auto thumb = std::max(.035, library_height * 5 / double(count));
                c.rect(.958, library_top, .012, library_height, {.10f, .16f, .20f});
                c.rect(.958,
                       library_top +
                           (library_height - thumb) * double(std::min(library_scroll, count - 5)) / double(count - 5),
                       .012, thumb, accent);
            }
            const auto queued = std::count_if(import_rows.begin(), import_rows.end(), [](const auto& row) {
                return row.second.phase == CourseImportPhase::Queued;
            });
            const auto active = std::count_if(import_rows.begin(), import_rows.end(), [](const auto& row) {
                return row.second.phase == CourseImportPhase::Extracting;
            });
            c.text(active || queued ? std::to_string(active) + " EXTRACTING / " + std::to_string(queued) + " QUEUED"
                   : count > 5      ? "SCROLL TO SEE MORE"
                                    : "",
                   .06, .943, .0024, muted);
        }
        if (library && map_paths.empty() && immersive && !loading)
            c.text("PLACE MAP FOLDERS IN MAPS", .06, .44, .005, muted);
        const auto list = buttons();
        for (unsigned i = 0; i < list.size(); ++i) {
            const auto& b = list[i];
            const bool selected = int(i) == hover_;
            c.rect(b.x, b.y, b.w, b.h, selected ? Colour{.06f, .25f, .25f} : Colour{.06f, .10f, .145f}, .0002);
            c.rect(b.x, b.y, .006, b.h, selected ? accent : Colour{.12f, .23f, .29f}, .0003);
            c.text(b.text, b.x + .018, b.y + (b.detail.empty() ? .035 : .012), b.detail.empty() ? .0036 : .0032,
                   selected ? accent : ink);
            if (!b.detail.empty())
                c.text(b.detail, b.x + .018, b.y + .047, .0023, muted);
        }
        c.text(loading           ? "LOADING..."
               : !notice.empty() ? notice
               : wrist           ? "POINT RIGHT HAND + TRIGGER"
                                 : "ESC TO RETURN TO THE SLOPE",
               .06, .973, .0025, muted);
    } else {
        c.rect(0, 0, 1, .048, panel);
        c.rect(0, 0, .004, .048, accent);
        const auto state = p.carrying_board() ? "IN HAND" : p.flying() ? "FLYING" : p.on_foot() ? "ON FOOT" : "RIDING";
        c.text(state, .014, .013, .0022, accent);
        c.text(speed + " KM/H", .16, .013, .0022);
        c.text(run_readout(run), .30, .013, .0021, muted);
        if (run.mode == RunMode::Showoff)
            c.text("SCORE " + std::to_string(p.scoring().status().banked), .57, .013, .0021);
        else if (run.mode == RunMode::Race)
            c.text("LAP " + std::to_string(run.lap) + "/" + std::to_string(run.passes), .57, .013, .0021);
        if (const auto* field = p.ai_field())
            c.text(std::to_string(field->place() + 1) + "/" + std::to_string(field->size() + 1), .72, .013, .0021,
                   accent);
        c.text("BOOST", .79, .015, .0017, muted);
        c.rect(.86, .022, .12, .007, {.12f, .20f, .25f});
        const auto energy =
            p.on_foot() || !p.scoring().status().active ? 1. : double(p.scoring().meter_segments()) / 15;
        c.rect(.86, .022, .12 * energy, .007, accent);
        c.rect(0, .965, 1, .035, panel);
        const auto display = trick_display(p.scoring());
        if (run.mode == RunMode::Showoff && display.state != TrickDisplayState::None) {
            const auto colour = display.state == TrickDisplayState::Lost ? Colour{1, .25f, .2f} : accent;
            const auto prefix = display.state == TrickDisplayState::Live   ? "+"
                                : display.state == TrickDisplayState::Lost ? "LOST "
                                                                           : "BANKED ";
            c.text(prefix + std::to_string(display.points) + "  " + display.detail, .014, .976, .0017, colour);
        } else
            c.text(p.carrying_board()    ? "RELEASE RMB THROW / E RIDE"
                   : p.flying()          ? "WASD THRUST / SPACE UP / CTRL DOWN"
                   : p.board_highlight() ? "E RIDE / HOLD RMB CARRY"
                   : p.on_foot()         ? "SPACE TWICE FLY / E BOARD / ESC MENU"
                                         : "E OFF BOARD / LMB DRAG LOOK / SPACE JUMP",
                   .014, .976, .0017, p.board_highlight() ? accent : ink);
        const auto run_message = run_notice(run);
        if (!run_message.empty())
            c.text(run_message, .65, .976, .0017, accent);
        else if (p.rider().charge > 0) {
            c.text("JUMP", .65, .977, .0015, muted);
            c.rect(.70, .981, .12, .006, {.12f, .20f, .25f});
            c.rect(.70, .981, .12 * p.rider().charge, .006, accent);
        }
        if (stats)
            c.text("FPS " + std::to_string(int(fps)), .87, .976, .0017, muted);
    }
    if (stats && visible)
        c.text("FPS " + std::to_string(int(fps)), .74, .065, .0035, muted);
}

void RideUi::append_pointer(std::vector<Vertex>& out, const EquipmentRay& ray) const {
    if (!visible || !frame_.valid || !ray.valid)
        return;
    const auto n = normalized(cross(frame_.right, frame_.down));
    const auto denom = dot(ray.direction, n);
    auto distance = std::abs(denom) > 1e-6 ? dot(frame_.origin - ray.origin, n) / denom : 2.;
    distance = std::clamp(distance, 0., 2.);
    const auto end = ray.origin + normalized(ray.direction) * distance;
    const auto side = normalized(cross(ray.direction, {0, 1, 0}), {1, 0, 0}) * .001;
    quad(out, ray.origin - side, ray.origin + side, end + side, end - side, accent);
    const auto r = normalized(frame_.right) * .003, u = normalized(frame_.down) * .003;
    quad(out, end - r - u - n * .002, end + r - u - n * .002, end + r + u - n * .002, end - r + u - n * .002, ink);
}

void equipment_outline(std::vector<Vertex>& out, const Player& p) {
    if (!p.board_highlight() || p.carrying_board())
        return;
    const EquipmentPose pose{p.render_board_position(), p.render_forward(), p.render_up()};
    const auto at = [&](double x, double z) {
        return equipment_point(pose, {x, equipment_height + equipment_half_height + .012, z});
    };
    constexpr Colour col{.22f, 1, .78f};
    const auto width = equipment_half_width + .015, length = equipment_half_length + .015;
    for (const auto x : {-width, width - .01})
        quad(out, at(x, -length), at(x + .01, -length), at(x + .01, length), at(x, length), col);
    for (const auto z : {-length, length - .01})
        quad(out, at(-width, z), at(width, z), at(width, z + .01), at(-width, z + .01), col);
}

EquipmentInput desktop_equipment(const Player& p, const EquipmentRay& ray, bool grip) {
    EquipmentInput e;
    e.relative = true;
    e.head = {0, 1.65, 0};
    e.facing = normalized(ray.direction, {0, 0, -1});
    e.rays[1] = ray;
    e.rays[1].origin -= p.rider().position;
    e.grip[1] = grip;
    const auto facing = normalized(project(e.facing, {0, 1, 0}), p.camera_forward()),
               right = normalized(cross(facing, {0, 1, 0}));
    const auto shoulder = p.rider().position + Vec3{0, 1.35, 0} + right * .165;
    const auto direction = normalized(ray.direction, {0, 0, -1});
    const auto target = ray.origin + direction * std::max(.5, dot(shoulder - ray.origin, direction) + .8);
    const auto wrist = shoulder + normalized(target - shoulder, facing) * .55;
    const auto hand_right = normalized(cross(right, direction), {0, 1, 0});
    auto& h = e.hands[1];
    h = {wrist - p.rider().position, hand_right, direction, right, true};
    return e;
}
} // namespace openslope
