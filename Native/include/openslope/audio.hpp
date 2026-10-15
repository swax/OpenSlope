#pragma once
#include "math.hpp"
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <span>
#include <vector>

namespace openslope {
struct PcmClip {
    unsigned rate = 48000, channels = 1;
    std::vector<float> samples;
    std::size_t loop_start{}, loop_end{};
    unsigned priority = 90;

    std::size_t frames() const { return samples.size() / channels; }

    static PcmClip load(const std::filesystem::path& path);
};

// Bounded frame reads for long standard WAV music; callers never load a full song.
class WaveReader {
public:
    explicit WaveReader(const std::filesystem::path& path);
    ~WaveReader();
    WaveReader(const WaveReader&) = delete;
    WaveReader& operator=(const WaveReader&) = delete;
    unsigned rate() const;
    unsigned channels() const;
    std::size_t frames() const;
    PcmClip read(std::size_t first, std::size_t count);

private:
    struct Data;
    std::unique_ptr<Data> data_;
};

struct AdpcmState {
    std::int64_t first{}, second{};
};

std::vector<std::int16_t> decode_audio_frames(std::span<const std::uint8_t> source, unsigned codec, std::size_t count,
                                              AdpcmState& history);
void write_wave(const std::filesystem::path& path, const PcmClip& clip);

enum class AudioRole { Effect, RaceMusic, Ambience };

struct VoiceParams {
    double gain = 1, pitch = 1;
    bool loop = false, spatial = false;
    Vec3 position{};
    double range = 100;
    bool distance_falloff = true;
    double ramp_seconds = 0;
    bool sustain_only = false;
    AudioRole role = AudioRole::Effect;
};

struct VoiceStatus {
    std::uint64_t generation{};
    double frame{};
    std::size_t frames{};
    unsigned rate{};
};

struct AudioListener {
    Vec3 position, forward{0, 0, -1}, up{0, 1, 0};
};

class AudioMixer {
public:
    explicit AudioMixer(unsigned rate = 48000);
    ~AudioMixer();
    AudioMixer(const AudioMixer&) = delete;
    AudioMixer& operator=(const AudioMixer&) = delete;
    std::uint64_t play(std::shared_ptr<const PcmClip> clip, VoiceParams params = {});
    bool update(std::uint64_t voice, VoiceParams params);
    bool queue(std::uint64_t voice, std::shared_ptr<const PcmClip> clip, VoiceParams params = {},
               std::optional<std::uint64_t> expected_generation = {});
    std::optional<VoiceStatus> status(std::uint64_t voice) const;
    void stop(std::uint64_t voice);
    void clear(bool keep_music = false);
    void music_mix(double race, double ambience, bool immediate = false);
    void listener(AudioListener listener);
    void paused(bool value);
    void volume(double value, bool immediate = false);
    void render(std::span<float> stereo);
    unsigned rate() const;
    std::size_t voices() const;

private:
    struct Data;
    std::unique_ptr<Data> data_;
};
} // namespace openslope
