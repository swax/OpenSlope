#include "openslope/audio_scene.hpp"
#include "music_playback.hpp"
#include "openslope/audio_program.hpp"
#include "openslope/board_audio.hpp"
#include "openslope/import.hpp"
#include "openslope/music.hpp"
#include "openslope/music_stream.hpp"
#include <cctype>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <nlohmann/json.hpp>
#include <random>
#include <set>

namespace openslope {
namespace {
using Json = nlohmann::json;

struct MusicMix {
    double race, intro, fade;
};

const MusicMix& music_mix() {
    static const auto mix = [] {
        const auto json = Json::parse(std::begin(bundled::music_playback), std::end(bundled::music_playback));
        if (json.at("schema") != "openslope-music-playback/v1")
            throw std::runtime_error("Unknown music playback profile");
        const MusicMix value{json.at("raceGain"), json.at("introGain"), json.at("fadeSeconds")};
        if (!std::isfinite(value.race) || value.race < 0 || value.race > 1 || !std::isfinite(value.intro) ||
            value.intro < 0 || value.intro > 1 || !std::isfinite(value.fade) || value.fade <= 0)
            throw std::runtime_error("Invalid music playback profile");
        return value;
    }();
    return mix;
}

Json read(const std::filesystem::path& path) {
    if (std::filesystem::file_size(path) > 64 * 1024 * 1024)
        throw std::runtime_error("Audio JSON exceeds its limit");
    std::ifstream file(path);
    return Json::parse(file);
}

std::filesystem::path asset(const std::filesystem::path& root, const std::string& name) {
    const auto base = std::filesystem::weakly_canonical(root), path = std::filesystem::weakly_canonical(base / name),
               relative = path.lexically_relative(base);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
        throw std::runtime_error("Audio asset escapes its course");
    return path;
}

std::string folded(std::string value) {
    for (auto& c : value)
        c = char(std::tolower(static_cast<unsigned char>(c)));
    return value;
}

std::string audio_key(const std::string& name) { return name.starts_with("Audio/SFX/") ? folded(name) : name; }

std::filesystem::path named_child(const std::filesystem::path& folder, const std::string& name) {
    if (!std::filesystem::is_directory(folder))
        return folder / name;
    std::filesystem::path result;
    unsigned count = 0;
    for (const auto& entry : std::filesystem::directory_iterator(folder)) {
        if (++count > 20000)
            throw std::runtime_error("Audio directory exceeds its limit");
        if (folded(entry.path().filename().string()) != folded(name))
            continue;
        if (!result.empty())
            throw std::runtime_error("Ambiguous audio asset name");
        result = asset(folder, entry.path().filename().string());
    }
    return result.empty() ? folder / name : result;
}

unsigned authored_key(const std::string& key) {
    if (key.empty() || key.size() > 5 ||
        !std::all_of(key.begin(), key.end(), [](unsigned char c) { return c >= '0' && c <= '9'; }))
        throw std::runtime_error("Invalid authored audio identity");
    const auto value = std::stoul(key);
    if (value > 65535)
        throw std::runtime_error("Authored audio identity exceeds its limit");
    return unsigned(value);
}

std::string authored_clip(const Json& name) {
    if (!name.is_string() || !valid_map_name(name.get<std::string>()) ||
        folded(std::filesystem::path(name.get<std::string>()).extension().string()) != ".wav")
        throw std::runtime_error("Unsafe authored audio filename");
    return "Sounds/" + name.get<std::string>();
}

BoardMix board_mix(const Json& value) {
    BoardMix mix;
    if (!value.is_object())
        return mix;
    if (value.contains("enabled") && value.at("enabled").is_boolean())
        mix.enabled = value.at("enabled");
    const auto trim = [&](const char* key, double fallback) {
        if (!value.contains(key) || !value.at(key).is_number())
            return fallback;
        const auto v = value.at(key).get<double>();
        return std::isfinite(v) ? std::clamp(v, 0., 1.) : fallback;
    };
    mix.volume = trim("volume", mix.volume);
    mix.glide = trim("glide", mix.glide);
    mix.carve = trim("carve", mix.carve);
    mix.transients = trim("transients", mix.transients);
    mix.cues = trim("cues", mix.cues);
    return mix;
}

std::string slot_name(unsigned slot) {
    auto number = std::to_string(slot);
    while (number.size() < 3)
        number.insert(number.begin(), '0');
    return number;
}

Vec3 axes(Vec3 p) { return {p.x, p.z, -p.y}; }

std::size_t loop_match(const std::vector<float>& full, const std::vector<float>& pattern) {
    if (pattern.empty() || pattern.size() > full.size())
        throw std::runtime_error("Invalid loop-region WAV");
    std::vector<std::size_t> prefix(pattern.size());
    for (std::size_t i = 1, j = 0; i < pattern.size(); ++i) {
        while (j && pattern[i] != pattern[j])
            j = prefix[j - 1];
        if (pattern[i] == pattern[j])
            ++j;
        prefix[i] = j;
    }
    for (std::size_t i = 0, j = 0; i < full.size(); ++i) {
        while (j && full[i] != pattern[j])
            j = prefix[j - 1];
        if (full[i] == pattern[j])
            ++j;
        if (j == pattern.size())
            return i + 1 - j;
    }
    throw std::runtime_error("Loop WAV is not a region of its full clip");
}
} // namespace

struct AudioScene::Data {
    std::filesystem::path root;
    AudioMixer mixer;
    AudioListener listener;
    mutable std::mutex mutex;
    std::mutex service_mutex;
    AudioStats stats;

