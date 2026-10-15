#include "openslope/audio_scene.hpp"
#include "openslope/audio_program.hpp"
#include "openslope/board_audio.hpp"
#include "openslope/import.hpp"
#include "openslope/music.hpp"
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <nlohmann/json.hpp>
#include <set>

namespace openslope {
namespace {
using Json = nlohmann::json;

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
    BoardMix mix;
    BoardAudio performance;
    std::vector<unsigned> surface_groups;

    struct Sound {
        int event = -1;
        Vec3 position;
        bool enabled = false;
        double debounce = 0;
    };

    std::vector<Sound> sounds;

    struct Emitter {
        std::size_t instance{};
        unsigned type{}, event{}, radial{}, angular{};
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
    MusicGraph graph;
    MusicCursor cursor, pending_cursor;
    std::uint64_t music_voice{}, music_generation{};
    double music_gain = .5;
    unsigned level = 80;
    std::optional<unsigned> pending_event;
    bool music_ready = false, pending_ready = false, music_start_pending = true;
    std::uint64_t music_revision = 0;
    std::uint64_t queued_revision = 0;
    bool music_reroute = false;
    std::uint64_t serial = 0, teleports = 0;

    explicit Data(std::filesystem::path folder) : root(std::move(folder)) {
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
        auto board_path = root / "Audio/BoardSoundIndex.json";
        if (!std::filesystem::exists(board_path))
            board_path = root.parent_path() / "Shared/Audio/BoardSoundIndex.json";
        if (std::filesystem::exists(board_path)) {
            const auto index = read(board_path);
            if (index.value("Schema", "") == "openslope-board-sound-index/v1") {
                surface_groups = index.at("SurfaceGroups").get<std::vector<unsigned>>();
                if (surface_groups.size() > 256 ||
                    std::any_of(surface_groups.begin(), surface_groups.end(), [](auto x) { return x > 9; }))
                    throw std::runtime_error("Invalid board surface groups");
            }
        }
        if (std::filesystem::exists(root / "Audio/BoardMix.json")) {
            const auto doc = read(asset(root, "Audio/BoardMix.json"));
            if (doc.value("schema", "") == "openslope-board-mix/v1") {
                const auto& value = doc.at("boardSound");
                mix.enabled = value.value("enabled", true);
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
                if (sound.contains("ExternalSounds"))
                    for (const auto& source : sound.at("ExternalSounds")) {
                        Emitter e;
                        e.instance = i;
                        e.type = source.at("U0");
                        e.event = source.at("SoundIndex");
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
        prewarm();
        std::unique_lock lock(mutex);
        start_music(lock);
    }

    // Only course opening and the serialized music service may load files.
    std::shared_ptr<PcmClip> load_clip(const std::string& name, bool resident = false,
                                       std::unique_lock<std::mutex>* state_lock = nullptr) {
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
            const auto path = asset(root, name);
            if (std::filesystem::exists(path)) {
                value = std::make_shared<PcmClip>(PcmClip::load(path));
                if (resident) {
                    auto loop_path = path;
                    loop_path.replace_filename(path.stem().string() + ".loop.wav");
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
        const auto bytes = value->samples.size() * sizeof(float);
        const auto budget = std::size_t(resident ? 96 : 128) * 1024 * 1024;
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
        const auto found = clips.find(name);
        return found == clips.end() ? nullptr : found->second.clip;
    }

    void prewarm() {
        std::set<std::string> names;
        for (const auto& [group, bank] : banks) {
            const auto path = asset(root, "Audio/SFX/" + bank);
            if (!std::filesystem::is_directory(path))
                continue;
            for (const auto& entry : std::filesystem::directory_iterator(path)) {
                const auto stem = entry.path().stem().string();
                if (entry.path().extension() == ".wav" && !stem.empty() && stem.size() <= 5 &&
                    std::all_of(stem.begin(), stem.end(), [](unsigned char c) { return c >= '0' && c <= '9'; }))
                    names.insert("Audio/SFX/" + bank + "/" + entry.path().filename().string());
                if (names.size() > 4096)
                    throw std::runtime_error("Too many course audio clips");
            }
        }
        for (const auto& [event, name] : events)
            names.insert(name);
        if (names.size() > 4096)
            throw std::runtime_error("Too many course audio clips");
        for (const auto& name : names)
            load_clip(name, true);
    }

    std::shared_ptr<PcmClip> slot(unsigned group, unsigned number) {
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
            Json json;
            try {
                const auto folder = asset(root, "Audio/Music/" + name);
                loaded_graph = MusicGraph::load(folder / "graph.json");
                json = read(folder / "graph.json");
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
            music_gain = json.value("Volume", .5);
            if (!std::isfinite(music_gain) || music_gain < 0 || music_gain > 1)
                throw std::runtime_error("Invalid music volume");
            auto value = load_clip("Audio/Music/" + name + "/" + graph.samples[std::size_t(sample)].wav, false, &lock);
            if (revision != music_revision) {
                music_start_pending = true;
                return;
            }
            if (!value)
                return;
            music_voice = mixer.play(value, {music_gain * cursor.action_volume});
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
        if (!mixer.queue(music_voice, value, {music_gain * next_cursor.action_volume}, status->generation)) {
            music_reroute = true;
            return;
        }
        pending_cursor = next_cursor;
        queued_revision = revision;
        pending_ready = true;
    }

    void music_service(std::unique_lock<std::mutex>& lock) {
        try {
            music_service_unchecked(lock);
        } catch (const std::exception& e) {
            music_ready = false;
            mixer.queue(music_voice, {});
            std::cerr << "Music scheduler stopped: " << e.what() << '\n';
        }
    }

    void reset() {
        mixer.clear();
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
        ++song;
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

AudioStats AudioScene::stats() const {
    std::lock_guard lock(data_->mutex);
    return data_->stats;
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
        d.reset();
    d.serial = player.audio_reset_serial();
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
            if (s.debounce <= 0 && speed > .05 && event != d.events.end() &&
                length(s.position - d.listener.position) < 100) {
                d.one_shot(d.clip(event->second), s.position, std::min(1., speed / 20), true);
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
        if (gain > 0 && event != d.events.end()) {
            VoiceParams params;
            params.gain = gain;
            params.loop = e.type != 3;
            params.sustain_only = true;
            params.spatial = true;
            params.position = source;
            params.distance_falloff = false;
            if (e.type == 3) {
                if (!e.inside)
                    if (auto value = d.clip(event->second))
                        d.mixer.play(value, params);
            } else if (!d.mixer.update(e.voice, params)) {
                if (auto value = d.clip(event->second)) {
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
