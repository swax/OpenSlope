#include "openslope/audio_data.hpp"
#include "openslope/audio_program.hpp"
#include "openslope/music.hpp"
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void require(bool v, const char* message) {
    ++checks;
    if (!v)
        throw std::runtime_error(message);
}

void near(double a, double b, const char* message) { require(std::abs(a - b) < 1e-6, message); }

template <class F> void rejects(F op, const char* message) {
    bool rejected = false;
    try {
        op();
    } catch (const std::exception&) {
        rejected = true;
    }
    require(rejected, message);
}

void codecs() {
    std::array<std::uint8_t, 16> ps{};
    ps[0] = 12;
    ps[2] = 0x81;
    AdpcmState state;
    const auto decoded = decode_audio_frames(ps, 5, 28, state);
    require(decoded[0] == 1 && decoded[1] == -8, "PS nibble order and sign extension");
    std::array<std::uint8_t, 15> ea{};
    ea[0] = 12;
    ea[1] = 0x81;
    state = {};
    const auto xa = decode_audio_frames(ea, 10, 28, state);
    require(xa[0] == -8 && xa[1] == 1, "EA nibble order and fixed-point scale");
    ps[0] = 0x10;
    std::fill(ps.begin() + 2, ps.end(), 0x77);
    state = {};
    const auto history = decode_audio_frames(ps, 5, 28, state);
    require(history[0] == 28672 && history[1] == 32767, "PS output clamps on an overloaded predictor");
    require(state.first > 32767, "PS predictor retains unclamped precision");
    const std::array<std::uint8_t, 3> pcm{0, 127, 128};
    state = {};
    const auto raw = decode_audio_frames(pcm, 9, 3, state);
    require(raw == std::vector<std::int16_t>({0, 32512, -32768}), "Bank PCM is signed eight-bit");
    rejects(
        [&] {
            AdpcmState s;
            static_cast<void>(decode_audio_frames(std::span(ps).first(15), 5, 28, s));
        },
        "Reject truncated codec frame");
}

void mixer() {
    auto clip = std::make_shared<PcmClip>();
    clip->samples.assign(2000, .5f);
    AudioMixer mix;
    auto voice = mix.play(clip);
    std::vector<float> output(2400);
    mix.render(output);
    near(output[2000], .5, "Steady mono sample is delivered to left");
    near(output[2001], .5, "Steady mono sample is delivered to right");
    mix.paused(true);
    mix.render(output);
    require(std::all_of(output.begin(), output.end(), [](float v) { return v == 0; }), "Paused mixer is silent");
    mix.paused(false);
    mix.render(output);
    require(mix.voices() == 0, "Paused playback preserves phase then resumes to its end");
    clip = std::make_shared<PcmClip>();
    clip->rate = 24000;
    clip->samples = {.1f, .2f, .3f, .4f};
    clip->loop_start = 1;
    clip->loop_end = 3;
    voice = mix.play(clip, {1, 1, true});
    std::array<float, 16> small{};
    mix.render(small);
    const std::array<double, 8> expected{.1, .15, .2, .25, .3, .25, .2, .25};
    for (unsigned i = 0; i < 8; ++i)
        near(small[i * 2] / ((i + 1) / 480.), expected[i], "Resampling and tagged loop phase");
    require(mix.update(voice, {.5, 2, true}), "Update a continuing voice");
    mix.stop(voice);
    require(mix.voices() == 0, "Stop a continuing voice");
    clip = std::make_shared<PcmClip>();
    clip->samples.assign(2000, .5f);
    voice = mix.play(clip, {1, 1, false, true, {10, 0, 0}, 100});
    mix.render(output);
    near(output[2000], 0, "Right-side emitter has no left channel");
    near(output[2001], .45, "Spatial pan and range attenuation");
    mix.clear();
    auto low = std::make_shared<PcmClip>(*clip);
    low->priority = 1;
    for (unsigned i = 0; i < 128; ++i)
        mix.play(clip, {1, 1, true});
    require(mix.play(low) == 0, "Priority admission preserves occupied higher-priority voices");
    auto high = std::make_shared<PcmClip>(*clip);
    high->priority = 100;
    require(mix.play(high) != 0 && mix.voices() == 128, "High-priority voice replaces an older voice within the bound");
    rejects([&] { mix.listener({{}, {0, 1, 0}, {0, 1, 0}}); }, "Reject degenerate listener frame");
    rejects([&] { mix.render(std::span(output).first(3)); }, "Reject nonstereo output extent");
    mix.clear();
    auto a = std::make_shared<PcmClip>();
    a->samples.assign(1000, .2f);
    auto b = std::make_shared<PcmClip>();
    b->samples.assign(1000, .4f);
    voice = mix.play(a);
    mix.queue(voice, b);
    std::vector<float> chain(3000);
    mix.render(chain);
    near(chain[1998], .2, "Playing clip drains to its last sample");
    near(chain[2000], .4, "Queued clip begins on the following output sample");
    require(mix.status(voice)->generation == 1, "Queued segment exposes its generation");
}