    struct Cached {
        std::shared_ptr<PcmClip> clip;
        std::uint64_t touched{};
        bool resident = false;
    };

    std::map<std::string, Cached> clips;
    std::uint64_t age = 0;
    std::set<std::string> failed;
    std::map<unsigned, std::string> banks;
    std::map<int, std::string> events;
    std::map<unsigned, std::string> course_clips;
    std::map<std::string, std::filesystem::path> sources;
    std::vector<std::filesystem::path> audio_roots;
    std::string environment_clip;
    double environment_gain = 0, environment_fade = 0;
    std::uint64_t environment_voice = 0;
    BoardMix mix;
    BoardAudio performance;
    std::vector<unsigned> surface_groups;

    struct Sound {
        int event = -1;
        std::string clip;
        Vec3 position;
        bool enabled = false;
        double debounce = 0;
    };

    std::vector<Sound> sounds;

    struct Emitter {
        std::size_t instance{};
        unsigned type{}, event{}, radial{}, angular{};
        std::string clip;
        Vec3 offset, extents, axis{0, 1, 0};
        double radius{}, cone{};
        std::uint64_t voice{};
        bool inside = false;
    };

    std::vector<Emitter> emitters;
    std::array<std::uint64_t, 4> board{};
    int family = -1;
    std::uint64_t boost{};
    unsigned boost_slot = 120;
    double predicted_flight = 0;
    bool predicting_air = false;
    std::vector<std::string> playlist;
    std::size_t song = 0;
    std::string song_selection;
    std::mt19937 random{std::random_device{}()};
    std::unique_ptr<MusicStream> authored_music, intro_music;
    double race_fade = 0;
    bool music_on = true, race_wanted = false;
    std::uint64_t run_serial = 0;
    MusicGraph graph;
    MusicCursor cursor, pending_cursor;
    std::uint64_t music_voice{}, music_generation{};
    double music_gain = music_mix().race;
    unsigned level = 80;
    std::optional<unsigned> pending_event;
    bool music_ready = false, pending_ready = false, music_start_pending = true;
    std::uint64_t music_revision = 0;
    std::uint64_t queued_revision = 0;
    bool music_reroute = false;
    std::uint64_t serial = 0, teleports = 0;

