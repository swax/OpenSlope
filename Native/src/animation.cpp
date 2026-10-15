#include "openslope/animation.hpp"
#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
PoseAnimation::PoseAnimation(std::vector<PoseKey> keys) : keys_(std::move(keys)) {
    if (keys_.size() < 2 || keys_.size() > 256 || keys_.front().time != 0)
        throw std::runtime_error("Pose clip needs 2..256 keys starting at zero");
    double previous = -1;
    for (std::size_t i = 0; i < keys_.size(); ++i) {
        const auto& key = keys_[i];
        if (!std::isfinite(key.time) || key.time <= previous || key.time > 30 || !std::isfinite(key.standing) ||
            key.standing < 0 || key.standing > 1 || !std::isfinite(key.crouch) || key.crouch < 0 || key.crouch > 1 ||
            !std::isfinite(key.height) || key.height < 0 || key.height > 2)
            throw std::runtime_error("Invalid pose clip key");
        if (key.event == PoseEvent::GetUpFinished &&
            (i + 1 != keys_.size() || key.standing != 1 || key.crouch != 0 || key.height != 0))
            throw std::runtime_error("Get-up completion must mark the final standing pose");
        previous = key.time;
    }
}

PoseAnimation PoseAnimation::get_up(const std::filesystem::path& root) {
    // Application-authored pose, pending imported character tracks. These keys
    // animate the board/body frame and crouch; the final key emits completion.
    std::vector<PoseKey> keys{
        {0, 0, 1, .35}, {.25, .2, 1, .3}, {.6, .7, .7, .15}, {1, 1, .2, .04}, {1.2, 1, 0, 0, PoseEvent::GetUpFinished}};
    if (root.empty() || !std::filesystem::exists(root / "RiderAnimations.json"))
        return PoseAnimation(std::move(keys));
    const auto base = std::filesystem::weakly_canonical(root),
               file = std::filesystem::weakly_canonical(root / "RiderAnimations.json"),
               relative = file.lexically_relative(base);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == ".." ||
        std::filesystem::file_size(file) > 1024 * 1024)
        throw std::runtime_error("Invalid rider animation profile path/size");
    std::ifstream input(file);
    const auto profile = nlohmann::json::parse(input);
    if (profile.value("Schema", "") != "openslope-rider-animation/v1")
        throw std::runtime_error("Unsupported rider animation profile");
    if (profile.contains("GetUp")) {
        keys.clear();
        const auto& rows = profile.at("GetUp");
        if (!rows.is_array() || rows.size() > 256)
            throw std::runtime_error("Invalid get-up key count");
        for (const auto& row : rows) {
            const auto event = row.value("Event", "");
            if (!event.empty() && event != "get-up-finished")
                throw std::runtime_error("Unknown rider pose event");
            keys.push_back({row.at("Time").get<double>(), row.at("Standing").get<double>(),
                            row.at("Crouch").get<double>(), row.at("Height").get<double>(),
                            event.empty() ? PoseEvent::None : PoseEvent::GetUpFinished});
        }
    }
    return PoseAnimation(std::move(keys));
}

void PoseAnimation::play() {
    time_ = 0;
    next_ = 0;
    playing_ = true;
    events_.clear();
    tick(0);
}

void PoseAnimation::stop() {
    time_ = 0;
    next_ = 0;
    playing_ = false;
    events_.clear();
}

void PoseAnimation::tick(double seconds) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::runtime_error("Invalid pose animation timestep");
    if (!playing_)
        return;
    time_ = std::min(keys_.back().time, time_ + seconds);
    while (next_ < keys_.size() && keys_[next_].time <= time_ + 1e-9) {
        if (keys_[next_].event != PoseEvent::None)
            events_.push_back(keys_[next_].event);
        ++next_;
    }
    if (time_ + 1e-9 >= keys_.back().time)
        playing_ = false;
}

PoseSample PoseAnimation::pose() const {
    const auto upper = std::upper_bound(keys_.begin(), keys_.end(), time_,
                                        [](double time, const PoseKey& key) { return time < key.time; });
    if (upper == keys_.end()) {
        const auto& key = keys_.back();
        return {key.standing, key.crouch, key.height};
    }
    if (upper == keys_.begin()) {
        const auto& key = keys_.front();
        return {key.standing, key.crouch, key.height};
    }
    const auto& a = *(upper - 1);
    const auto& b = *upper;
    auto t = std::clamp((time_ - a.time) / (b.time - a.time), 0., 1.);
    t = t * t * (3 - 2 * t);
    return {a.standing + (b.standing - a.standing) * t, a.crouch + (b.crouch - a.crouch) * t,
            a.height + (b.height - a.height) * t};
}

bool PoseAnimation::take(PoseEvent event) {
    const auto found = std::find(events_.begin(), events_.end(), event);
    if (found == events_.end())
        return false;
    events_.erase(found);
    return true;
}
} // namespace openslope
