#pragma once
#include "audio.hpp"
#include "player.hpp"
#include <memory>

namespace openslope {
struct AudioStats {unsigned contacts{},transients{},ambient{};std::size_t decoded_bytes{};int music_node=-1;};
class AudioScene {
public:
    explicit AudioScene(const std::filesystem::path& root);~AudioScene();
    AudioScene(const AudioScene&)=delete;AudioScene& operator=(const AudioScene&)=delete;
    AudioMixer& mixer();
    void listener(AudioListener value);
    void tick(const Player& player,const Rider& before);
    void service();void music_level(unsigned level);void music_event(unsigned event);
    void restart();AudioStats stats() const;
    void play_course(unsigned slot,Vec3 position,double gain=1);
private:
    struct Data;std::unique_ptr<Data> data_;
};
}