    explicit Data(std::filesystem::path map_root)
        : root(map_root.empty() ? map_root : std::filesystem::weakly_canonical(map_root)) {
        if (root.empty())
            return;
        if (std::filesystem::exists(root / "Audio/SoundIndex.json")) {
            const auto index = read(asset(root, "Audio/SoundIndex.json"));
            if (index.value("Schema", "") == "openslope-sound-index/v1") {
                for (const auto& [key, value] : index.at("Banks").items()) {
                    const auto bank = value.get<std::string>();
                    if (!valid_map_name(bank))
                        throw std::runtime_error("Unsafe sound bank name");
                    banks[unsigned(std::stoul(key))] = bank;
                }
                for (const auto& [key, value] : index.at("CollisionEvents").items())
                    events[std::stoi(key)] = value.at("Clip");
            }
        }
        discover_banks();
        std::filesystem::path board_path;
        for (const auto& folder : audio_roots) {
            const auto path = asset(folder, "Audio/BoardSoundIndex.json");
            if (std::filesystem::is_regular_file(path)) {
                board_path = path;
                break;
            }
        }
        if (!board_path.empty()) {
            const auto index = read(board_path);
            if (index.value("Schema", "") == "openslope-board-sound-index/v1") {
                surface_groups = index.at("SurfaceGroups").get<std::vector<unsigned>>();
                if (surface_groups.size() > 256 ||
                    std::any_of(surface_groups.begin(), surface_groups.end(), [](auto x) { return x > 9; }))
                    throw std::runtime_error("Invalid board surface groups");
            }
        }
        if (std::filesystem::exists(root / "Slopesmith.json")) {
            const auto doc = read(asset(root, "Slopesmith.json"));
            if (doc.value("schema", 0) == 1 && doc.value("kind", "") == "slopesmith-export" &&
                doc.contains("boardSound"))
                mix = board_mix(doc.at("boardSound"));
        }
        if (std::filesystem::exists(root / "Audio/BoardMix.json")) {
            const auto doc = read(asset(root, "Audio/BoardMix.json"));
            if (doc.value("schema", "") == "openslope-board-mix/v1")
                mix = board_mix(doc.at("boardSound"));
        }
        if (std::filesystem::exists(root / "Audio/Environment.json")) {
            const auto doc = read(asset(root, "Audio/Environment.json"));
            if (doc.value("Schema", "") == "openslope-environment-audio/v1" && doc.contains("Bed") &&
                !doc.at("Bed").is_null()) {
                const auto& bed = doc.at("Bed");
                environment_clip = bed.at("Clip");
                environment_gain = bed.value("Volume", .15);
                if (!std::isfinite(environment_gain) || environment_gain < 0 || environment_gain > 1)
                    throw std::runtime_error("Invalid environment audio volume");
            }
        }
        if (std::filesystem::exists(root / "Instances.json")) {
            const auto rows = read(asset(root, "Instances.json")).at("Instances");
            if (!rows.is_array() || rows.size() > 100000)
                throw std::runtime_error("Invalid audio instance count");
            sounds.resize(rows.size());
            const auto placements = prop_placements(root);
            for (std::size_t i = 0; i < rows.size(); ++i) {
                const auto& row = rows[i];
                sounds[i].position = {placements[i][12], placements[i][13], placements[i][14]};
                if (!row.value("IncludeSound", false) || !row.contains("Sounds") || row.at("Sounds").is_null())
                    continue;
                const auto& sound = row.at("Sounds");
                sounds[i].event = sound.value("CollisonSound", -1);
                if (row.contains("SoundClip") && !row.at("SoundClip").is_null())
                    sounds[i].clip = authored_clip(row.at("SoundClip"));
                if (sound.contains("ExternalSounds"))
                    for (const auto& source : sound.at("ExternalSounds")) {
                        Emitter e;
                        e.instance = i;
                        e.type = source.at("U0");
                        e.event = source.at("SoundIndex");
                        if (source.contains("SoundClip") && !source.at("SoundClip").is_null())
                            e.clip = authored_clip(source.at("SoundClip"));
                        e.offset = axes({source.at("U2"), source.at("U3"), source.at("U4")}) / 100.;
                        e.radius = source.at("U5").get<double>() / 100.;
                        if (!finite(e.offset) || !std::isfinite(e.radius) || e.radius <= 0 || e.type > 3)
                            throw std::runtime_error("Invalid placed audio emitter");
                        if (e.type == 0)
                            e.radial = source.at("U6");
                        if (e.type == 1) {
                            e.extents = {e.radius, source.at("U6").get<double>() / 100,
                                         source.at("U7").get<double>() / 100};
                            e.axis = normalized(axes({source.at("U8"), source.at("U9"), source.at("U10")}));
                            e.radial = source.at("U11");
                        }
                        if (e.type == 2) {
                            e.axis = normalized(axes({source.at("U6"), source.at("U7"), source.at("U8")}));
                            e.radial = source.at("U9");
                            e.cone = source.at("U10");
                            e.angular = source.at("U11");
                        }
                        if (e.radial > 5 || e.angular > 5)
                            throw std::runtime_error("Unsupported ambient curve");
                        emitters.push_back(e);
                        if (emitters.size() > 100000)
                            throw std::runtime_error("Too many ambient emitters");
                    }
            }
        }
        if (std::filesystem::exists(root / "Audio/ExternalIndex.json")) {
            const auto index = read(asset(root, "Audio/ExternalIndex.json"));
            if (index.value("Schema", "") == "openslope-external-sounds/v1")
                for (const auto& [key, row] : index.at("Events").items())
                    events[std::stoi(key)] = row.at("Clip");
        }
        if (std::filesystem::exists(root / "Effects.json")) {
            const auto doc = read(asset(root, "Effects.json"));
            if (doc.contains("extensions") && doc.at("extensions").contains("slopesmith")) {
                const auto& authored = doc.at("extensions").at("slopesmith");
                if (authored.contains("customSoundEvents"))
                    for (const auto& [key, name] : authored.at("customSoundEvents").items())
                        events[int(authored_key(key))] = authored_clip(name);
                if (authored.contains("customSounds"))
                    for (const auto& [key, name] : authored.at("customSounds").items()) {
                        course_clips[authored_key(key)] = authored_clip(name);
                    }
            }
        }
        if (std::filesystem::exists(root / "Audio/Music/playlist.json")) {
            const auto list = read(asset(root, "Audio/Music/playlist.json"));
            if (list.is_array())
                playlist = list.get<std::vector<std::string>>();
            if (playlist.size() > 64)
                throw std::runtime_error("Music playlist exceeds its limit");
            for (const auto& name : playlist)
                if (!valid_map_name(name))
                    throw std::runtime_error("Unsafe music song name");
        }
        prepare_music();
        choose_song();
        prewarm();
        mixer.music_mix(0, 0, true);
    }

    void choose_song() {
        if (playlist.empty()) {
            song = 0;
            return;
        }
        const auto selected = std::find(playlist.begin(), playlist.end(), song_selection);
        song = selected != playlist.end() ? std::size_t(selected - playlist.begin())
                                          : std::uniform_int_distribution<std::size_t>(0, playlist.size() - 1)(random);
    }

