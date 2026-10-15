#pragma once
#include <filesystem>
#include <map>
#include <string>

namespace openslope {
class AudioScene;
class RideUi;
struct UiResult;

class AudioPreferences {
public:
    bool music_enabled = true;
    double volume = 1, audible_volume = 1;
    static AudioPreferences load(const std::filesystem::path& file);
    bool save(const std::filesystem::path& file) const;
    static std::filesystem::path default_path();
    std::string song(const std::string& course) const;
    void song(const std::string& course, const std::string& value);
    void toggle_mute();
    void apply(AudioScene& audio, const std::string& course, bool initial = false) const;
    void present(RideUi& ui, const AudioScene* audio, const std::string& course) const;
    bool handle(const UiResult& result, RideUi& ui, AudioScene* audio, const std::string& course);

private:
    std::map<std::string, std::string> songs_;
};
} // namespace openslope
