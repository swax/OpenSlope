#include "openslope/course_recovery.hpp"
#include <algorithm>
#include <stdexcept>

namespace openslope {
namespace {
double horizontal(Vec3 p) { return std::hypot(p.x, p.z); }

double box_distance(const Bounds& b, Vec3 p) {
    return length(p - Vec3{std::clamp(p.x, b.min.x, b.max.x), std::clamp(p.y, b.min.y, b.max.y),
                           std::clamp(p.z, b.min.z, b.max.z)});
}

bool covers(const PathEvent& event, double station) { return station >= event.start && station < event.end; }
} // namespace

double recovery_station(std::span<const PathEvent> events, double station) {
    if (!std::isfinite(station) || station < 0)
        throw std::invalid_argument("Invalid recovery station");
    // [Trailmap: 250-reset-events] Backward, forward, then jump-window priority.
    for (const auto type : {103, 105, 100}) {
        const auto found = std::find_if(events.begin(), events.end(), [&](const auto& event) {
            return event.type == type && covers(event, station);
        });
        if (found != events.end())
            return type == 103 ? found->start : found->end;
    }
    return station;
}

bool reset_forbidden(std::span<const PathEvent> events, double station) {
    if (!std::isfinite(station) || station < 0)
        throw std::invalid_argument("Invalid no-reset station");
    return std::any_of(events.begin(), events.end(),
                       [&](const auto& event) { return event.type == 104 && covers(event, station); });
}

CourseRecovery::CourseRecovery(CoursePaths paths) {
    ai_count_ = paths.ai.size();
    const auto append = [&](CoursePath path) {
        Line line{std::move(path), {}, {}};
        double station = 0;
        for (std::size_t i = 0; i < line.path.points.size(); ++i) {
            const auto point = line.path.points[i];
            if (!finite(point))
                throw std::invalid_argument("Invalid recovery path");
            if (i)
                station += horizontal(point - line.path.points[i - 1]);
            if (!std::isfinite(station))
                throw std::invalid_argument("Recovery path length exceeds numeric limits");
            line.arc.push_back(station);
            line.bounds.add(point);
        }
        lines_.push_back(std::move(line));
    };
    for (auto& path : paths.ai)
        append(std::move(path));
    for (auto& path : paths.race)
        append(std::move(path));
}

void CourseRecovery::tick(double seconds) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid recovery clock");
    elapsed_ += seconds;
}

CourseRecovery::Projection CourseRecovery::project(std::size_t index, Vec3 position) const {
    const auto& line = lines_.at(index);
    Projection result{index, 0, 1e100, {}};
    for (std::size_t i = 1; i < line.path.points.size(); ++i) {
        const auto a = line.path.points[i - 1], d = line.path.points[i] - a;
        const auto span = line.arc[i] - line.arc[i - 1];
        if (span < 1e-9)
            continue;
        const auto t = std::clamp(((position.x - a.x) * d.x + (position.z - a.z) * d.z) / (span * span), 0., 1.);
        const auto point = a + d * t;
        const auto distance = length(position - point);
        if (distance < result.distance)
            result = {index, line.arc[i - 1] + span * t, distance, point};
    }
    return result;
}

RecoveryPose CourseRecovery::pose(std::size_t index, double station) const {
    const auto& line = lines_.at(index);
    const auto& points = line.path.points;
    std::optional<RecoveryPose> last;
    for (std::size_t i = 1; i < points.size(); ++i) {
        const auto span = line.arc[i] - line.arc[i - 1];
        if (span < 1e-9)
            continue;
        if (station <= line.arc[i] || i + 1 == points.size()) {
            const auto direction = points[i] - points[i - 1];
            return {points[i - 1] + direction * ((station - line.arc[i - 1]) / span),
                    normalized(openslope::project(direction, {0, 1, 0}), {0, 0, -1}),
                    index < ai_count_ ? RecoverySource::AIPath : RecoverySource::RaceLine, index, station};
        }
        last = RecoveryPose{points[i - 1] + (points[i] - points[i - 1]) * ((station - line.arc[i - 1]) / span),
                            normalized(openslope::project(points[i] - points[i - 1], {0, 1, 0}), {0, 0, -1}),
                            index < ai_count_ ? RecoverySource::AIPath : RecoverySource::RaceLine, index, station};
    }
    if (last)
        return *last;
    throw std::runtime_error("Recovery path has no horizontal extent");
}