    void prepare_music() {
        const auto track = asset(root, "Music/track.wav");
        if (std::filesystem::is_regular_file(track)) {
            double start = 0, end = 0;
            if (std::filesystem::is_regular_file(asset(root, "Music/arrangement.json"))) {
                const auto arrangement = read(asset(root, "Music/arrangement.json"));
                if (arrangement.value("version", 0) == 1) {
                    const auto number = [&](const char* key) {
                        if (!arrangement.contains(key) || !arrangement.at(key).is_number())
                            return 0.;
                        const auto value = arrangement.at(key).get<double>();
                        return std::isfinite(value) ? std::max(0., value) : 0.;
                    };
                    start = number("loopStartSeconds");
                    end = number("loopEndSeconds");
                }
            }
            authored_music = std::make_unique<MusicStream>(mixer, std::vector<std::filesystem::path>{track},
                                                           AudioRole::RaceMusic, true, start, end, music_mix().race);
        }
        if (std::filesystem::exists(asset(root, "Audio/Environment.json")))
            return;
        auto folder = asset(root, "Audio/Intro");
        if (!std::filesystem::is_directory(folder))
            folder = asset(root, "Audio");
        if (!std::filesystem::is_directory(folder))
            return;
        std::vector<std::string> names;
        const auto index = asset(root, "Audio/Intro/stems.json");
        if (std::filesystem::is_regular_file(index)) {
            const auto rows = read(index);
            if (!rows.is_array() || rows.size() > 256)
                throw std::runtime_error("Invalid intro stem count");
            for (const auto& row : rows)
                names.push_back(row.at("Clip"));
        } else {
            unsigned count = 0;
            for (const auto& entry : std::filesystem::directory_iterator(folder)) {
                if (++count > 20000)
                    throw std::runtime_error("Intro audio directory exceeds its limit");
                if (folded(entry.path().extension().string()) == ".wav")
                    names.push_back(entry.path().filename().string());
            }
        }
        for (char tier : {'C', 'A', 'B'}) {
            std::vector<std::pair<unsigned, std::filesystem::path>> selected;
            for (const auto& name : names) {
                if (!valid_map_name(name))
                    throw std::runtime_error("Unsafe intro WAV name");
                const auto stem = std::filesystem::path(name).stem().string();
                const auto dash = stem.find_last_of('-'), at = dash == std::string::npos ? 0 : dash + 1;
                if (at + 1 >= stem.size() || std::toupper(static_cast<unsigned char>(stem[at])) != tier)
                    continue;
                const auto suffix = stem.substr(at + 1);
                if (suffix.size() > 5 ||
                    !std::all_of(suffix.begin(), suffix.end(), [](unsigned char c) { return c >= '0' && c <= '9'; }))
                    continue;
                const auto relative = (folder / name).lexically_relative(root).generic_string();
                const auto path = asset(root, relative);
                if (std::filesystem::is_regular_file(path))
                    selected.emplace_back(unsigned(std::stoul(suffix)), path);
            }
            if (selected.empty())
                continue;
            if (selected.size() > 64)
                throw std::runtime_error("Too many intro music phrases");
            std::sort(selected.begin(), selected.end());
            std::vector<std::filesystem::path> paths;
            for (const auto& [number, path] : selected)
                paths.push_back(path);
            intro_music = std::make_unique<MusicStream>(mixer, std::move(paths), AudioRole::Ambience, false, 0, 0,
                                                        music_mix().intro);
            break;
        }
    }

    void discover_banks() {
        audio_roots.push_back(root);
        const auto library = root.parent_path();
        if (!std::filesystem::is_directory(library))
            return;
        const auto shared = asset(library, "Shared");
        if (std::filesystem::is_directory(shared) && shared != std::filesystem::weakly_canonical(root))
            audio_roots.push_back(shared);
        std::vector<std::filesystem::path> courses;
        unsigned entries = 0;
        if (std::filesystem::is_regular_file(asset(root, "Patches.json")))
            for (const auto& entry : std::filesystem::directory_iterator(library)) {
                if (++entries > 20000) {
                    courses.clear();
                    break;
                }
                if (!valid_map_name(entry.path().filename().string()) || !entry.is_directory() ||
                    entry.path() == root || entry.path().filename() == "Shared")
                    continue;
                const auto course = asset(library, entry.path().filename().string());
                if (!std::filesystem::is_regular_file(asset(course, "Patches.json")))
                    continue;
                courses.push_back(course);
                if (courses.size() > 256) {
                    courses.clear();
                    break;
                }
            }
        std::sort(courses.begin(), courses.end(), [](const auto& a, const auto& b) {
            const auto x = folded(a.filename().string()), y = folded(b.filename().string());
            return x == y ? a.filename() < b.filename() : x < y;
        });
        audio_roots.insert(audio_roots.end(), courses.begin(), courses.end());
        if (!banks.contains(0))
            banks[0] = "zBxsfx";
        if (!banks.contains(1))
            banks[1] = "zboard";
        for (const auto& [group, bank] : banks) {
            const bool common = (group == 0 && folded(bank) == "zbxsfx") || (group == 1 && folded(bank) == "zboard");
            for (std::size_t i = 0; i < (common ? audio_roots.size() : 1); ++i) {
                const auto& folder = audio_roots[i];
                const auto directory = named_child(asset(folder, "Audio/SFX"), bank);
                if (!std::filesystem::is_directory(directory))
                    continue;
                unsigned count = 0;
                std::set<std::string> folder_names;
                for (const auto& entry : std::filesystem::directory_iterator(directory)) {
                    if (++count > 20000)
                        throw std::runtime_error("Sound bank exceeds its limit");
                    const auto stem = entry.path().stem().string();
                    if (folded(entry.path().extension().string()) != ".wav" || stem.empty() || stem.size() > 5 ||
                        !std::all_of(stem.begin(), stem.end(), [](unsigned char c) { return c >= '0' && c <= '9'; }))
                        continue;
                    const auto key = audio_key("Audio/SFX/" + bank + "/" + entry.path().filename().string());
                    if (!folder_names.insert(key).second)
                        throw std::runtime_error("Ambiguous sound slot filename");
                    sources.try_emplace(key, asset(folder, entry.path().lexically_relative(folder).generic_string()));
                    if (sources.size() > 4096)
                        throw std::runtime_error("Too many course audio clips");
                }
            }
        }
    }

