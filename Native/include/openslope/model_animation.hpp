#pragma once
#include "props.hpp"
#include <optional>

namespace openslope {
struct PropCurveSegment {
    std::array<double, 4> coefficient{};
    double start = 0, end = 0;
};

struct PropObjectMotion {
    Transform rest = identity_transform();
    int parent = -1;
    bool animated = false;
    Vec3 base;
    std::array<std::vector<PropCurveSegment>, 6> channels;
    Transform pose(double seconds) const;
};

struct PropClip {
    double frames = 0;
    std::vector<PropObjectMotion> objects;
};

class PropClips {
public:
    explicit PropClips(std::vector<PropClip> clips = {});
    static PropClips load(const std::filesystem::path& root);

    std::size_t models() const { return clips_.size(); }

    std::size_t objects(std::size_t model) const;
    double frames(std::size_t model) const;
    std::vector<Transform> sample(std::size_t model, double frame, std::optional<double> basis = {}) const;
    std::vector<Transform> delta(std::size_t model, double frame, std::optional<double> basis = {}) const;

private:
    std::vector<PropClip> clips_;
    std::vector<std::vector<std::size_t>> order_;
    std::vector<std::vector<Transform>> inverse_rest_;
};

struct PropMotion {
    std::size_t instance = 0;
    // Each entry maps the baked time-zero model frame to the current pose.
    std::vector<Transform> previous, current;
    // Cosmetic reactions retain the authored collision proxy, like flag waves.
    bool visual_only = false;
};

struct PropPlayLaw {
    int kind = 256, loop = 0, combo_end = 0;
    double start = -1, end = -1, rate = 30, random_rate = 0, debounce = 0;
    double combo_start = -1, combo_last = -1, combo_rate = 30;
    bool reverse = false, random_start = false;
};

class PropPlayback {
public:
    PropPlayback(PropPlayLaw law = {}, double clip_frames = 0, double random_unit = 0);
    void step(double seconds);
    void grant(double frame_budget);
    void hold(double seconds);
    void seek(double frame);
    bool trigger_combo();

    double frame() const { return combo_active_ || combo_holding_ ? combo_frame_ : frame_; }

    std::optional<double> basis() const {
        return combo_active_ || combo_holding_ ? std::optional<double>(snapshot_) : std::nullopt;
    }

    double budget() const { return budget_; }

    bool done() const { return ended_; }

    bool valid() const { return last_ > first_; }

    bool take_end() {
        const auto result = end_notice_;
        end_notice_ = false;
        return result;
    }

    void paused(bool value) { paused_ = value; }

    bool paused() const { return paused_; }

private:
    PropPlayLaw law_;
    double clip_ = 0, first_ = 0, last_ = 0, frame_ = 0, phase_ = 0, rate_ = 0, budget_ = 0, hold_ = 0;
    double combo_first_ = 0, combo_last_ = 0, combo_frame_ = 0, snapshot_ = 0;
    bool ended_ = false, end_notice_ = false, paused_ = false, combo_active_ = false, combo_holding_ = false,
         latched_ = false;
};
} // namespace openslope
