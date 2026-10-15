#include "openslope/audio_scene.hpp"
#include "openslope/music.hpp"
#include "openslope/music_stream.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <thread>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void near(double value, double expected, double tolerance, const char* message) {
    check(std::abs(value - expected) <= tolerance, message);
}

void write(const std::filesystem::path& path, const Json& value) {
    std::filesystem::create_directories(path.parent_path());
    std::ofstream(path) << value;
}

PcmClip tone(unsigned rate = 8000, double seconds = 1, double frequency = 440) {
    PcmClip clip;
    clip.rate = rate;
    clip.samples.resize(std::size_t(std::round(seconds * rate)));
    for (std::size_t i = 0; i < clip.frames(); ++i)
        clip.samples[i] = float(.25 * std::sin(2 * pi * frequency * double(i) / rate));
    return clip;
}

void wave(const std::filesystem::path& path, const PcmClip& clip) {
    std::filesystem::create_directories(path.parent_path());
    write_wave(path, clip);
}

double frequency(std::span<const float> stereo) {
    unsigned crossings = 0;
    for (std::size_t i = 2; i < stereo.size(); i += 2)
        if (stereo[i - 2] <= 0 && stereo[i] > 0)
            ++crossings;
    return double(crossings) / (double(stereo.size() / 2) / 48000);
}

double rms(std::span<const float> data) {
    double sum = 0;
    for (auto v : data)
        sum += double(v) * v;
    return std::sqrt(sum / double(data.size()));
}

Terrain floor() {
    Patch patch;
    patch.surface = 1;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            patch.points[u * 4 + v] = {double(u) * 400 / 3 - 200, 0, double(v) * 400 / 3 - 200};
    return Terrain({patch});
}

void wave_ranges(const std::filesystem::path& root) {
    const auto path = root / "source.wav";
    wave(path, tone(22050, 1.5));
    WaveReader source(path);
    const auto full = PcmClip::load(path), partial = source.read(117, 1000);
    check(source.rate() == 22050 && source.channels() == 1 && source.frames() == full.frames(),
          "stream reader retains WAV format and extent");
    check(std::equal(partial.samples.begin(), partial.samples.end(), full.samples.begin() + 117),
          "bounded ranges reproduce full decode samples exactly");
    bool rejected = false;
    try {
        source.read(source.frames(), 1);
    } catch (...) {
        rejected = true;
    }
    check(rejected, "frame ranges cannot read beyond data");
    const auto large = root / "large.wav";
    constexpr std::uint32_t size = 96 * 1024 * 1024;
    {
        std::ofstream file(large, std::ios::binary);
        const auto le = [&](std::uint32_t n, unsigned bytes) {
            for (unsigned i = 0; i < bytes; ++i)
                file.put(char(n >> (i * 8)));
        };
        file.write("RIFF", 4);
        le(size - 8, 4);
        file.write("WAVEfmt ", 8);
        le(16, 4);
        le(1, 2);
        le(1, 2);
        le(8000, 4);
        le(16000, 4);
        le(2, 2);
        le(16, 2);
        file.write("data", 4);
        le(size - 44, 4);
        file.seekp(size - 1);
        file.put(char(0));
    }
    WaveReader long_song(large);
    check(long_song.frames() == (size - 44) / 2 && long_song.read(long_song.frames() - 16, 16).samples.size() == 16,
          "96 MiB master is seekable without decoding it all");
    rejected = false;
    try {
        PcmClip::load(large);
    } catch (...) {
        rejected = true;
    }
    check(rejected, "one-shot loader keeps its original full-file bound");
    AudioMixer mixer;
    mixer.music_mix(1, 0, true);
    MusicStream music(mixer, {large}, AudioRole::RaceMusic, true);
    music.playing(true);
    music.service();
    check(music.bytes() <= 384000 && mixer.voices() == 1,
          "long master transport queues only two half-second output blocks");
}

