#include "openslope/riding_effects.hpp"
#include "openslope/import.hpp"
#include "openslope/player.hpp"
#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
std::string riding_sprite(const std::filesystem::path& root, const char* slot) {
    if (root.empty() || !std::filesystem::exists(root / "RidingEffects.json"))
        return {};
    if (std::filesystem::file_size(root / "RidingEffects.json") > 65536)
        throw std::runtime_error("Riding effect profile exceeds its limit");
    std::ifstream file(root / "RidingEffects.json");
    const auto profile = nlohmann::json::parse(file);
    if (profile.value("Schema", "") != "openslope-riding-effects/v1")
        throw std::runtime_error("Unsupported riding effect profile");
    if (!profile.value("Enabled", true) || !profile.contains(slot))
        return {};
    const auto name = profile.at(slot).get<std::string>();
    if (!valid_map_name(name))
        throw std::runtime_error("Unsafe riding sprite filename");
    return name;
}

double wake_fade(int surface) {
    // [Trailmap: 380-wake-table] Separate from the surface response records.
    switch (surface) {
    case 1:
    case 2:
    case 8:
    case 15:
    case 16: return .0286;
    case 3:
    case 4: return .0167;
    case 5: return .1998;
    default: return 0;
    }
}

void RidingEffects::reset() {
    surface_spray_.reset();
    puffs_.clear();
    sprites_.clear();
    wake_.clear();
    wake_mesh_.clear();
    wake_active_ = false;
    wake_distance_ = wake_along_ = 0;
    sheet_.clear();
    sheet_mesh_.clear();
    sheet_active_ = false;
    sheet_side_ = 0;
    sheet_distance_ = sheet_along_ = 0;
    random_ = 0x73421u;
    distance_ = landing_activity_ = followup_ = 0;
    carve_emitted_ = landing_emitted_ = powder_count_ = 0;
}

void RidingEffects::end_wake() {
    if (wake_active_) {
        for (std::size_t i = 0; i < std::min(std::size_t(4), wake_.size()); ++i) {
            auto& s = wake_[wake_.size() - 1 - i];
            s.alpha *= double(i) / 4;
            if (!s.join)
                break;
        }
    }
    wake_active_ = false;
    wake_distance_ = 0;
}

