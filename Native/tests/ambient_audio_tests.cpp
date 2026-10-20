#include "openslope/audio_scene.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool value, const char* text) {
    ++checks;
    if (!value)
        throw std::runtime_error(text);
}

void write(const std::filesystem::path& file, const Json& value) {
    std::filesystem::create_directories(file.parent_path());
    std::ofstream(file) << value;
}

void tone(const std::filesystem::path& file, double frequency) {
    PcmClip clip;
    clip.rate = 8000;
    clip.samples.resize(1600);
    for (std::size_t i = 0; i < clip.samples.size(); ++i)
        clip.samples[i] = float(.15 * std::sin(2 * pi * frequency * double(i) / clip.rate));
    write_wave(file, clip);
}

Json emitter(const char* name, double distance, unsigned event = 105, unsigned type = 0, double radius = 32) {
    return {{"InstanceName", name},
            {"ModelID", 0},
            {"Location", {0, distance * 100, 0}},
            {"IncludeSound", true},
            {"Sounds",
             {{"CollisonSound", -1},
              {"ExternalSounds",
               {{{"U0", type},
                 {"SoundIndex", event},
                 {"U2", 0},
                 {"U3", 0},
                 {"U4", 0},
                 {"U5", radius * 100},
                 {"U6", 2}}}}}}};
}

void rows(const std::filesystem::path& root, const Json& instances) {
    write(root / "Instances.json", {{"Instances", instances}});
}

void tick(AudioScene& audio, const Player& player) { audio.tick(player, player.rider()); }

double magnitude(std::span<const float> stereo, double frequency) {
    double a = 0, b = 0;
    for (std::size_t i = 0; i < stereo.size() / 2; ++i) {
        const auto phase = 2 * pi * frequency * double(i) / 48000;
        const auto sample = stereo[i * 2] + stereo[i * 2 + 1];
        a += sample * std::cos(phase);
        b += sample * std::sin(phase);
    }
    return std::hypot(a, b);
}