void stream_loops(const std::filesystem::path& root) {
    auto source = tone(8000, 2, 220);
    for (std::size_t i = 4000; i < source.frames(); ++i) {
        const auto hz = i < 8000 ? 660. : 1100.;
        source.samples[i] = float(.25 * std::sin(2 * pi * hz * double(i) / source.rate));
    }
    const auto path = root / "arranged.wav";
    wave(path, source);
    AudioMixer mixer;
    mixer.music_mix(1, 0, true);
    MusicStream music(mixer, {path}, AudioRole::RaceMusic, true, .5, 1);
    music.playing(true);
    std::vector<float> rendered;
    for (unsigned i = 0; i < 150; ++i) {
        music.service();
        std::array<float, 1600> block{};
        mixer.render(block);
        rendered.insert(rendered.end(), block.begin(), block.end());
    }
    near(frequency(std::span(rendered).subspan(48000 * 2 / 10, 48000 * 2 / 5)), 220, 5,
         "authored master begins with its attack before the loop start");
    near(frequency(std::span(rendered).subspan(48000 * 2 * 2, 48000)), 660, 5,
         "loop end wraps to the authored start and excludes the tail");
    check(music.bytes() <= 384000, "stream memory stays bounded after repeated wraps");
    music.playing(false);
    music.service();
    check(mixer.voices() == 0 && music.bytes() == 0,
          "completed dismount fade stops and releases active stream buffers");
    music.playing(true);
    rendered.clear();
    for (unsigned i = 0; i < 20; ++i) {
        music.service();
        std::array<float, 1600> block{};
        mixer.render(block);
        rendered.insert(rendered.end(), block.begin(), block.end());
    }
    near(frequency(std::span(rendered).subspan(9600, 19200)), 220, 5,
         "remount restarts the selected master from its beginning");
    auto one = tone(8000, 1. / 8000);
    one.samples[0] = .25f;
    const auto tiny = root / "tiny.wav";
    wave(tiny, one);
    AudioMixer small;
    small.music_mix(1, 0, true);
    MusicStream microscopic(small, {tiny}, AudioRole::RaceMusic, true);
    microscopic.playing(true);
    microscopic.service();
    std::array<float, 4800> block{};
    small.render(block);
    check(std::all_of(block.begin() + 2000, block.end(), [](float v) { return v > .24f; }),
          "single-frame loop coalesces into a continuous scheduled block");
    std::thread worker([&] {
        for (unsigned i = 0; i < 30; ++i)
            microscopic.service();
    });
    for (unsigned i = 0; i < 30; ++i) {
        microscopic.restart();
        microscopic.playing(i % 2 == 0);
        small.render(block);
    }
    worker.join();
    microscopic.playing(false);
    microscopic.service();
    check(small.voices() == 0, "concurrent restart/read control never leaves an obsolete music voice");
}

void roles() {
    AudioMixer mixer;
    auto clip = std::make_shared<PcmClip>(tone());
    VoiceParams music;
    music.role = AudioRole::RaceMusic;
    const auto song = mixer.play(clip, music), effect = mixer.play(clip);
    mixer.clear(true);
    check(mixer.status(song).has_value() && !mixer.status(effect),
          "recovery clears effects while preserving music voices");
    mixer.music_mix(0, 0, true);
    std::array<float, 1600> silent{};
    mixer.render(silent);
    check(rms(silent) == 0 && mixer.status(song)->frame > 0, "music mute is independent of transport progress");
    mixer.play(clip);
    mixer.render(silent);
    check(rms(silent) > .1, "music mute leaves effects audible");
    mixer.clear();
    check(mixer.voices() == 0, "new-run reset clears all voices");
}