std::vector<CourseRecovery::Projection> CourseRecovery::nearest(Vec3 position, bool ai, bool respawn_only) const {
    std::vector<std::pair<double, std::size_t>> bounds;
    for (std::size_t i = ai ? 0 : ai_count_; i < (ai ? ai_count_ : lines_.size()); ++i) {
        const auto& line = lines_[i];
        if (line.arc.empty() || line.arc.back() < 1e-9 || (respawn_only && !line.path.respawnable))
            continue;
        bounds.push_back({box_distance(line.bounds, position), i});
    }
    std::sort(bounds.begin(), bounds.end());
    std::vector<Projection> result;
    for (const auto& [lower, index] : bounds) {
        if (result.size() == 6 && lower > result.back().distance)
            break;
        result.push_back(project(index, position));
        std::stable_sort(result.begin(), result.end(), [&](const auto& a, const auto& b) {
            if (a.distance != b.distance)
                return a.distance < b.distance;
            return a.path == tracked_.value_or(SIZE_MAX) && b.path != a.path;
        });
        if (result.size() > 6)
            result.resize(6);
    }
    return result;
}

void CourseRecovery::observe(Vec3 position, Vec3 forward) {
    if (!finite(position) || !finite(forward))
        throw std::invalid_argument("Invalid recovery observation");
    if (observed_ && length(position - *observed_) < 1)
        return;
    if (observed_ && length(position - *observed_) > 150) {
        trail_.clear();
        tracked_.reset();
    }
    observed_ = position;
    const auto candidates = nearest(position, true, false);
    if (!candidates.empty() && horizontal(candidates.front().point - position) < 150)
        tracked_ = candidates.front().path;
    if (trail_.empty() || length(position - trail_.back().position) >= 5) {
        trail_.push_back(
            {position, normalized(openslope::project(forward, {0, 1, 0}), {0, 0, -1}), RecoverySource::Trail});
        if (trail_.size() > 128)
            trail_.pop_front();
    }
}

bool CourseRecovery::blocked(Vec3 position) const {
    if (!finite(position))
        throw std::invalid_argument("Invalid recovery position");
    auto path = tracked_;
    if (!path) {
        const auto candidates = nearest(position, true, false);
        if (!candidates.empty())
            path = candidates.front().path;
    }
    if (!path)
        return false;
    const auto current = project(*path, position);
    if (horizontal(current.point - position) > 150)
        return false;
    return reset_forbidden(lines_[*path].path.events, current.station);
}

std::optional<RecoveryPose> CourseRecovery::choose(Vec3 position, RecoveryPose start,
                                                   const std::function<bool(Vec3)>& safe) {
    if (!finite(position) || !finite(start.position) || !finite(start.forward) || !safe)
        throw std::invalid_argument("Invalid course recovery request");
    if (blocked(position))
        return {};
    while (!requests_.empty() && elapsed_ - requests_.front() > 4)
        requests_.pop_front();
    const auto accept = [&](RecoveryPose result) -> std::optional<RecoveryPose> {
        if (!finite(result.position) || !finite(result.forward) || !safe(result.position))
            return {};
        if (requests_.size() >= 3)
            requests_.pop_front();
        requests_.push_back(elapsed_);
        return result;
    };
    if (requests_.size() >= 2)
        return accept(start);
    auto anchor = position;
    if (tracked_) {
        const auto projection = project(*tracked_, position);
        if (horizontal(projection.point - position) <= 150)
            anchor = projection.point;
    }
    const auto candidates = nearest(anchor, true, true);
    std::vector<std::pair<double, Projection>> ranked;
    for (const auto& candidate : candidates) {
        const auto& line = lines_[candidate.path];
        if (candidate.station > line.arc.back() - 2 || horizontal(candidate.point - position) > 150)
            continue;
        const auto ahead = pose(candidate.path, candidate.station + 8);
        ranked.push_back({candidate.distance + length(ahead.position - anchor), candidate});
    }
    std::stable_sort(ranked.begin(), ranked.end(), [&](const auto& a, const auto& b) {
        if (a.first != b.first)
            return a.first < b.first;
        return a.second.path == tracked_.value_or(SIZE_MAX) && b.second.path != a.second.path;
    });
    for (const auto& entry : ranked) {
        const auto& candidate = entry.second;
        const auto station = recovery_station(lines_[candidate.path].path.events, candidate.station);
        if (auto target = accept(pose(candidate.path, station)))
            return target;
    }
    // First-party play fallback: nearby course spine, recent safe trail, then start.
    auto race_query = position;
    if (observed_)
        race_query.y = observed_->y;
    for (const auto& candidate : nearest(race_query, false, false))
        if (horizontal(candidate.point - position) < 150)
            if (auto target = accept(pose(candidate.path, candidate.station)))
                return target;
    if (!trail_.empty()) {
        const auto back = trail_.size() > 1 ? trail_.size() - 2 : 0;
        for (std::size_t i = back + 1; i > 0; --i)
            if (auto target = accept(trail_[i - 1]))
                return target;
    }
    return accept(start);
}
} // namespace openslope
