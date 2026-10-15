#include "openslope/audio.hpp"
#include <mutex>
#include <stdexcept>

namespace openslope {
namespace {
void valid(const VoiceParams& p) {
    if (!std::isfinite(p.gain) || p.gain < 0 || p.gain > 16 || !std::isfinite(p.pitch) || p.pitch < .125 ||
        p.pitch > 8 || !finite(p.position) || !std::isfinite(p.range) || p.range <= 0 ||
        !std::isfinite(p.ramp_seconds) || p.ramp_seconds < 0 || p.ramp_seconds > 1 || unsigned(p.role) > 2)
        throw std::runtime_error("Invalid audio voice parameters");
}
} // namespace

struct AudioMixer::Data {
    struct Voice {
        std::uint64_t id{};
        std::shared_ptr<const PcmClip> clip;
        VoiceParams params;
        double phase{}, gain{};
        std::shared_ptr<const PcmClip> next;
        VoiceParams next_params;
        std::uint64_t generation{};
        unsigned ramp_frames{};
    };

    std::array<Voice, 128> voices;
    unsigned rate;
    AudioListener listener;
    std::uint64_t next = 1;
    double master = 1, current_master = 1;
    bool paused = false;
    std::array<double, 3> role_target{1, 1, 1}, role_current{1, 0, 0};
    mutable std::mutex mutex;

