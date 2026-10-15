#pragma once
#include "math.hpp"
#include <filesystem>
#include <vector>

namespace openslope {
enum class PoseEvent { None, GetUpFinished };

struct PoseKey {
    double time{}, standing{}, crouch{}, height{};
    PoseEvent event = PoseEvent::None;
};

struct PoseSample {
    double standing{}, crouch{}, height{};
};

// Fixed-tick pose tracks also carry events; gameplay consumes the clip marker.
class PoseAnimation {
public:
    static PoseAnimation get_up(const std::filesystem::path& root);
    explicit PoseAnimation(std::vector<PoseKey> keys);
    void play();
    void stop();
    void tick(double seconds);
    PoseSample pose() const;
    bool take(PoseEvent event);

    bool playing() const { return playing_; }

private:
    std::vector<PoseKey> keys_;
    std::vector<PoseEvent> events_;
    double time_{};
    std::size_t next_{};
    bool playing_ = false;
};
} // namespace openslope