    // Only course opening and the serialized music service may load files.
    std::shared_ptr<PcmClip> load_clip(const std::string& requested, bool resident = false,
                                       std::unique_lock<std::mutex>* state_lock = nullptr) {
        const auto name = audio_key(requested);
        if (failed.contains(name))
            return {};
        if (auto found = clips.find(name); found != clips.end()) {
            found->second.touched = ++age;
            return found->second.clip;
        }
        std::shared_ptr<PcmClip> value;
        std::string error;
        if (state_lock)
            state_lock->unlock();
        try {
            const auto source = sources.find(name);
            const auto path = source == sources.end() ? asset(root, requested) : source->second;
            if (std::filesystem::exists(path)) {
                value = std::make_shared<PcmClip>(PcmClip::load(path));
                if (resident) {
                    const auto loop_path = named_child(path.parent_path(), path.stem().string() + ".loop.wav");
                    if (std::filesystem::exists(loop_path)) {
                        const auto region = PcmClip::load(loop_path);
                        if (region.channels != value->channels || region.rate != value->rate)
                            throw std::runtime_error("Loop WAV format differs");
                        const auto begin = loop_match(value->samples, region.samples);
                        if (begin % value->channels || region.samples.size() % value->channels)
                            throw std::runtime_error("Invalid loop channel alignment");
                        value->loop_start = begin / value->channels;
                        value->loop_end = value->loop_start + region.frames();
                    }
                }
            }
        } catch (const std::exception& e) {
            error = e.what();
            value.reset();
        }
        if (state_lock)
            state_lock->lock();
        if (!value) {
            failed.insert(name);
            if (!error.empty())
                std::cerr << "Audio asset unavailable: " << name << " (" << error << ")\n";
            return {};
        }
        if (!resident)
            value->priority = 200;
        const auto bytes = value->samples.size() * sizeof(float);
        const auto budget = std::size_t(resident ? 96 : 120) * 1024 * 1024;
        if (resident && stats.decoded_bytes + bytes > budget) {
            failed.insert(name);
            ++stats.prewarm_skipped;
            return {};
        }
        while (stats.decoded_bytes + bytes > budget) {
            auto victim = clips.end();
            for (auto i = clips.begin(); i != clips.end(); ++i)
                if (!i->second.resident && i->second.clip.use_count() == 1 &&
                    (victim == clips.end() || i->second.touched < victim->second.touched))
                    victim = i;
            if (victim == clips.end())
                return {};
            stats.decoded_bytes -= victim->second.clip->samples.size() * sizeof(float);
            clips.erase(victim);
        }
        stats.decoded_bytes += bytes;
        value->priority = resident ? 90 : 101;
        clips[name] = {value, ++age, resident};
        if (resident)
            ++stats.prewarmed;
        return value;
    }

    std::shared_ptr<PcmClip> clip(const std::string& name) {
        const auto found = clips.find(audio_key(name));
        return found == clips.end() ? nullptr : found->second.clip;
    }

    void prewarm() {
        std::set<std::string> names;
        for (const auto& [name, path] : sources)
            names.insert(name);
        for (const auto& [slot, name] : course_clips)
            names.insert(name);
        if (!environment_clip.empty())
            names.insert(environment_clip);
        for (const auto& [event, name] : events)
            names.insert(name);
        for (const auto& sound : sounds)
            if (!sound.clip.empty())
                names.insert(sound.clip);
        for (const auto& emitter : emitters)
            if (!emitter.clip.empty())
                names.insert(emitter.clip);
        if (names.size() > 4096)
            throw std::runtime_error("Too many course audio clips");
        for (const auto& name : names)
            load_clip(name, true);
    }

    std::shared_ptr<PcmClip> slot(unsigned group, unsigned number) {
        if (group == 2 && course_clips.contains(number))
            return clip(course_clips.at(number));
        const auto bank = banks.find(group);
        return bank == banks.end() ? nullptr : clip("Audio/SFX/" + bank->second + "/" + slot_name(number) + ".wav");
    }

    void one_shot(std::shared_ptr<PcmClip> value, Vec3 position, double gain, bool spatial) {
        if (!value || gain <= 0)
            return;
        VoiceParams params;
        params.gain = std::clamp(gain, 0., 1.);
        params.spatial = spatial;
        params.position = position;
        mixer.play(std::move(value), params);
    }

    void start_music(std::unique_lock<std::mutex>& lock) {
        music_start_pending = false;
        const auto revision = music_revision;
        music_ready = false;
        pending_ready = false;
        music_voice = 0;
        cursor = {};
        if (playlist.empty())
            return;
        const auto name = playlist[song % playlist.size()];
        try {
            lock.unlock();
            MusicGraph loaded_graph;
            try {
                const auto folder = asset(root, "Audio/Music/" + name);
                loaded_graph = MusicGraph::load(folder / "graph.json");
            } catch (...) {
                lock.lock();
                throw;
            }
            lock.lock();
            if (revision != music_revision) {
                music_start_pending = true;
                return;
            }
            graph = std::move(loaded_graph);
            const auto sample = music_advance(graph, cursor, level);
            if (sample < 0)
                return;
            auto value = load_clip("Audio/Music/" + name + "/" + graph.samples[std::size_t(sample)].wav, false, &lock);
            if (revision != music_revision) {
                music_start_pending = true;
                return;
            }
            if (!value)
                return;
            VoiceParams params;
            params.gain = music_gain * cursor.action_volume;
            params.role = AudioRole::RaceMusic;
            music_voice = mixer.play(value, params);
            music_ready = music_voice != 0;
            music_generation = 0;
            stats.music_node = cursor.node;
            music_service(lock);
        } catch (const std::exception& e) {
            std::cerr << "Music unavailable: " << e.what() << '\n';
        }
    }

