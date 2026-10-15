#include "openslope/board_audio.hpp"
#include "board_audio.hpp"
#include <algorithm>
#include <cmath>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
namespace {
const auto& tuning() {
    static const auto value = nlohmann::json::parse(std::begin(bundled::board_audio), std::end(bundled::board_audio));
    return value;
}

double unit(double value) { return std::isfinite(value) ? std::clamp(value, 0., 1.) : 0; }

double smooth(double value) { return value * value * (3 - 2 * value); }

bool contains(const nlohmann::json& values, unsigned value) {
    return std::find(values.begin(), values.end(), value) != values.end();
}

double slew(double before, double target, double seconds, double release) {
    const auto rate = target > before ? tuning().at("slew").at("attack").get<double>() : release;
    return before + std::clamp(target - before, -rate * seconds, rate * seconds);
}
} // namespace

double board_audio_speed(double speed) {
    const auto& t = tuning().at("speed");
    return unit((speed - t.at("start").get<double>()) / t.at("span").get<double>());
}

BoardBed board_bed(unsigned group, double slip, double lean, double speed) {
    const auto& t = tuning();
    const auto s = unit(slip / t.at("slipSpan").get<double>()), l = unit(lean / t.at("leanSpan").get<double>());
    const auto edge = smooth(std::max(s, l)), volume = smooth(unit(speed));
    BoardBed result{volume * (1 - edge), 0, volume * edge, 0};
    if (contains(t.at("softGroups"), group)) {
        const auto& p = t.at("soft");
        result.glide = volume * (1 - p.at("glideLoss").get<double>() * edge);
        result.carve = volume * p.at("carve").get<double>() * edge;
    } else if (contains(t.at("hardGroups"), group)) {
        const auto& p = t.at("hard");
        const auto gain = volume * (p.at("idle").get<double>() + p.at("slip").get<double>() * s);
        result.glide = gain * (1 - p.at("glideLoss").get<double>() * edge);
        result.carve = gain * (p.at("carveIdle").get<double>() + p.at("carve").get<double>() * edge);
    }
    const auto& bend = t.at("bend");
    result.glide_bend = bend.at("glideSlip").get<double>() * s + bend.at("glideLean").get<double>() * l;
    result.carve_bend = bend.at("carveSlip").get<double>() * s + bend.at("carveLean").get<double>() * l;
    return result;
}

BoardAudioFrame BoardAudio::step(const BoardAudioInput& in, double dt) {
    if (!std::isfinite(dt) || dt < 0 || dt > 1)
        throw std::runtime_error("Invalid board audio frame duration");
    const auto& t = tuning();
    const auto speed = board_audio_speed(in.speed);
    const bool ground = in.mounted && in.ground && !in.rail, air = in.mounted && !in.ground && !in.rail;
    const auto bed = board_bed(in.group, in.slip, in.lean, speed);
    std::array<double, 4> target{ground ? bed.glide : 0, ground ? bed.carve : 0,
                                 in.mounted && in.rail ? t.at("rail").at("gain").get<double>() * speed : 0,
                                 air && in.predicted_flight > t.at("wind").at("flightThreshold").get<double>()
                                     ? t.at("wind").at("gain").get<double>()
                                     : 0};
    if (frame_.group != in.group) {
        frame_.layers[0].gain = frame_.layers[1].gain = 0;
    }
    frame_.group = in.group;
    for (unsigned i = 0; i < target.size(); ++i)
        frame_.layers[i].gain = slew(frame_.layers[i].gain, target[i], dt, t.at("slew").at("release"));
    const auto bend = t.at("bend").at("span").get<double>();
    frame_.layers[0].pitch = 1 + bend * bed.glide_bend;
    frame_.layers[1].pitch = 1 + bend * bed.carve_bend;
    frame_.pop.reset();
    frame_.land.reset();
    if (in.mounted && in.launched)
        frame_.pop = t.at("pop").at("idle").get<double>() + t.at("pop").at("charge").get<double>() * unit(in.charge);
    const auto slam = unit(in.impact / t.at("land").at("slamSpeed").get<double>());
    if (was_air_ && ground && slam > t.at("land").at("threshold").get<double>())
        frame_.land = t.at("land").at("idle").get<double>() + t.at("land").at("slam").get<double>() * slam;
    was_air_ = air;
    if (in.boosting && !was_boosting_) {
        boost_age_ = 0;
        frame_.boost_slot = in.boost_slot;
    }
    boost_age_ = in.boosting ? boost_age_ + dt : 0;
    const auto boost_target = !in.boosting ? 0
                              : boost_age_ < t.at("boost").at("punchSeconds").get<double>()
                                  ? t.at("boost").at("punch").get<double>()
                                  : t.at("boost").at("sustain").get<double>();
    frame_.boost.gain = slew(frame_.boost.gain, boost_target, dt, t.at("slew").at("boostRelease"));
    was_boosting_ = in.boosting;
    return frame_;
}

void BoardAudio::reset() { *this = {}; }
} // namespace openslope
