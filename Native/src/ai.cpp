#include "openslope/ai.hpp"
#include <algorithm>
#include <limits>
#include <stdexcept>

namespace openslope {
namespace {
double ground_length(Vec3 v) { return std::hypot(v.x, v.z); }

double ground_dot(Vec3 a, Vec3 b) { return a.x * b.x + a.z * b.z; }

double box_distance(const Bounds& bounds, Vec3 p) {
    return length(p - Vec3{std::clamp(p.x, bounds.min.x, bounds.max.x), std::clamp(p.y, bounds.min.y, bounds.max.y),
                           std::clamp(p.z, bounds.min.z, bounds.max.z)});
}

bool overlaps(const PathEvent& event, double from, double to) {
    return std::min(event.start, event.end) <= to && std::max(event.start, event.end) >= from;
}
} // namespace

AiNetwork::AiNetwork(CoursePaths paths) : paths_(std::move(paths)) {
    if (paths_.ai.size() > 4000)
        throw std::invalid_argument("AI network exceeds its path limit");
    std::size_t items = 0;
    for (const auto& path : paths_.ai) {
        items += path.points.size() + path.events.size();
        if (items > 1000000)
            throw std::invalid_argument("AI network exceeds its point/event budget");
        if (path.rating > 100)
            throw std::invalid_argument("AI route needs a valid rating");
        for (const auto& event : path.events)
            if (!std::isfinite(event.start) || !std::isfinite(event.end) || event.start < 0 || event.end < 0)
                throw std::invalid_argument("AI route contains an invalid event window");
        Line line;
        line.arc.push_back(0);
        for (std::size_t i = 0; i < path.points.size(); ++i) {
            if (!finite(path.points[i]))
                throw std::invalid_argument("AI route contains an invalid point");
            line.bounds.add(path.points[i]);
            if (i)
                line.arc.push_back(line.arc.back() + ground_length(path.points[i] - path.points[i - 1]));
        }
        lines_.push_back(std::move(line));
    }
}

bool AiNetwork::rideable(std::size_t path) const {
    return path < lines_.size() && paths_.ai[path].points.size() >= 2 && lines_[path].arc.back() > 1e-6;
}

AiProjection AiNetwork::project(std::size_t path, Vec3 position, std::optional<std::size_t> segment) const {
    if (!rideable(path) || !finite(position))
        throw std::invalid_argument("Invalid AI projection request");
    const auto& points = paths_.ai[path].points;
    const auto& arc = lines_[path].arc;
    const auto begin = segment ? std::min(*segment, points.size() - 2) : 0;
    const auto initial = points[begin + 1] - points[begin];
    const auto initial_span = arc[begin + 1] - arc[begin];
    const auto foot = initial_span > 1e-9
                          ? std::clamp(ground_dot(position - points[begin], initial) / initial_span, 0., initial_span)
                          : 0.;
    const auto search_end = arc[begin] + foot + 30;
    AiProjection best{path, begin, arc[begin], std::numeric_limits<double>::infinity(), arc.back()};
    for (auto i = begin; i + 1 < points.size(); ++i) {
        if (segment && arc[i] > search_end)
            break;
        const auto delta = points[i + 1] - points[i];
        const auto span = arc[i + 1] - arc[i];
        if (span < 1e-9)
            continue;
        const auto raw = ground_dot(position - points[i], delta) / (span * span);
        const auto t = std::clamp(raw, 0., 1.);
        const auto point = points[i] + delta * t;
        const auto distance = ground_length(position - point);
        const auto interior = raw >= 0 && raw < 1;
        if (distance < best.distance || (segment && interior))
            best = {path,
                    i,
                    arc[i] + span * t,
                    distance,
                    arc.back(),
                    point,
                    normalized(Vec3{delta.x, 0, delta.z}, {0, 0, -1})};
        if (segment && interior)
            break;
    }
    return best;
}

Vec3 AiNetwork::point(std::size_t path, double station) const {
    if (!rideable(path) || !std::isfinite(station))
        throw std::invalid_argument("Invalid AI path station");
    const auto& arc = lines_[path].arc;
    const auto& points = paths_.ai[path].points;
    station = std::max(0., station);
    const auto found = std::upper_bound(arc.begin(), arc.end(), station);
    auto i = found == arc.end() ? points.size() - 2 : std::size_t(found - arc.begin() - 1);
    while (i && arc[i + 1] - arc[i] < 1e-9)
        --i;
    const auto span = arc[i + 1] - arc[i];
    return span > 1e-9 ? points[i] + (points[i + 1] - points[i]) * ((station - arc[i]) / span) : points.back();
}

std::optional<AiProjection> AiNetwork::choose(Vec3 position, double mood, std::optional<std::size_t> exclude,
                                              bool respawnable) const {
    if (!finite(position) || !std::isfinite(mood) || mood < 0 || mood > 100)
        throw std::invalid_argument("Invalid AI path choice");
    std::vector<std::pair<double, std::size_t>> candidates;
    for (std::size_t i = 0; i < lines_.size(); ++i)
        if (rideable(i) && i != exclude && (!respawnable || paths_.ai[i].respawnable))
            candidates.emplace_back(box_distance(lines_[i].bounds, position), i);
    std::stable_sort(candidates.begin(), candidates.end());
    std::vector<std::pair<double, AiProjection>> nearest;
    for (const auto [lower_bound, path] : candidates) {
        if (nearest.size() == 6 && lower_bound * lower_bound > nearest.back().first)
            break;
        const auto& points = paths_.ai[path].points;
        const auto& arc = lines_[path].arc;
        double closest = std::numeric_limits<double>::infinity();
        AiProjection projection;
        for (std::size_t i = 0; i + 1 < points.size(); ++i) {
            const auto delta = points[i + 1] - points[i];
            const auto square = dot(delta, delta);
            if (square < 1e-12)
                continue;
            const auto t = std::clamp(dot(position - points[i], delta) / square, 0., 1.);
            const auto point = points[i] + delta * t, offset = position - point;
            if (dot(offset, offset) < closest) {
                closest = dot(offset, offset);
                projection = {path,
                              i,
                              arc[i] + (arc[i + 1] - arc[i]) * t,
                              ground_length(offset),
                              arc.back(),
                              point,
                              normalized(Vec3{delta.x, 0, delta.z}, {0, 0, -1})};
            }
        }
        nearest.emplace_back(closest, projection);
        std::stable_sort(nearest.begin(), nearest.end(),
                         [](const auto& a, const auto& b) { return a.first < b.first; });
        if (nearest.size() > 6)
            nearest.resize(6);
    }
    std::optional<AiProjection> best;
    double best_cost = std::numeric_limits<double>::infinity();
    for (const auto& candidate : nearest) {
        const auto& projection = candidate.second;
        const auto path = projection.path;
        if (projection.total - projection.station <= 2)
            continue;
        const auto near = projection.point - position, target = point(path, projection.station + 8) - position;
        // [Trailmap: 395-score] Squared centimetres become squared metres.
        const auto cost =
            dot(near, near) + dot(target, target) - (100 - std::abs(double(paths_.ai[path].rating) - mood)) * 2.318936;
        if (cost < best_cost) {
            best_cost = cost;
            best = projection;
        }
    }
    return best;
}

AiInput::AiInput(std::shared_ptr<const AiNetwork> network, std::optional<std::size_t> start)
    : network_(std::move(network)) {
    if (!network_)
        throw std::invalid_argument("AI input needs a course network");
    placed(start);
}

void AiInput::placed(std::optional<std::size_t> path) {
    if (path && *path >= network_->paths().ai.size())
        throw std::invalid_argument("Invalid AI start path");
    path_ = path && network_->rideable(*path) ? path : std::nullopt;
    segment_.reset();
    status_.progress.reset();
    status_.rival.reset();
    last_station_ = reselect_ = 0;
    charge_ = false;
}

RideInput AiInput::step(const Rider& rider, const AiContext& context, double seconds) {
    if (!finite(rider.position) || !finite(rider.velocity) || !finite(rider.forward) || !finite(rider.board_up) ||
        !std::isfinite(seconds) || seconds <= 0 || seconds > .1 || !std::isfinite(context.meter) || context.meter < 0 ||
        context.meter > 1 || context.peers.size() > 17)
        throw std::invalid_argument("Invalid AI input sample");
    if (context.reference && (!finite(context.reference->position) || !finite(context.reference->velocity)))
        throw std::invalid_argument("Invalid AI reference rider");
    ++ticks_;
    reselect_ = std::max(0., reselect_ - seconds);
    status_.mood = context.meter < .31 ? 100 : context.place == 0 ? 0 : 50;
    status_.avoiding = false;
    if (!path_)
        if (const auto choice = network_->choose(rider.position, status_.mood)) {
            path_ = choice->path;
            segment_ = choice->segment;
        }
    RideInput input;
    if (!path_)
        return input;
    auto progress = network_->project(*path_, rider.position, segment_);
    if (!status_.progress)
        last_station_ = progress.station;
    auto target = network_->point(*path_, progress.station + 8);
    const auto forward = normalized(project(rider.forward * double(rider.lead), rider.board_up), {0, 0, -1});
    const auto aim = project(target - rider.position, rider.board_up);
    const bool ended = progress.total - progress.station <= 2 ||
                       std::any_of(network_->paths().ai[*path_].events.begin(),
                                   network_->paths().ai[*path_].events.end(), [&](const auto& event) {
                                       return event.type == 300 && overlaps(event, last_station_, progress.station);
                                   });
    const bool lost = rider.grounded && (progress.distance > 5 || dot(aim, forward) < 0);
    if (ended || (lost && reselect_ <= 0)) {
        reselect_ = 1;
        if (const auto choice = network_->choose(rider.position, status_.mood, ended ? path_ : std::nullopt)) {
            if (choice->path != *path_) {
                ++status_.path_changes;
                charge_ = false;
                last_station_ = choice->station;
            }
            path_ = choice->path;
            progress = *choice;
            target = network_->point(*path_, progress.station + 8);
        }
    }
    segment_ = progress.segment;
    const auto path_heading = progress.forward;
    double scale = 1;
    if (context.reference) {
        const auto gap = ground_dot(context.reference->position - rider.position, path_heading);
        if (gap > 5.1734)
            scale = std::min(1.5, 1 + .5 * (gap - 5.1734) / 5.1734);
        else if (gap < -5.1734)
            scale = .7;
    }
    status_.time_scale = approach(status_.time_scale, scale, .008444 * seconds * 60);
    const AiPeer* rival = nullptr;
    for (const auto& peer : context.peers) {
        if (!finite(peer.position) || !finite(peer.velocity))
            throw std::invalid_argument("Invalid AI competitor sample");
        if (peer.id == status_.rival)
            rival = &peer;
    }
    if (rival && (progress.distance > 6 || ground_length(rival->position - rider.position) > 10.5))
        rival = nullptr;
    if (ticks_ % 12 == 0 && progress.distance <= 5.4) {
        double best = std::numeric_limits<double>::infinity();
        for (const auto& peer : context.peers) {
            const auto delta = peer.position - rider.position;
            const auto distance = ground_length(delta);
            if (peer.id == context.id || distance > 7)
                continue;
            const auto angle = std::atan2(dot(delta, cross(rider.board_up, forward)), dot(delta, forward));
            const auto cost = distance * (1 + std::abs(angle) / pi);
            if (cost < best) {
                best = cost;
                rival = &peer;
            }
        }
    }
    status_.rival = rival ? std::optional(rival->id) : std::nullopt;
    if (rival && ground_length(rider.velocity) > ground_length(rival->velocity)) {
        const auto delta = rival->position - rider.position;
        const auto distance = ground_length(delta);
        const auto side = ground_dot(delta, cross(Vec3{0, 1, 0}, path_heading));
        const auto bearing = std::atan2(side, ground_dot(delta, path_heading));
        const auto clearance = std::atan2(1.5, std::max(distance, .01));
        if (std::abs(bearing) < clearance) {
            const auto turn = side == 0 ? (context.id < rival->id ? -1 : 1) : (side > 0 ? -1 : 1);
            target =
                rider.position + rotate(target - rider.position, {0, 1, 0}, turn * (clearance - std::abs(bearing)));
            status_.avoiding = true;
        }
    }
    const auto direction = project(target - rider.position, rider.board_up);
    const auto angle = std::atan2(dot(direction, cross(rider.board_up, forward)), dot(direction, forward));
    const auto magnitude = std::abs(angle) * 6.2897;
    input.steer = magnitude < .2 ? 0 : std::copysign(std::round(std::min(magnitude, .9705) * 31) / 31, angle);
    input.posture = ground_length(rider.velocity) < 30 / 3.6 ? 1 : 1 / 2.2116;
    input.boost = context.meter >= .999;
    if (rider.grounded || rider.motion == Motion::Rail) {
        const auto reach = charge_ ? .5 : 3.;
        const auto& events = network_->paths().ai[*path_].events;
        const auto marker = std::find_if(events.begin(), events.end(), [&](const auto& event) {
            return event.type == 100 && overlaps(event, last_station_, progress.station + reach);
        });
        charge_ = marker != events.end() && (charge_ || (marker->start > progress.station &&
                                                         progress.distance <= 1.531 && std::abs(input.steer) < .536));
        input.jump = charge_;
        if (charge_) {
            const auto target_speed = (marker->value >> 2) / 3.6;
            const auto speed = ground_length(rider.velocity);
            input.boost = speed < target_speed - 5 / 3.6;
            if (speed > target_speed + 5 / 3.6)
                input.posture = -1;
        }
    } else {
        charge_ = false;
        input.posture = 0;
    }
    last_station_ = progress.station;
    status_.progress = progress;
    status_.target = target;
    status_.steer = input.steer;
    status_.charging = charge_;
    return input;
}
} // namespace openslope