    void music_service_unchecked(std::unique_lock<std::mutex>& lock) {
        if (music_start_pending) {
            start_music(lock);
            return;
        }
        const auto revision = music_revision;
        if (!music_ready)
            return;
        const auto status = mixer.status(music_voice);
        if (!status) {
            music_ready = false;
            stats.music_node = -1;
            return;
        }
        if (status->generation != music_generation) {
            if (pending_ready) {
                cursor = pending_cursor;
                pending_ready = false;
                if (queued_revision == music_revision)
                    pending_event.reset();
            }
            music_generation = status->generation;
            stats.music_node = cursor.node;
        }
        if (pending_ready && !music_reroute)
            return;
        music_reroute = false;
        auto next_cursor = cursor;
        const auto sample = music_advance(graph, next_cursor, level, pending_event);
        std::shared_ptr<PcmClip> value;
        if (sample >= 0) {
            const auto name = playlist[song % playlist.size()];
            value = load_clip("Audio/Music/" + name + "/" + graph.samples[std::size_t(sample)].wav, false, &lock);
            if (revision != music_revision)
                return;
        }
        VoiceParams params;
        params.gain = music_gain * next_cursor.action_volume;
        params.role = AudioRole::RaceMusic;
        if (!mixer.queue(music_voice, value, params, status->generation)) {
            music_reroute = true;
            return;
        }
        pending_cursor = next_cursor;
        queued_revision = revision;
        pending_ready = true;
    }

    void music_service(std::unique_lock<std::mutex>& lock) {
        if (!race_wanted || authored_music)
            return;
        try {
            music_service_unchecked(lock);
        } catch (const std::exception& e) {
            music_ready = false;
            mixer.queue(music_voice, {});
            std::cerr << "Music scheduler stopped: " << e.what() << '\n';
        }
    }