void RidingEffects::wake_tick(const Rider& before, const Rider& after, double dt, const WakeProbe& probe) {
    for (auto& s : wake_)
        s.alpha = std::max(0., s.alpha - s.fade * dt);
    while (!wake_.empty() && wake_.front().alpha <= 0)
        wake_.erase(wake_.begin());
    const auto normal = normalized(after.normal),
               side = normalized(cross(after.forward * double(after.lead), normal), {1, 0, 0});
    const auto start = before.position +
                       normalized(cross(normalized(before.normal), before.forward * double(before.lead)), -side) *
                           before.slide,
               end = after.position - side * after.slide;
    const auto travel = length(end - start);
    const bool gate = after.grounded && after.motion == Motion::Ground && wake_fade(after.surface) > 0 &&
                      length(project(after.velocity, normal)) > .3 && bool(probe);
    if (!gate)
        end_wake();
    else {
        // Width, spacing and the scalar's per-second fade interpretation are
        // application tuning pending exact clean-spec bindings.
        const auto width = .28 + .62 * std::min(1., std::abs(after.lean));
        const auto sample = [&](Vec3 at, bool join) {
            const auto centre = probe(at);
            if (!centre || !finite(centre->position) || !finite(centre->normal) || wake_fade(centre->surface) <= 0)
                return false;
            const auto left = probe(centre->position - side * (width * .5)),
                       right = probe(centre->position + side * (width * .5));
            const auto valid = [&](const std::optional<WakeContact>& p) {
                return p && finite(p->position) && finite(p->normal) && wake_fade(p->surface) > 0 &&
                       dot(normalized(p->normal), normalized(centre->normal)) > .75 &&
                       std::abs(dot(p->position - centre->position, normalized(centre->normal))) < .35;
            };
            if (!valid(left) || !valid(right))
                return false;
            if (wake_along_ >= 1024) {
                wake_along_ -= 1024;
                for (auto& s : wake_) {
                    s.left.along -= 1024;
                    s.right.along -= 1024;
                }
            }
            if (wake_.size() == 100)
                wake_.erase(wake_.begin());
            wake_.push_back({{left->position, normalized(left->normal), 0, float(wake_along_), 0},
                             {right->position, normalized(right->normal), 1, float(wake_along_), 0},
                             .7,
                             wake_fade(centre->surface),
                             join && !wake_.empty()});
            return true;
        };
        if (travel > 5) {
            end_wake();
            wake_along_ = 0;
            wake_active_ = sample(end, false);
        } else {
            const bool steady = before.grounded && before.motion == Motion::Ground && wake_fade(before.surface) > 0;
            const bool advance = wake_active_ || steady;
            if (!wake_active_) {
                wake_along_ = 0;
                wake_active_ = sample(steady ? start : end, false);
            }
            if (advance && wake_active_ && travel > 1e-9) {
                double at = .5 - wake_distance_;
                while (at <= travel + 1e-9) {
                    wake_along_ += .5;
                    if (!sample(start + (end - start) * std::min(1., at / travel), true)) {
                        end_wake();
                        break;
                    }
                    at += .5;
                }
                if (wake_active_)
                    wake_distance_ = std::clamp(travel - (at - .5), 0., .5 - 1e-9);
            }
        }
    }
    wake_mesh_.clear();
    wake_mesh_.reserve(594);
    for (std::size_t i = 1; i < wake_.size(); ++i) {
        const auto& a = wake_[i - 1];
        const auto& b = wake_[i];
        if (!b.join || (a.alpha <= 0 && b.alpha <= 0))
            continue;
        auto left = a.left, right = a.right, next_left = b.left, next_right = b.right;
        left.alpha = right.alpha = float(a.alpha);
        next_left.alpha = next_right.alpha = float(b.alpha);
        wake_mesh_.insert(wake_mesh_.end(), {left, right, next_right, left, next_right, next_left});
    }
}