    explicit Data(unsigned sample_rate) : rate(sample_rate) {}
};

AudioMixer::AudioMixer(unsigned rate) : data_(std::make_unique<Data>(rate)) {
    if (rate < 8000 || rate > 192000)
        throw std::runtime_error("Invalid mixer rate");
}

AudioMixer::~AudioMixer() = default;

std::uint64_t AudioMixer::play(std::shared_ptr<const PcmClip> clip, VoiceParams params) {
    valid(params);
    if (!clip || clip->channels < 1 || clip->channels > 2 || clip->rate < 8000 || clip->rate > 192000 ||
        clip->samples.empty() || clip->samples.size() % clip->channels || clip->loop_end > clip->frames() ||
        clip->loop_start > clip->loop_end)
        throw std::runtime_error("Invalid audio clip");
    std::lock_guard lock(data_->mutex);
    auto* target = &data_->voices[0];
    for (auto& voice : data_->voices) {
        if (!voice.id) {
            target = &voice;
            break;
        }
        if (voice.clip->priority < target->clip->priority ||
            (voice.clip->priority == target->clip->priority && voice.id < target->id))
            target = &voice;
    }
    if (target->id && target->clip->priority > clip->priority)
        return 0;
    const auto id = data_->next++;
    *target = {id, std::move(clip), params, 0, 0, {}, {}, 0};
    if (params.loop && params.sustain_only)
        target->phase = double(target->clip->loop_start);
    target->ramp_frames = unsigned(std::ceil(params.ramp_seconds * data_->rate));
    return id;
}

bool AudioMixer::update(std::uint64_t id, VoiceParams params) {
    valid(params);
    std::lock_guard lock(data_->mutex);
    for (auto& v : data_->voices)
        if (v.id == id && id) {
            v.params = params;
            v.ramp_frames = unsigned(std::ceil(params.ramp_seconds * data_->rate));
            return true;
        }
    return false;
}

bool AudioMixer::queue(std::uint64_t id, std::shared_ptr<const PcmClip> clip, VoiceParams params,
                       std::optional<std::uint64_t> expected_generation) {
    valid(params);
    if (clip && (clip->samples.empty() || clip->channels < 1 || clip->channels > 2 || clip->rate < 8000 ||
                 clip->rate > 192000 || clip->samples.size() % clip->channels))
        throw std::runtime_error("Invalid queued audio clip");
    std::lock_guard lock(data_->mutex);
    for (auto& v : data_->voices)
        if (v.id == id && id) {
            if (expected_generation && v.generation != *expected_generation)
                return false;
            v.next = std::move(clip);
            v.next_params = params;
            return true;
        }
    return false;
}

std::optional<VoiceStatus> AudioMixer::status(std::uint64_t id) const {
    std::lock_guard lock(data_->mutex);
    for (const auto& v : data_->voices)
        if (v.id == id && id)
            return VoiceStatus{v.generation, v.phase, v.clip->frames(), v.clip->rate};
    return {};
}

void AudioMixer::stop(std::uint64_t id) {
    std::lock_guard lock(data_->mutex);
    for (auto& v : data_->voices)
        if (v.id == id)
            v = {};
}

void AudioMixer::clear(bool keep_music) {
    std::lock_guard lock(data_->mutex);
    for (auto& v : data_->voices)
        if (!keep_music || v.params.role == AudioRole::Effect)
            v = {};
}

void AudioMixer::music_mix(double race, double ambience, bool immediate) {
    if (!std::isfinite(race) || !std::isfinite(ambience) || race < 0 || race > 1 || ambience < 0 || ambience > 1)
        throw std::runtime_error("Invalid music mix");
    std::lock_guard lock(data_->mutex);
    data_->role_target[1] = race;
    data_->role_target[2] = ambience;
    if (immediate) {
        data_->role_current[1] = race;
        data_->role_current[2] = ambience;
    }
}

void AudioMixer::listener(AudioListener value) {
    if (!finite(value.position) || !finite(value.forward) || !finite(value.up) ||
        length(cross(value.forward, value.up)) < 1e-9)
        throw std::runtime_error("Invalid audio listener");
    std::lock_guard lock(data_->mutex);
    data_->listener = value;
}

void AudioMixer::paused(bool value) {
    std::lock_guard lock(data_->mutex);
    data_->paused = value;
}

void AudioMixer::volume(double value, bool immediate) {
    if (!std::isfinite(value) || value < 0 || value > 1)
        throw std::runtime_error("Invalid audio master volume");
    std::lock_guard lock(data_->mutex);
    data_->master = value;
    if (immediate)
        data_->current_master = value;
}

unsigned AudioMixer::rate() const { return data_->rate; }

std::size_t AudioMixer::voices() const {
    std::lock_guard lock(data_->mutex);
    return std::count_if(data_->voices.begin(), data_->voices.end(), [](const auto& v) { return v.id != 0; });
}

void AudioMixer::render(std::span<float> output) {
    if (output.size() % 2)
        throw std::runtime_error("Mixer output must be stereo");
    std::fill(output.begin(), output.end(), 0.f);
    std::lock_guard lock(data_->mutex);
    if (data_->paused)
        return;
    const auto right = normalized(cross(data_->listener.forward, data_->listener.up));
    for (auto& voice : data_->voices) {
        if (!voice.id)
            continue;
        double left = 1, right_gain = 1, gain = 0, step = 0;
        const auto evaluate = [&] {
            const auto& p = voice.params;
            left = right_gain = 1;
            gain = p.gain;
            step = double(voice.clip->rate) / data_->rate * p.pitch;
            if (p.spatial) {
                const auto delta = p.position - data_->listener.position;
                const auto distance = length(delta),
                           pan = distance > 1e-9 ? std::clamp(dot(delta / distance, right), -1., 1.) : 0;
                if (p.distance_falloff)
                    gain *= std::max(0., 1 - distance / p.range);
                left = std::sqrt((1 - pan) * .5);
                right_gain = std::sqrt((1 + pan) * .5);
            }
        };
        evaluate();
        const auto smoothing = 1. / (.01 * data_->rate);
        for (std::size_t i = 0; i < output.size(); i += 2) {
            const auto old_end =
                voice.params.loop && voice.clip->loop_end ? voice.clip->loop_end : voice.clip->frames();
            if (voice.phase >= old_end && !voice.params.loop && voice.next) {
                const auto over = (voice.phase - old_end) / voice.clip->rate;
                voice.clip = std::move(voice.next);
                voice.params = voice.next_params;
                voice.phase = over * voice.clip->rate;
                ++voice.generation;
                evaluate();
            }
            const auto& clip = *voice.clip;
            const auto& p = voice.params;
            const auto end = p.loop && clip.loop_end ? clip.loop_end : clip.frames(),
                       begin = p.loop && clip.loop_end ? clip.loop_start : 0;
            if (voice.phase >= end) {
                if (!p.loop || end <= begin) {
                    voice.id = 0;
                    voice.clip.reset();
                    break;
                }
                voice.phase = begin + std::fmod(voice.phase - begin, double(end - begin));
            }
            const auto index = std::size_t(voice.phase), next = index + 1 < end ? index + 1 : p.loop ? begin : index;
            const auto fraction = voice.phase - index;
            if (voice.ramp_frames) {
                voice.gain += (gain - voice.gain) / voice.ramp_frames;
                --voice.ramp_frames;
            } else {
                voice.gain += std::clamp(gain - voice.gain, -smoothing, smoothing);
            }
            const auto sample = [&](unsigned channel) {
                return clip.samples[index * clip.channels + channel] * (1 - fraction) +
                       clip.samples[next * clip.channels + channel] * fraction;
            };
            const auto first = sample(0), second = clip.channels == 2 ? sample(1) : first;
            const auto mono = (first + second) * .5;
            const auto role = unsigned(p.role);
            const auto role_gain = role == 0
                                       ? 1.
                                       : data_->role_current[role] +
                                             std::clamp(data_->role_target[role] - data_->role_current[role],
                                                        -smoothing * double(i / 2 + 1), smoothing * double(i / 2 + 1));
            output[i] += float((p.spatial ? mono * left : first) * voice.gain * role_gain);
            output[i + 1] += float((p.spatial ? mono * right_gain : second) * voice.gain * role_gain);
            voice.phase += step;
        }
    }
    for (unsigned role = 1; role < 3; ++role) {
        const auto step = double(output.size() / 2) / (.01 * data_->rate);
        data_->role_current[role] += std::clamp(data_->role_target[role] - data_->role_current[role], -step, step);
    }

    for (std::size_t i = 0; i < output.size(); i += 2) {
        data_->current_master +=
            std::clamp(data_->master - data_->current_master, -1. / (.01 * data_->rate), 1. / (.01 * data_->rate));
        output[i] = float(std::clamp(output[i] * data_->current_master, -1., 1.));
        output[i + 1] = float(std::clamp(output[i + 1] * data_->current_master, -1., 1.));
    }
}
} // namespace openslope