    void reset(bool new_run = true) {
        if (new_run) {
            if (authored_music) {
                authored_music->playing(false);
                authored_music->restart();
            }
            if (intro_music) {
                intro_music->playing(false);
                intro_music->restart();
            }
        }
        mixer.clear(!new_run);
        board = {};
        boost = 0;
        performance.reset();
        predicting_air = false;
        predicted_flight = 0;
        family = -1;
        for (auto& s : sounds) {
            s.enabled = false;
            s.debounce = 0;
        }
        for (auto& e : emitters) {
            e.voice = 0;
            e.inside = false;
        }
        if (!new_run)
            return;
        environment_voice = 0;
        environment_fade = race_fade = 0;
        race_wanted = false;
        mixer.music_mix(0, 0, true);
        choose_song();
        stats.music_node = -1;
        music_ready = pending_ready = false;
        music_start_pending = true;
        pending_event.reset();
        music_reroute = false;
        ++music_revision;
    }
};

AudioScene::AudioScene(const std::filesystem::path& root) : data_(std::make_unique<Data>(root)) {}

AudioScene::~AudioScene() = default;

AudioMixer& AudioScene::mixer() { return data_->mixer; }

void AudioScene::listener(AudioListener value) {
    std::lock_guard lock(data_->mutex);
    data_->listener = value;
    data_->mixer.listener(value);
}

void AudioScene::service() {
    std::lock_guard service_lock(data_->service_mutex);
    std::unique_lock lock(data_->mutex);
    data_->music_service(lock);
    lock.unlock();
    if (data_->authored_music)
        data_->authored_music->service();
    if (data_->intro_music)
        data_->intro_music->service();
}

void AudioScene::music_level(unsigned level) {
    if (level > 127)
        throw std::runtime_error("Music path level exceeds 127");
    std::lock_guard lock(data_->mutex);
    data_->level = level;
    data_->music_reroute = true;
    ++data_->music_revision;
}

void AudioScene::music_event(unsigned event) {
    std::lock_guard lock(data_->mutex);
    data_->pending_event = event;
    data_->music_reroute = true;
    ++data_->music_revision;
}

void AudioScene::restart() {
    std::lock_guard lock(data_->mutex);
    data_->reset();
}

void AudioScene::music_enabled(bool value) {
    std::lock_guard lock(data_->mutex);
    data_->music_on = value;
}

void AudioScene::music_song(const std::string& selection) {
    std::lock_guard lock(data_->mutex);
    if (selection == data_->song_selection)
        return;
    data_->song_selection = selection;
    data_->choose_song();
    data_->mixer.stop(data_->music_voice);
    data_->music_voice = 0;
    data_->music_ready = data_->pending_ready = false;
    data_->music_start_pending = true;
    ++data_->music_revision;
}

MusicStatus AudioScene::music_status() const {
    std::lock_guard lock(data_->mutex);
    const auto& d = *data_;
    return {d.music_on,
            bool(d.authored_music),
            d.song_selection,
            d.authored_music ? "track" : d.playlist.empty() ? "" : d.playlist[d.song % d.playlist.size()],
            d.playlist,
            d.race_fade,
            d.environment_fade};
}

AudioStats AudioScene::stats() const {
    std::lock_guard lock(data_->mutex);
    auto result = data_->stats;
    result.streamed_bytes = (data_->authored_music ? data_->authored_music->bytes() : 0) +
                            (data_->intro_music ? data_->intro_music->bytes() : 0);
    return result;
}

void AudioScene::play_course(unsigned number, Vec3 position, double gain) {
    std::lock_guard lock(data_->mutex);
    data_->one_shot(data_->slot(2, number), position, gain, true);
}

void AudioScene::tick(const Player& player, const Rider& before) {
    std::lock_guard lock(data_->mutex);
    auto& d = *data_;
    const auto& rider = player.rider();
    const auto dt = player.contract().tick_seconds();
    if (d.serial && d.serial != player.audio_reset_serial())
        d.reset(d.run_serial != player.run_serial());
    d.serial = player.audio_reset_serial();
    d.run_serial = player.run_serial();
    const auto bed_target = d.music_on && player.on_foot() ? 1. : 0.;
    const auto race_target = d.music_on && !player.on_foot() && (d.authored_music || !d.playlist.empty()) ? 1. : 0.;
    const auto fade_step = dt / music_mix().fade;
    d.race_fade += std::clamp(race_target - d.race_fade, -fade_step, fade_step);
    d.race_wanted = d.race_fade > 0;
    if (d.authored_music)
        d.authored_music->playing(d.race_wanted);
    if (d.intro_music)
        d.intro_music->playing(d.environment_fade > 0 || bed_target > 0);
    if (!d.race_wanted && d.music_voice) {
        d.mixer.stop(d.music_voice);
        d.music_voice = 0;
        d.music_ready = d.pending_ready = false;
        d.music_start_pending = true;
        d.stats.music_node = -1;
    }
    d.environment_fade += std::clamp(bed_target - d.environment_fade, -fade_step, fade_step);
    d.mixer.music_mix(d.race_fade, d.environment_fade);
    if (!d.environment_clip.empty()) {
        VoiceParams params;
        params.role = AudioRole::Ambience;
        params.gain = d.environment_gain;
        params.loop = true;
        params.sustain_only = true;
        if (params.gain > 0 && d.environment_fade > 0) {
            if (!d.mixer.update(d.environment_voice, params))
                if (auto clip = d.clip(d.environment_clip))
                    d.environment_voice = d.mixer.play(clip, params);
        } else if (d.environment_voice) {
            d.mixer.stop(d.environment_voice);
            d.environment_voice = 0;
        }
    }
    const bool transported = player.teleports() != d.teleports;
    d.teleports = player.teleports();
    for (const auto& action : player.world_actions())
        if (action.kind == WorldActionKind::CourseSound || action.kind == WorldActionKind::MainSound) {
            if (action.value < 0 || action.value > 65535)
                continue;
            const auto main = action.kind == WorldActionKind::MainSound;
            const auto gain = main && action.rider ? (d.mix.enabled ? d.mix.volume * d.mix.cues : 0) : 1;
            d.one_shot(d.slot(main ? 0 : 2, unsigned(action.value)), action.position, gain,
                       !main && !(transported && action.rider));
            ++d.stats.transients;
        }
    for (auto& s : d.sounds)
        s.debounce = std::max(0., s.debounce - dt);
    for (const auto& e : player.contacts())
        if (e.phase != ContactPhase::End && e.contact.instance < d.sounds.size()) {
            auto& s = d.sounds[e.contact.instance];
            s.enabled = true;
            const auto speed = std::max(0., -dot(before.velocity, e.contact.normal));
            const auto event = d.events.find(s.event);
            const auto name = !s.clip.empty() ? s.clip : event != d.events.end() ? event->second : std::string{};
            if (s.debounce <= 0 && speed > .05 && !name.empty() && length(s.position - d.listener.position) < 100) {
                d.one_shot(d.clip(name), s.position, std::min(1., speed / 20), true);
                s.debounce = .8;
                ++d.stats.contacts;
            }
        }
    for (auto& e : d.emitters) {
        const auto& s = d.sounds[e.instance];
        const bool hit_gate = e.event == 16 || e.event == 28 || e.event == 57;
        const auto source = s.position + e.offset, delta = d.listener.position - source;
        const auto distance = length(delta);
        double normalized_distance = distance / e.radius, gain = 0;
        if (e.type == 1) {
            if (e.extents.y <= 0 || e.extents.z <= 0)
                continue;
            const auto z = normalized(e.axis), x = normalized(cross({0, 1, 0}, z), {1, 0, 0}),
                       y = normalized(cross(z, x));
            normalized_distance =
                length({dot(delta, x) / e.extents.x, dot(delta, y) / e.extents.y, dot(delta, z) / e.extents.z});
        }
        if ((!hit_gate || s.enabled) && normalized_distance < 1) {
            gain = e.type == 3 ? 1 : ambient_curve(e.radial, normalized_distance);
            if (e.type == 2) {
                const auto cosine = dot(normalized(delta), e.axis);
                gain = cosine > e.cone && e.cone < 1
                           ? gain * ambient_curve(e.angular, std::acos(std::clamp(cosine, -1., 1.)) /
                                                                 std::acos(std::clamp(e.cone, -1., 1.)))
                           : 0;
            }
        }
        const auto event = d.events.find(int(e.event));
        const auto name = !e.clip.empty() ? e.clip : event != d.events.end() ? event->second : std::string{};
        if (gain > 0 && !name.empty()) {
            VoiceParams params;
            params.gain = gain;
            params.loop = e.type != 3;
            params.sustain_only = true;
            params.spatial = true;
            params.position = source;
            params.distance_falloff = false;
            if (e.type == 3) {
                if (!e.inside)
                    if (auto value = d.clip(name))
                        d.mixer.play(value, params);
            } else if (!d.mixer.update(e.voice, params)) {
                if (auto value = d.clip(name)) {
                    e.voice = d.mixer.play(value, params);
                    ++d.stats.ambient;
                }
            }
            e.inside = true;
        } else {
            if (e.voice)
                d.mixer.stop(e.voice);
            e.voice = 0;
            e.inside = false;
        }
    }
    const auto group = rider.surface >= 0 && std::size_t(rider.surface) < d.surface_groups.size()
                           ? d.surface_groups[std::size_t(rider.surface)]
                           : 0;
    const bool air = !player.on_foot() && rider.motion == Motion::Air;
    if (air && (!d.predicting_air || rider.launches != before.launches)) {
        d.predicted_flight = 480 * dt;
        auto position = rider.position, velocity = rider.velocity;
        for (unsigned i = 0; i < 480; ++i) {
            const auto next = position + velocity * dt;
            const auto terrain = player.terrain().intersect(position, next);
            const auto prop = player.world().ray(position, next, true);
            if (terrain || prop) {
                d.predicted_flight = (i + 1) * dt;
                break;
            }
            position = next;
            velocity += Vec3{-velocity.x * player.contract().value("gravity", "airHorizontalDrag"),
                             -player.contract().value("gravity", velocity.y > 0 ? "airRising" : "airFalling"),
                             -velocity.z * player.contract().value("gravity", "airHorizontalDrag")} *
                        dt;
        }
    }
    d.predicting_air = air;
    const auto f = normalized(project(rider.forward, rider.normal)), right = normalized(cross(rider.normal, f));
    const auto relative = rider.velocity - rider.ground_velocity;
    BoardAudioInput input;
    input.mounted = !player.on_foot() &&
                    (rider.motion == Motion::Ground || rider.motion == Motion::Air || rider.motion == Motion::Rail);
    input.ground = rider.motion == Motion::Ground;
    input.rail = rider.motion == Motion::Rail;
    input.launched = rider.launches != before.launches;
    input.group = group;
    input.speed = length(project(relative, rider.normal));
    input.slip = std::abs(dot(relative, right)) * 100;
    input.lean = std::abs(rider.lean) * 100;
    input.charge = rider.release_snapshot;
    input.impact = std::max(0., -dot(before.velocity - rider.ground_velocity, rider.normal));
    input.predicted_flight = d.predicted_flight;
    input.boosting = player.flight_boosting() || (input.mounted && player.board_boosting());
    input.boost_slot = player.flight_boosting() ? 120 : player.boost_sound_slot();
    const auto frame = d.performance.step(input, dt);
    const auto volume = d.mix.enabled ? d.mix.volume : 0;
    if (frame.pop && volume * d.mix.transients > 0) {
        d.one_shot(d.slot(1, group * 8 + 2), {}, *frame.pop * volume * d.mix.transients, false);
        ++d.stats.transients;
    }
    if (frame.land && volume * d.mix.transients > 0) {
        d.one_shot(d.slot(1, group * 8 + 1), {}, *frame.land * volume * d.mix.transients, false);
        ++d.stats.transients;
    }
    if (int(group) != d.family) {
        for (unsigned i = 0; i < 2; ++i) {
            d.mixer.stop(d.board[i]);
            d.board[i] = 0;
        }
        d.family = int(group);
    }
    const std::array<double, 4> trim{d.mix.glide, d.mix.carve, d.mix.transients, d.mix.cues};
    const std::array<unsigned, 4> slots{group * 8 + 4, group * 8 + 3, 52, 32};
    const auto loop = [&](std::uint64_t& voice, unsigned bank, unsigned number, BoardLayer layer, double gain,
                          bool persistent = false) {
        VoiceParams params;
        params.gain = layer.gain * gain;
        params.pitch = layer.pitch;
        params.loop = true;
        params.sustain_only = true;
        params.ramp_seconds = dt;
        if (params.gain <= 0 && !persistent) {
            d.mixer.stop(voice);
            voice = 0;
        } else if (!d.mixer.update(voice, params) && (params.gain > 0 || (input.mounted && input.ground)))
            if (auto value = d.slot(bank, number))
                voice = d.mixer.play(value, params);
    };
    for (unsigned i = 0; i < 4; ++i)
        loop(d.board[i], i == 3 ? 0 : 1, slots[i], frame.layers[i], volume * trim[i], i < 2);
    if (d.boost_slot != frame.boost_slot) {
        d.mixer.stop(d.boost);
        d.boost = 0;
        d.boost_slot = frame.boost_slot;
    }
    loop(d.boost, 0, frame.boost_slot, frame.boost, volume * d.mix.cues);
}
} // namespace openslope