void field(const std::filesystem::path& root, const Player& player) {
    rows(root, {emitter("z", 20, 106), emitter("a", 1)});
    AudioScene audio(root);
    audio.music_enabled(false);
    audio.ambient_limit(1);
    audio.listener({});
    tick(audio, player);
    auto active = audio.ambient_voices();
    check(active.size() == 1 && active[0].key == "a/0", "One voice keeps the louder source despite file order");
    check(audio.stats().ambient_candidates == 2 && audio.stats().ambient_active == 1,
          "Field and active voice counts distinguish candidate selection");
    std::vector<float> pcm(9600);
    audio.mixer().render(pcm);
    check(magnitude(pcm, 440) > magnitude(pcm, 880) * 20, "Real mixer PCM contains the selected source's tone");
    const auto voice = active[0].voice;
    const auto phase = audio.mixer().status(voice)->frame;
    for (unsigned i = 0; i < 60; ++i)
        tick(audio, player);
    check(audio.ambient_voices()[0].voice == voice && audio.mixer().status(voice)->frame == phase &&
              audio.stats().ambient == 1,
          "Stable membership preserves voice identity and playback cursor");
    audio.listener({{0, 0, -29}});
    tick(audio, player);
    active = audio.ambient_voices();
    check(active.size() == 1 && active[0].key == "z/0" && !audio.mixer().status(voice),
          "Moving listener replaces the old voice with the newly louder source");
    audio.mixer().render(pcm);
    check(magnitude(pcm, 880) > magnitude(pcm, 440) * 20, "Selection changes reach captured PCM");
    audio.ambient_limit(0);
    tick(audio, player);
    check(audio.ambient_voices().empty() && audio.mixer().voices() == 0, "Zero budget retires ambient voices");
    audio.ambient_limit(2);
    tick(audio, player);
    check(audio.ambient_voices().size() == 2, "Increasing the budget admits both continuous emitters");
    audio.listener({{0, 0, 100}});
    tick(audio, player);
    check(audio.mixer().voices() == 0, "Leaving both regions retires their maintained voices");
    bool rejected = false;
    try {
        audio.ambient_limit(97);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    check(rejected, "Ambient budget cannot consume the complete shared mixer");
}

void explicit_route(const std::filesystem::path& root, const Player& player) {
    auto row = emitter("adapted", 1, 57);
    auto& source = row["Sounds"]["ExternalSounds"][0];
    source["SoundBank"] = "tone";
    source["SoundSlot"] = 0;
    source["Activation"] = "Proximity";
    rows(root, Json::array({row}));
    AudioScene audio(root);
    audio.music_enabled(false);
    audio.listener({});
    tick(audio, player);
    check(audio.ambient_voices().size() == 1, "Explicit common route bypasses unrelated legacy event hit gate");
    std::vector<float> pcm(9600);
    audio.mixer().render(pcm);
    check(magnitude(pcm, 440) > magnitude(pcm, 880) * 20, "Named route reaches the real mixer");
    source["SoundBank"] = "../escape";
    rows(root, Json::array({row}));
    AudioScene malformed(root);
    malformed.music_enabled(false);
    malformed.listener({});
    tick(malformed, player);
    check(malformed.ambient_voices().empty(), "Invalid explicit route stays silent without event fallback");
}

void legacy_rail(const std::filesystem::path& root, const Player& player) {
    std::ifstream input(root / "Audio/SoundIndex.json");
    auto index = Json::parse(input);
    index["Banks"]["1"] = "openslope_board";
    index["NamedBanks"]["BOARD"] = "metal";
    write(root / "Audio/SoundIndex.json", index);
    std::filesystem::create_directories(root / "Audio/SFX/openslope_board");
    std::filesystem::create_directories(root / "Audio/SFX/metal");
    tone(root / "Audio/SFX/openslope_board/052.wav", 440);
    tone(root / "Audio/SFX/metal/035.wav", 880);
    tone(root / "Audio/SFX/metal/035.loop.wav", 880);
    auto row = emitter("rail-probe", 1, 57);
    auto& sound = row["Sounds"]["ExternalSounds"][0];
    sound["SoundBank"] = "openslope_board";
    sound["SoundSlot"] = 52;
    sound["Activation"] = "Proximity";
    rows(root, Json::array({row}));
    AudioScene audio(root);
    audio.music_enabled(false);
    tick(audio, player);
    std::vector<float> pcm(9600);
    audio.mixer().render(pcm);
    check(magnitude(pcm, 880) > magnitude(pcm, 440) * 20,
          "Existing adapted rail slots load their map's sustained metal source, not the short clank");
}

void ties(const std::filesystem::path& root, const Player& player) {
    for (bool reverse : {false, true}) {
        const auto a = emitter("a", 10), z = emitter("z", 10, 106);
        rows(root, reverse ? Json::array({a, z}) : Json::array({z, a}));
        AudioScene audio(root);
        audio.music_enabled(false);
        audio.ambient_limit(1);
        tick(audio, player);
        check(audio.ambient_voices().size() == 1 && audio.ambient_voices()[0].key == "a/0",
              "Equal gain ties use stable source identity in either document order");
    }
    rows(root, {emitter("bad", 0, 105, 0, 0), emitter("good", 10)});
    AudioScene inert(root);
    inert.music_enabled(false);
    inert.ambient_limit(1);
    tick(inert, player);
    check(inert.ambient_voices().size() == 1 && inert.ambient_voices()[0].key == "good/0",
          "A zero-radius record is inert rather than occupying the field or rejecting the map");
    rows(root, {emitter("missing", 0, 107), emitter("available", 10)});
    AudioScene available(root);
    available.music_enabled(false);
    available.ambient_limit(1);
    tick(available, player);
    check(available.ambient_voices().size() == 1 && available.ambient_voices()[0].key == "available/0",
          "Unavailable media does not reserve an otherwise audible voice slot");
}

void one_entry(const std::filesystem::path& root, const Player& player) {
    rows(root, Json::array({emitter("entry", 1, 105, 3)}));
    AudioScene audio(root);
    audio.music_enabled(false);
    tick(audio, player);
    check(audio.ambient_voices().size() == 1, "One-entry source starts on its first physical entry");
    std::vector<float> pcm(28800);
    audio.mixer().render(pcm);
    tick(audio, player);
    check(audio.ambient_voices().empty(), "A completed one-entry clip does not restart while inside");
    audio.ambient_limit(0);
    tick(audio, player);
    audio.ambient_limit(1);
    tick(audio, player);
    check(audio.ambient_voices().empty(), "Budget changes do not invent another physical entry");
    audio.listener({{0, 0, 100}});
    tick(audio, player);
    audio.listener({});
    tick(audio, player);
    check(audio.ambient_voices().size() == 1, "A real exit and reentry rearms the one-entry source");
    audio.ambient_limit(0);
    tick(audio, player);
    check(audio.mixer().voices() == 0, "Zero budget also owns and retires a non-maintained voice");
}

void shapes(const std::filesystem::path& root, const Player& player) {
    auto ellipsoid = emitter("long", 0, 105, 1, 10);
    auto& shape = ellipsoid["Sounds"]["ExternalSounds"][0];
    shape.update({{"U6", 2000}, {"U7", 3000}, {"U8", 0}, {"U9", -1}, {"U10", 0}, {"U11", 2}});
    rows(root, Json::array({ellipsoid}));
    AudioScene oval(root);
    oval.music_enabled(false);
    oval.listener({{0, 0, 15}});
    tick(oval, player);
    const auto heard = oval.ambient_voices();
    check(heard.size() == 1 && std::abs(heard[0].gain - .5) < 1e-9,
          "Oriented ellipsoid selection reaches beyond the first-axis radius with its exact gain");
    auto cone = emitter("cone", 0, 105, 2);
    cone["Sounds"]["ExternalSounds"][0].update(
        {{"U6", 0}, {"U7", 1}, {"U8", 0}, {"U9", 2}, {"U10", std::cos(pi / 4)}, {"U11", 2}});
    rows(root, Json::array({cone}));
    AudioScene directional(root);
    directional.music_enabled(false);
    directional.listener({{0, 0, -16}});
    tick(directional, player);
    check(directional.ambient_voices().size() == 1 && std::abs(directional.ambient_voices()[0].gain - .5) < 1e-9,
          "Directional selection retains radial and angular gain");
    directional.listener({{16, 0, 0}});
    tick(directional, player);
    check(directional.ambient_voices().empty(), "A source outside its cone cannot occupy the voice budget");
}

void hit_gate(const std::filesystem::path& base) {
    const auto root = base / "hit";
    std::filesystem::create_directory(root);
    std::filesystem::copy(base / "Audio", root / "Audio", std::filesystem::copy_options::recursive);
    auto index = Json::parse(std::ifstream(root / "Audio/SoundIndex.json"));
    index["CollisionEvents"]["28"] = index["CollisionEvents"]["105"];
    write(root / "Audio/SoundIndex.json", index);
    auto placed = emitter("hydrant", 0, 28);
    placed.update({{"CollsionMode", 2}, {"PlayerCollision", true}, {"PlayerBounce", false}, {"U0", 0}});
    rows(root, Json::array({placed}));
    write(root / "Models.json", {{"Models",
                                  {{{"ModelObjects",
                                     {{{"ParentID", -1},
                                       {"CollisionBounds", {{"Min", {-50, -50, 0}}, {"Max", {50, 50, 200}}}},
                                       {"MeshData", Json::array()}}}}}}}});
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({u * 10000. / 3 - 5000, v * 10000. / 3 - 5000, 0});
    write(root / "Patches.json", {{"Patches",
                                   {{{"PatchName", "Hit-gated sound floor"},
                                     {"Points", points},
                                     {"SurfaceType", 1},
                                     {"TrickOnlyPatch", false},
                                     {"TexturePath", ""},
                                     {"LightmapID", -1},
                                     {"UVPoints", {{0, 0}, {0, 1}, {1, 0}, {1, 1}}},
                                     {"LightMapPoint", {0, 0, 0, 0}}}}}});
    Player player(Terrain::load(root));
    player.warp({-3, -.005, 0}, {1, 0, 0});
    AudioScene audio(root);
    audio.music_enabled(false);
    audio.ambient_limit(1);
    audio.listener({{0, 1.5, 0}});
    tick(audio, player);
    check(audio.ambient_voices().empty(), "An unhit hydrant cannot enter the ranked field");
    player.warp({0, -.005, 0}, {1, 0, 0});
    const auto before = player.rider();
    player.tick({});
    audio.tick(player, before);
    check(audio.ambient_voices().size() == 1, "Silent collision arms a hit-gated emitter before ranking");
    audio.ambient_limit(0);
    tick(audio, player);
    audio.ambient_limit(1);
    tick(audio, player);
    check(audio.ambient_voices().size() == 1, "Budget eviction cannot forget an emitter's hit arming");
    player.warp({-3, -.005, 0}, {1, 0, 0});
    audio.restart();
    tick(audio, player);
    check(audio.ambient_voices().empty(), "Run restart clears the hit gate and its selected voice");
}

void dense(const std::filesystem::path& root, const Player& player) {
    Json list = Json::array();
    for (unsigned i = 0; i < 40; ++i)
        list.push_back(emitter(("source-" + std::to_string(i)).c_str(), 1));
    rows(root, list);
    AudioScene audio(root);
    audio.music_enabled(false);
    tick(audio, player);
    check(audio.ambient_voices().size() == 32 && audio.mixer().voices() == 32,
          "Dense ambience respects the default application budget");
    audio.play_course(0, {}, 1);
    check(audio.mixer().voices() == 33 && audio.ambient_voices().size() == 32,
          "A dense ambient field leaves mixer capacity for an independent course cue");
}
} // namespace

