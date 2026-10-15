#pragma once
#include "openslope/audio.hpp"
#include "openslope/audio_scene.hpp"
#include <memory>

namespace openslope {
class AudioDevice {
public:
    explicit AudioDevice(AudioMixer& mixer);
    ~AudioDevice();
    AudioDevice(const AudioDevice&) = delete;
    AudioDevice& operator=(const AudioDevice&) = delete;
    bool active() const;
    std::uint64_t frames() const;

private:
    struct Data;
    std::unique_ptr<Data> data_;
};

class AudioService {
public:
    explicit AudioService(AudioScene& scene);
    ~AudioService();

private:
    struct Data;
    std::unique_ptr<Data> data_;
};
} // namespace openslope
