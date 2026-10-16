#pragma once
#include <cstdint>
#include <optional>
#include <string>

namespace openslope {
enum class ScoreMotion { Ground, Air, Rail };
enum class ScoreLoss { None, Crash, Reset, BoardReleased };

struct ScoreStatus {
    bool active = false, finished = false, bailed = false;
    std::int64_t banked = 0, preview = 0, result = 0;
    double meter = .25, style = 0, airtime = 0, grind_time = 0, result_age = 0;
    double spin_degrees = 0, flip_degrees = 0, grab_time = 0;
    std::optional<unsigned> grab_hand;
    unsigned multiplier = 1, resolution = 0;
    ScoreLoss loss = ScoreLoss::None;

    std::int64_t total() const { return banked + preview; }
};

// Shared scoring profile: public gameplay examples and clean 360/390 behavior.
class TrickScore {
public:
    const ScoreStatus& status() const { return status_; }

    void reset();
    void start();
    std::int64_t finish();
    void step(double seconds, ScoreMotion motion, double spin_degrees = 0, double flip_degrees = 0);
    void step_off_board(double seconds, std::optional<unsigned> hand);

    void release_grab() { grab_held_ = false; }

    void land();
    void lose(ScoreLoss reason, double meter_penalty = 0);
    void spend(double seconds, bool held);
    void multiplier(unsigned tier);

    double boost_amount() const { return status_.active ? status_.meter : 1; }

    unsigned meter_segments() const;

private:
    ScoreStatus status_;
    ScoreMotion motion_ = ScoreMotion::Ground;
    bool open_ = false, rail_ = false, grab_held_ = false;
    void accumulate(double seconds, ScoreMotion motion, double spin, double flip, std::optional<unsigned> hand);
    void clear_combo(bool consume_multiplier);
    void preview();
};

enum class TrickDisplayState { None, Live, Banked, Lost };

struct TrickDisplay {
    TrickDisplayState state = TrickDisplayState::None;
    std::int64_t points = 0;
    std::string detail;
};

TrickDisplay trick_display(const TrickScore& score);
std::string score_readout(const TrickScore& score);
} // namespace openslope
