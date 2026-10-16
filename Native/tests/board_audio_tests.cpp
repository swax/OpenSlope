#include "openslope/audio_scene.hpp"
#include "openslope/board_audio.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;
constexpr double dt = 1. / 60;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void near(double actual, double expected, const char* message) { check(std::abs(actual - expected) < 1e-9, message); }

void performance() {
    const auto firm = board_bed(0, 150, 25, .75);
    near(firm.glide, .421875, "firm mixed slip/lean and smooth speed envelope");
    near(firm.carve_bend, .225, "carve bend combines independently measured slip/lean weights");
    const auto soft = board_bed(1, 300, 0, 1);
    near(soft.glide, .35, "powder retains soft glide under full skid");
    near(soft.carve, .7, "soft carve ceiling");
    const auto hard = board_bed(5, 75, 50, 1);
    near(hard.glide, .35625, "hard surface gain follows slip while handoff follows the stronger input");
    near(hard.carve, .273125, "hard surface carve response");
    near(board_bed(8, -1, -1, 1).glide, .3, "input clamps retain hard surface idle character");
    near(board_bed(2, 500, 500, 0).glide, 0, "speed envelope closes even a hard turn");
    BoardAudio bed;
    BoardAudioInput input;
    input.ground = true;
    input.speed = 18;
    auto frame = bed.step(input, dt);
    near(frame.layers[0].gain, 1. / 3, "responsive 20/s ground attack");
    for (unsigned i = 0; i < 30; ++i)
        frame = bed.step(input, dt);
    near(frame.layers[0].gain, 1, "clean glide settles at full target");
    near(frame.layers[1].gain, 0, "clean packed snow has no scrape");
    input.slip = 300;
    for (unsigned i = 0; i < 30; ++i)
        frame = bed.step(input, dt);
    near(frame.layers[0].gain, 0, "full skid closes packed glide");
    near(frame.layers[1].gain, 1, "full skid opens carve");
    near(frame.layers[0].pitch, 1.35, "skid bends glide independently of speed");
    input.rail = true;
    input.speed = 14;
    for (unsigned i = 0; i < 30; ++i)
        frame = bed.step(input, dt);
    near(frame.layers[2].gain, .5303030303030303, "rail uses linear speed and its own 0.7 trim");
    near(frame.layers[0].gain + frame.layers[1].gain, 0, "rail replaces terrain bed");
    check(!frame.land, "rail attachment is not a snow landing");
    input.rail = input.ground = false;
    input.predicted_flight = 1.5;
    frame = bed.step(input, dt);
    near(frame.layers[3].gain, 0, "wind threshold is strictly greater than 1.5 seconds");
    check(!frame.pop, "rolling off a ledge does not pop");
    input.launched = true;
    input.charge = .8;
    input.predicted_flight = 2.2;
    frame = bed.step(input, dt);
    near(*frame.pop, .9, "ollie level follows launch charge");
    input.launched = false;
    for (unsigned i = 0; i < 5; ++i)
        frame = bed.step(input, dt);
    check(!frame.pop, "sustained flight does not repeat pop");
    near(frame.layers[3].gain, .7, "big-air wind target");
    input.rail = true;
    input.impact = 18;
    frame = bed.step(input, dt);
    check(!frame.land, "hard air-to-rail catch has no snow thud");
    input.rail = false;
    bed.step(input, dt);
    input.ground = true;
    input.impact = .9;
    frame = bed.step(input, dt);
    check(!frame.land, "soft touchdown is silent at the threshold");
    input.ground = false;
    bed.step(input, dt);
    input.ground = true;
    input.impact = 6;
    frame = bed.step(input, dt);
    near(*frame.land, .5, "landing level uses pre-contact impact speed");
    check(!bed.step(input, dt).land, "a touchdown fires once");
    input.mounted = false;
    input.boosting = true;
    input.boost_slot = 121;
    for (unsigned i = 0; i < 18; ++i)
        frame = bed.step(input, dt);
    near(frame.boost.gain, .9, "applied Superman boost gets punch envelope");
    check(frame.boost_slot == 121, "engage captures meter-selected slot");
    input.boost_slot = 122;
    for (unsigned i = 0; i < 72; ++i)
        frame = bed.step(input, dt);
    check(frame.boost_slot == 121, "held boost does not change clip as its meter drains");
    near(frame.boost.gain, .45, "held boost decays to half after 0.6 seconds");
    for (auto layer : frame.layers)
        near(layer.gain, 0, "off-board flight silences board layers");
    input.boosting = false;
    frame = bed.step(input, dt);
    near(frame.boost.gain, .45 - 2.5 * dt, "boost releases at 2.5/s");
    for (unsigned i = 0; i < 18; ++i)
        frame = bed.step(input, dt);
    near(frame.boost.gain, 0, "boost release reaches silence");
    bed.reset();
    input.ground = input.mounted = true;
    frame = bed.step(input, dt);
    check(!frame.land, "reset on the snow is not a landing");
}

