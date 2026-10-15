#pragma once
#include "audio.hpp"

namespace openslope {
class MusicStream {
public:
    MusicStream(AudioMixer& mixer, std::vector<std::filesystem::path> files, AudioRole role, bool loop,
                double loop_start = 0, double loop_end = 0, double volume = 1);
    ~MusicStream();
    void playing(bool value);
    void restart();
    void service();
    std::size_t bytes() const;

private:
    struct Data;
    std::unique_ptr<Data> data_;
};
} // namespace openslope
