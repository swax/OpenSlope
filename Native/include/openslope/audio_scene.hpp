#pragma once
#include "audio.hpp"
#include "player.hpp"
#include <memory>
#include <string>

namespace openslope {
struct AudioStats {
    unsigned contacts{}, transients{}, ambient{}, prewarmed{}, prewarm_skipped{};
    unsigned ambient_candidates{}, ambient_selected{}, ambient_active{};
    std::size_t decoded_bytes{}, streamed_bytes{};
    int music_node = -1;
};

struct AmbientVoiceStatus {
    std::string key;
    std::size_t instance{};
    double gain{};
    std::uint64_t voice{};
};

struct MusicStatus {
    bool enabled = true, authored = false;
    std::string selection, song;
    std::vector<std::string> songs;
    double race{}, ambience{};
};

class AudioScene {
public:
    explicit AudioScene(const std::filesystem::path& root);
    ~AudioScene();
    AudioScene(const AudioScene&) = delete;
    AudioScene& operator=(const AudioScene&) = delete;
    AudioMixer& mixer();
    void listener(AudioListener value);
    void tick(const Player& player, const Rider& before);
    void service();
    void music_level(unsigned level);
    void music_event(unsigned event);
    void restart();
    void music_enabled(bool value);
    void music_song(const std::string& selection);
    AudioStats stats() const;
    void ambient_limit(unsigned maximum);
    std::vector<AmbientVoiceStatus> ambient_voices() const;
    MusicStatus music_status() const;
    void play_course(unsigned slot, Vec3 position, double gain = 1);

private:
    struct Data;
    std::unique_ptr<Data> data_;
};
} // namespace openslope
