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
    unsigned rate=48000,channels=1;
    std::vector<float> samples;
    std::size_t loop_start{},loop_end{};
    unsigned priority=90;
    std::size_t frames() const {return samples.size()/channels;}
    static PcmClip load(const std::filesystem::path& path);
};
struct AdpcmState {std::int64_t first{},second{};};
std::vector<std::int16_t> decode_audio_frames(std::span<const std::uint8_t> source,unsigned codec,std::size_t count,AdpcmState& history);
void write_wave(const std::filesystem::path& path,const PcmClip& clip);
struct VoiceParams {double gain=1,pitch=1;bool loop=false,spatial=false;Vec3 position{};double range=100;bool distance_falloff=true;};
struct VoiceStatus {std::uint64_t generation{};double frame{};std::size_t frames{};unsigned rate{};};
struct AudioListener {Vec3 position,forward{0,0,-1},up{0,1,0};};
class AudioMixer {
public:
    explicit AudioMixer(unsigned rate=48000);~AudioMixer();
    AudioMixer(const AudioMixer&)=delete;AudioMixer& operator=(const AudioMixer&)=delete;
    std::uint64_t play(std::shared_ptr<const PcmClip> clip,VoiceParams params={});
    bool update(std::uint64_t voice,VoiceParams params);
    bool queue(std::uint64_t voice,std::shared_ptr<const PcmClip> clip,VoiceParams params={});
    std::optional<VoiceStatus> status(std::uint64_t voice) const;
    void stop(std::uint64_t voice);void clear();
    void listener(AudioListener listener);void paused(bool value);void volume(double value);
    void render(std::span<float> stereo);
    unsigned rate() const;std::size_t voices() const;
private:
    struct Data;std::unique_ptr<Data> data_;
};
}