void programs() {
    const auto data = parse_audio_programs("[PACK]\n[ICE]\n[GLIDE]\nLoad Slip\nMap 100\nPush\nLoad "
                                           "3\nPush\nSAdd\nPop\nBound 0, 127\nAssignVol\nLoad 7\nAssignBend\n");
    const auto value = evaluate_audio_program(data.at("ICE").at("GLIDE"), {50});
    near(value.volume, 66.5, "Source program accumulator and stack arithmetic");
    near(value.bend, 7, "Source program separate pitch assignment");
    rejects([&] { parse_audio_programs("[PACK]\n[GLIDE]\nDiv 0\n"); }, "Reject zero expression divisor");
    near(ambient_curve(0, .5), .75, "Quadratic ambient falloff");
    near(ambient_curve(1, .5), .6, "Rational ambient falloff");
    near(ambient_curve(2, .5), .5, "Linear ambient falloff");
    near(ambient_curve(3, .5), .4, "Inverse rational ambient falloff");
    near(ambient_curve(4, .5), .25, "Squared ambient falloff");
    near(ambient_curve(5, .85), .5, "Plateau ambient falloff");
}

void graphs() {
    MusicGraph graph;
    graph.tracks = 1;
    graph.sections = 1;
    graph.events = 1;
    graph.event_table = {0};
    graph.routers = {0x80ff};
    graph.samples = {{"low.wav", 0, 1}, {"high.wav", 0, 1}};
    graph.nodes = {
        {0, 0, 0, 0, 0, {{0, 40, 1}, {40, 127, 2}}}, {1, 0, 0, 0, 0, {{0, 127, 1}}}, {2, 0, 0, 0, 0, {{0, 127, 2}}}};
    MusicCursor low, high;
    require(music_advance(graph, low, 40) == 0, "Shared range endpoint selects first link");
    require(music_advance(graph, high, 80) == 1, "Race path level selects authored high branch");
    require(music_advance(graph, high, 80, 0) == 1, "Track-excluded neutral event keeps the normal walk");
    graph.routers[0] = 0x000101ff;
    high.node = 2;
    require(music_advance(graph, high, 80, 0) == 0, "Event router changes node at its boundary");
    graph.routers[0] = 0x40ff;
    require(music_advance(graph, high, 80, 0) == -1 && high.ended, "Song-end router ends playback");
    graph.events = 0;
    graph.event_table.clear();
    graph.routers.clear();
    graph.nodes = {{0, 0, 0, 0, 0, {{0, 127, 1}}},
                   {-1, 0, 127, 0, 2u << 8, {{1, 127, 2}, {0, 0, 3}}},
                   {1, 0, 0, 0, 0, {{0, 127, 1}}},
                   {2, 0, 0, 0, 0, {}}};
    MusicCursor loop;
    require(music_advance(graph, loop, 80) == 0 && music_advance(graph, loop, 80) == 0 &&
                music_advance(graph, loop, 80) == 1,
            "Loop control counts down before its exit");
    graph.nodes[0].links = {{0, 127, 2}};
    graph.nodes[0].word2 = 1u << 16;
    graph.variables = {{{2, 3}}};
    MusicCursor remap;
    require(music_advance(graph, remap, 80) == 1, "Complete variable list replaces a selected target");
}
} // namespace

int main() {
    try {
        codecs();
        mixer();
        programs();
        graphs();
        std::cout << "PASS: " << checks << " codec, mixer, loop, spatial, program and music checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