void RidingEffects::sheet_tick(const Rider& before, const Rider& after, double dt, const WakeProbe& probe) {
    for (auto& c : sheet_)
        c.age += dt;
    std::erase_if(sheet_, [](const auto& c) { return c.age >= .9; });
    // [Trailmap: 380-spray-systems] Four rails, quarter-metre columns and
    // a fixed ground tail; the native snow-family/throw profile is provisional.
    const auto snow = [](int surface) { return (surface >= 1 && surface <= 4) || surface == 8; };
    const auto gate = [&](const Rider& p) {
        return p.grounded && p.motion == Motion::Ground && snow(p.surface) && std::abs(p.lean) > .3 &&
               length(p.velocity) > .3 && bool(probe);
    };
    const auto n = normalized(after.normal),
               travel_forward = normalized(project(after.velocity, n), after.forward * double(after.lead));
    const auto lateral = normalized(cross(n, after.forward * double(after.lead)), {-1, 0, 0});
    const auto start = before.position +
                       normalized(cross(normalized(before.normal), before.forward * double(before.lead)), lateral) *
                           before.slide,
               end = after.position + lateral * after.slide, delta = end - start;
    const auto distance = length(delta);
    const int turn = after.lean > 0 ? 1 : -1;
    if (!gate(after) || distance > 5) {
        sheet_active_ = false;
        sheet_distance_ = 0;
    } else {
        if (sheet_side_ != turn) {
            sheet_active_ = false;
            sheet_distance_ = 0;
        }
        sheet_side_ = turn;
        const auto lean = std::min(1., std::abs(after.lean)), speed = length(after.velocity);
        const auto throw_speed = 6 * (lean - .3) / .7 * std::min(1., speed / 18);
        const auto throw_velocity = normalized(n * .75 - lateral * (double(turn) * .65)) * throw_speed;
        const auto column = [&](Vec3 at, bool join, double age) {
            const auto hit = probe(at - travel_forward * .5);
            if (!hit || !finite(hit->position) || !finite(hit->normal) || !snow(hit->surface) ||
                dot(normalized(hit->normal), n) < .75)
                return false;
            if (sheet_along_ >= 1024) {
                sheet_along_ -= 1024;
                for (auto& c : sheet_)
                    c.along -= 1024;
            }
            if (sheet_.size() == 128)
                sheet_.erase(sheet_.begin());
            const auto origin = hit->position + normalized(hit->normal) * .008;
            sheet_.push_back({origin, throw_velocity, age, .08 * lean, sheet_along_,
                              join && !sheet_.empty() && length(origin - sheet_.back().origin) < 1});
            return true;
        };
        const bool steady = gate(before) && (before.lean > 0 ? 1 : -1) == turn, advance = sheet_active_ || steady;
        if (!sheet_active_) {
            sheet_along_ = 0;
            sheet_active_ = column(steady ? start : end, false, steady ? dt : 0);
        }
        if (advance && sheet_active_ && distance > 1e-9) {
            double at = .25 - sheet_distance_;
            while (at <= distance + 1e-9) {
                sheet_along_ += .25;
                const auto portion = std::min(1., at / distance);
                if (!column(start + delta * portion, true, dt * (1 - portion))) {
                    sheet_active_ = false;
                    sheet_distance_ = 0;
                    break;
                }
                at += .25;
            }
            if (sheet_active_)
                sheet_distance_ = std::clamp(distance - (at - .25), 0., .25 - 1e-9);
        }
    }
    sheet_mesh_.clear();
    sheet_mesh_.reserve(2286);
    for (std::size_t i = 0; i < sheet_.size(); ++i) {
        const auto& c = sheet_[i];
        const auto flight = (1 - std::exp(-3 * c.age)) / 3;
        const auto alpha = float(c.alpha * std::max(0., 1 - c.age / .9));
        for (unsigned rail = 0; rail < 4; ++rail) {
            const auto position =
                c.origin +
                (rail ? c.throw_velocity * (double(rail) * flight) + Vec3{0, -6 * c.age * c.age, 0} : Vec3{});
            sheet_points_[i][rail] = {position, float(c.along), float(rail) / 3, alpha};
        }
    }
    for (std::size_t i = 1; i < sheet_.size(); ++i) {
        if (!sheet_[i].join)
            continue;
        const auto& a = sheet_points_[i - 1];
        const auto& b = sheet_points_[i];
        for (unsigned rail = 0; rail < 3; ++rail)
            sheet_mesh_.insert(sheet_mesh_.end(), {a[rail], b[rail], b[rail + 1], a[rail], b[rail + 1], a[rail + 1]});
    }
}

double RidingEffects::random() {
    random_ ^= random_ << 13;
    random_ ^= random_ >> 17;
    random_ ^= random_ << 5;
    return double(random_) / 4294967296.;
}

void RidingEffects::puff(Vec3 origin, Vec3 normal, double alpha, bool landing) {
    if (puffs_.size() == 512)
        puffs_.erase(puffs_.begin());
    puffs_.push_back({origin, normal, 0, alpha, random() * 2 * pi, landing});
    if (landing)
        ++landing_emitted_;
    else
        ++carve_emitted_;
}