int main() {
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-ambient-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));

    struct Cleanup {
        std::filesystem::path p;

        ~Cleanup() {
            std::error_code e;
            std::filesystem::remove_all(p, e);
        }
    } cleanup{root};

    try {
        std::filesystem::create_directories(root / "Audio/SFX/tone");
        tone(root / "Audio/SFX/tone/000.wav", 440);
        tone(root / "Audio/SFX/tone/001.wav", 880);
        Json events;
        for (unsigned i = 0; i < 3; ++i)
            events[std::to_string(105 + i)] = {{"Group", 2},
                                               {"Slot", i == 2 ? 99 : i},
                                               {"Bank", "tone"},
                                               {"Clip", i == 2   ? "Audio/SFX/tone/099.wav"
                                                        : i == 0 ? "Audio/SFX/tone/000.wav"
                                                                 : "Audio/SFX/tone/001.wav"}};
        write(root / "Audio/SoundIndex.json",
              {{"Schema", "openslope-sound-index/v1"}, {"Banks", {{"2", "tone"}}}, {"CollisionEvents", events}});
        write(root / "Audio/BoardMix.json",
              {{"schema", "openslope-board-mix/v1"}, {"boardSound", {{"enabled", false}}}});
        Player player(Terrain::demo());
        player.start_on_foot();
        field(root, player);
        explicit_route(root, player);
        ties(root, player);
        one_entry(root, player);
        shapes(root, player);
        hit_gate(root);
        dense(root, player);
        legacy_rail(root, player);
        std::cout << "PASS: " << checks << " ambient field, identity, budget, entry and real PCM checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