void warm_cache() {
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-board-cache-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));

    struct Cleanup {
        std::filesystem::path root;

        ~Cleanup() { std::filesystem::remove_all(root); }
    } cleanup{root};

    std::filesystem::create_directories(root / "Audio/SFX/test");
    std::ofstream(root / "Audio/SoundIndex.json") << Json{
        {"Schema", "openslope-sound-index/v1"}, {"Banks", {{"2", "test"}}}, {"CollisionEvents", Json::object()}};
    PcmClip clip;
    clip.samples.assign(4800, .2f);
    write_wave(root / "Audio/SFX/test/004.wav", clip);
    PcmClip region = clip;
    region.samples.resize(2400);
    write_wave(root / "Audio/SFX/test/004.loop.wav", region);
    write_wave(root / "Audio/SFX/test/005.wav", clip);
    AudioScene scene(root);
    check(scene.stats().prewarmed == 2, "full and loop WAV share one decoded clip");
    check(scene.stats().decoded_bytes == 2 * 4800 * sizeof(float), "cache counts full clips without loop duplicates");
    std::filesystem::remove_all(root / "Audio");
    scene.listener({{}, {0, 0, -1}, {0, 1, 0}});
    for (auto slot : {4u, 5u}) {
        scene.play_course(slot, {0, 0, -1});
        std::array<float, 4000> pcm{};
        scene.mixer().render(pcm);
        check(std::any_of(pcm.begin(), pcm.end(), [](float v) { return v > .05f; }),
              "first event plays from prewarm after source files are gone");
        scene.restart();
        scene.service();
    }
}

void library_cache() {
    const auto base =
        std::filesystem::temp_directory_path() /
        ("openslope-library-cache-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));

    struct Cleanup {
        std::filesystem::path root;

        ~Cleanup() { std::filesystem::remove_all(root); }
    } cleanup{base};

    const auto root = base / "Custom", shared = base / "Shared", donor = base / "Older";
    std::filesystem::create_directories(root);
    std::ofstream(root / "Patches.json") << "{}";
    std::filesystem::create_directories(shared / "Audio/SFX/ZBOARD");
    PcmClip pcm;
    pcm.samples.assign(4800, .2f);
    write_wave(shared / "Audio/SFX/ZBOARD/004.WAV", pcm);
    write_wave(shared / "Audio/SFX/ZBOARD/004.loop.wav", pcm);
    {
        AudioScene scene(root);
        check(scene.stats().prewarmed == 1, "map without Audio finds a case-insensitive shared board bank");
    }
    {
        struct RestoreDirectory {
            std::filesystem::path previous = std::filesystem::current_path();

            ~RestoreDirectory() { std::filesystem::current_path(previous); }
        } restore_directory;

        // Runner checkouts and temporary fixtures can live on different Windows volumes.
        std::filesystem::current_path(base);
        AudioScene scene(std::filesystem::relative(root));
        check(scene.stats().prewarmed == 1, "relative map paths retain the same shared source containment");
    }
    std::filesystem::create_directories(donor / "Audio/SFX/zboard");
    std::ofstream(donor / "Patches.json") << "{}";
    write_wave(donor / "Audio/SFX/zboard/012.wav", pcm);
    {
        AudioScene scene(root);
        check(scene.stats().prewarmed == 2, "older per-course common banks fill missing shared slots");
    }
    std::filesystem::create_directories(root / "Audio");
    std::ofstream(root / "Audio/SoundIndex.json") << Json{{"Schema", "openslope-sound-index/v1"},
                                                          {"Banks", {{"1", "private-board"}}},
                                                          {"CollisionEvents", Json::object()}};
    {
        AudioScene scene(root);
        check(scene.stats().prewarmed == 0, "explicit custom bank never borrows unrelated common audio");
    }
    std::filesystem::create_directories(root / "Sounds");
    write_wave(root / "Sounds/custom.wav", pcm);
    std::ofstream(root / "Effects.json") << Json{
        {"extensions", {{"slopesmith", {{"customSounds", {{"98", "custom.wav"}}}}}}}};
    AudioScene scene(root);
    check(scene.stats().prewarmed == 1, "authored effect slot is prewarmed without local bank routing");
    std::filesystem::remove_all(root / "Sounds");
    scene.play_course(98, {0, 0, -1});
    std::array<float, 4000> rendered{};
    scene.mixer().render(rendered);
    check(std::any_of(rendered.begin(), rendered.end(), [](float v) { return v > .05f; }),
          "authored effect plays after its file has gone");
    scene.play_course(4, {0, 0, -1});
    check(scene.mixer().voices() == 1, "common banks do not become a course bank");
    std::ofstream(root / "Effects.json") << Json{
        {"extensions", {{"slopesmith", {{"customSounds", {{"98", "../escape.wav"}}}}}}}};
    bool rejected = false;
    try {
        AudioScene unsafe(root);
    } catch (const std::exception&) {
        rejected = true;
    }
    check(rejected, "authored filenames cannot escape Sounds");
    std::filesystem::remove(root / "Effects.json");
    std::filesystem::remove(root / "Audio/SoundIndex.json");
    for (unsigned i = 0; i < 257; ++i) {
        const auto extra = base / ("Map" + std::to_string(i));
        std::filesystem::create_directory(extra);
        std::ofstream(extra / "Patches.json") << "{}";
    }
    {
        AudioScene bounded(root);
        check(bounded.stats().prewarmed == 1, "oversized sibling libraries preserve local and Shared audio");
    }
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc == 2 && std::string(argv[1]) == "--bed") {
            Json rows;
            std::cin >> rows;
            Json output = Json::array();
            for (const auto& r : rows) {
                const auto b = board_bed(r[0], r[1], r[2], r[3]);
                output.push_back({b.glide, b.glide_bend, b.carve, b.carve_bend});
            }
            std::cout << output;
            return 0;
        }
        performance();
        warm_cache();
        library_cache();
        std::cout << "PASS: " << checks << " board performance, rail, pop, landing, flight/boost and prewarm checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