void scene_lifecycle(const std::filesystem::path& root) {
    for (const auto& name : {"alpha", "beta"}) {
        const auto folder = root / "Audio/Music" / name;
        std::filesystem::create_directories(folder);
        wave(folder / "chunk.wav", tone(8000, .5, std::string(name) == "alpha" ? 220 : 880));
        MusicGraph graph;
        graph.tracks = graph.sections = 1;
        graph.nodes = {{1, 0, 0, 1, 1u << 24, {{0, 127, 0}}}};
        graph.samples = {{"chunk.wav", 0, 500}};
        graph.save(folder / "graph.json", name, 120, 1);
    }
    write(root / "Audio/Music/playlist.json", {"alpha", "beta"});
    wave(root / "Audio/SFX/Wind1/000.wav", tone(8000, 1, 110));
    write(root / "Audio/Environment.json", {{"Schema", "openslope-environment-audio/v1"},
                                            {"Bed", {{"Clip", "Audio/SFX/Wind1/000.wav"}, {"Volume", .15}}}});
    Player player(floor());
    player.warp({5, 0, 0}, {0, 0, -1});
    player.start_on_foot();
    AudioScene scene(root);
    const auto advance = [&](unsigned ticks) {
        std::vector<float> all;
        for (unsigned i = 0; i < ticks; ++i) {
            const auto before = player.rider();
            player.tick({});
            scene.tick(player, before);
            scene.service();
            std::array<float, 800> pcm{};
            scene.mixer().render(pcm);
            all.insert(all.end(), pcm.begin(), pcm.end());
        }
        return all;
    };
    const auto initial = scene.music_status().song;
    auto pcm = advance(240);
    check(scene.music_status().race == 0 && scene.music_status().ambience > .99,
          "off-board state opens only the declared environment layer");
    near(frequency(std::span(pcm).last(48000)), 110, 4, "off-board environment is audible without race music");
    {
        RideInput mount;
        mount.mount = true;
        player.advance(1. / 120, mount);
        player.advance(1. / 120, {});
    }
    pcm = advance(240);
    check(scene.music_status().race > .99 && scene.music_status().ambience == 0,
          "mount crosses to race music over 1.5 seconds");
    near(frequency(std::span(pcm).last(48000)), initial == "alpha" ? 220 : 880, 4,
         "run-selected graph plays on the board");
    near(rms(std::span(pcm).last(48000)), .25 * .42 / std::sqrt(2.), .004, "graph music uses the shared playback mix");
    const auto run_serial = player.run_serial();
    player.warp({8, 0, 0}, {0, 0, -1});
    advance(2);
    check(player.run_serial() == run_serial && scene.music_status().song == initial,
          "placement recovery preserves the run song choice");
    player.start_on_foot();
    advance(240);
    check(scene.music_status().song == initial && scene.music_status().race == 0,
          "dismount fades to silence without choosing another song");
    scene.music_song("beta");
    {
        RideInput mount;
        mount.mount = true;
        player.advance(1. / 120, mount);
        player.advance(1. / 120, {});
    }
    pcm = advance(240);
    near(frequency(std::span(pcm).last(48000)), 880, 4, "explicit reference song selection takes effect on remount");
    scene.music_enabled(false);
    pcm = advance(240);
    check(rms(std::span(pcm).last(16000)) == 0 && scene.music_status().song == "beta",
          "music mute preserves the chosen song and stops at the end of its fade");
    player.restart_run();
    advance(2);
    check(player.run_serial() != run_serial && scene.music_status().song == "beta",
          "new run retains an explicit song preference");
}

void intro_fallback(const std::filesystem::path& base) {
    for (unsigned variant = 0; variant < 4; ++variant) {
        const auto root = base / std::to_string(variant);
        const auto folder = root / (variant == 2 ? "Audio" : "Audio/Intro");
        wave(folder / "Course-A1.wav", tone(8000, .12, 110));
        wave(folder / "Course-B1.wav", tone(8000, .18, 550));
        wave(folder / "end.wav", tone(8000, .2, 1100));
        if (variant != 1)
            wave(folder / "Course-C1.wav", tone(8000, .14, 330));
        if (variant == 0)
            write(folder / "stems.json", Json::array({{{"Clip", "Course-A1.wav"}},
                                                      {{"Clip", "Course-B1.wav"}},
                                                      {{"Clip", "Course-C1.wav"}},
                                                      {{"Clip", "end.wav"}}}));
        if (variant == 3)
            write(root / "Audio/Environment.json", {{"Schema", "openslope-environment-audio/v1"}, {"Bed", nullptr}});
        Player player(floor());
        player.start_on_foot();
        AudioScene scene(root);
        std::vector<float> pcm;
        for (unsigned i = 0; i < 240; ++i) {
            const auto before = player.rider();
            player.tick({});
            scene.tick(player, before);
            scene.service();
            std::array<float, 800> block{};
            scene.mixer().render(block);
            pcm.insert(pcm.end(), block.begin(), block.end());
        }
        const auto tail = std::span(pcm).last(24000);
        if (variant == 3) {
            check(rms(tail) == 0, "explicit environment off suppresses the intro fallback");
        } else {
            near(frequency(tail), variant == 1 ? 110 : 330, 8,
                 "intro chooses C then A then B, with old top-level Audio support");
            near(rms(tail), .25 * .3 / std::sqrt(2.), .004, "intro uses the shared mix gain");
            check(scene.stats().streamed_bytes <= 384000, "short intro phrases share a bounded output queue");
        }
    }
}
} // namespace

int main() {
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-music-playback-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));

    struct Cleanup {
        std::filesystem::path root;

        ~Cleanup() { std::filesystem::remove_all(root); }
    } cleanup{root};

    try {
        std::filesystem::create_directories(root);
        wave_ranges(root);
        stream_loops(root);
        roles();
        scene_lifecycle(root / "Scene");
        intro_fallback(root / "Intro");
        std::cout << "PASS: " << checks
                  << " bounded WAV, streamed loops, mount/intro mix, reset, selection and music-control checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