void RidingEffects::tick(const Rider& before, const Rider& after, double dt, const WakeProbe& probe) {
    if (!std::isfinite(dt) || dt < 0 || dt > .1 || !finite(before.position) || !finite(before.velocity) ||
        !finite(before.normal) || !finite(before.forward) || !std::isfinite(before.slide) || !finite(after.position) ||
        !finite(after.velocity) || !finite(after.normal) || !finite(after.forward) || !std::isfinite(after.slide) ||
        !std::isfinite(after.lean))
        throw std::runtime_error("Invalid riding effect tick");
    if (dt == 0)
        return;
    std::optional<Vec3> contact;
    if (probe && after.grounded && after.motion == Motion::Ground)
        if (const auto hit = probe(after.position))
            contact = hit->position;
    surface_spray_.step(before, after, dt, contact);
    wake_tick(before, after, dt, probe);
    sheet_tick(before, after, dt, probe);
    for (auto& p : puffs_)
        p.age += dt;
    std::erase_if(puffs_, [](const auto& p) { return p.age >= 2; });
    sprites_.clear();
    powder_count_ = 0;
    const bool ground = after.grounded && after.motion == Motion::Ground,
               powder = after.surface == 3 || after.surface == 4;
    const auto speed = length(after.velocity), lean = std::min(1., std::abs(after.lean));
    const auto normal = normalized(after.normal), side = normalized(cross(normal, after.forward), {1, 0, 0});
    // [Trailmap: 380-spray-systems] Fixed world origins; only rendering curves
    // grow/lift the carve puff. Emission is distance-based, not render-based.
    if (ground && (lean > .2 || powder)) {
        distance_ += std::min(10., length(after.position - before.position));
        unsigned emitted = 0;
        while (distance_ >= .7 && emitted++ < 16) {
            distance_ -= .7;
            puff(after.position, normal, .06 * (powder ? std::max(.2, lean) : lean), false);
        }
    } else
        distance_ = 0;
    // [Trailmap: 380-landing] Immediate touchdown burst and a decaying tail.
    // Exact hidden accumulator/skid bindings remain application tuning.
    if (ground && after.landings > before.landings) {
        const auto count = unsigned(std::clamp(2 + length(before.velocity) / 3., 2., 8.));
        for (unsigned i = 0; i < count; ++i)
            puff(after.position + side * ((random() - .5) * .8) + after.forward * ((random() - .5) * .8), normal, .04,
                 true);
        landing_activity_ = std::min(1.5, length(before.velocity) / 10);
        followup_ = 0;
    }
    if (ground && speed > 10 && std::abs(dot(after.velocity, side)) > 4)
        landing_activity_ = std::max(landing_activity_, std::min(1.5, std::abs(dot(after.velocity, side)) / 10));
    if (ground && landing_activity_ > 0) {
        followup_ += dt * 24 * landing_activity_;
        if (followup_ >= 1) {
            followup_ -= 1;
            puff(after.position, normal, .02, true);
        }
        landing_activity_ = std::max(0., landing_activity_ - dt);
    } else {
        landing_activity_ = followup_ = 0;
    }
    for (const auto& p : puffs_) {
        const auto life = p.age / 2;
        const auto width = p.landing ? std::max(0., 2.4 + (5 - 2.4) * (p.age - .2) / 1.8) : 1.6 + 3.2 * p.age;
        const auto height = p.landing ? .972222222 + .638888889 * p.age : .25 * p.age;
        const auto fade = p.landing ? std::min(1., p.age / .2) * (1 - life) * (1 - life) : 1 - life;
        sprites_.push_back({p.origin + p.normal * height, float(width * .5), float(p.alpha * fade), float(p.rotation)});
    }
    // [Trailmap: 380-spray-systems] This small cloud is deliberately re-placed
    // near the board each fixed tick, independently of carve lean.
    if (ground && powder) {
        powder_count_ = unsigned(std::min(32., speed * 1.6));
        for (unsigned i = 0; i < powder_count_; ++i)
            sprites_.push_back({after.position + side * ((random() - .5) * 1.2) +
                                    after.forward * ((random() - .5) * 1.8) + normal * (.05 + random() * .3),
                                float(.15 + random() * .07), .06f, float(random() * 2 * pi)});
    }
}
} // namespace openslope
