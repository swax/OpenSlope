#include "openslope/surface_spray.hpp"
#include "openslope/player.hpp"
#include "surface_spray.hpp"
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
const std::array<SurfaceSprayRow, 20>& surface_spray_rows() {
    static const auto rows = [] {
        const auto doc = nlohmann::json::parse(std::begin(bundled::surface_spray), std::end(bundled::surface_spray));
        if (doc.at("schema") != "openslope-surface-spray/v1" || doc.at("version") != 1 || doc.at("rows").size() != 20)
            throw std::runtime_error("Unsupported surface spray contract");
        std::array<SurfaceSprayRow, 20> result;
        for (unsigned i = 0; i < 20; ++i) {
            const auto& r = doc.at("rows")[i];
            result[i] = {r.at("type"),    r.at("rate"),   r.at("sizeUnits"), r.at("fadeMin"),
                         r.at("fadeMax"), r.at("sprite"), r.at("alpha")};
            const auto& s = result[i];
            if (s.type != int(i) || !std::isfinite(s.rate) || s.rate < 0 || s.rate > 10 ||
                !std::isfinite(s.size_units) || s.size_units < 0 || s.size_units > 100 || !std::isfinite(s.fade_min) ||
                !std::isfinite(s.fade_max) || s.fade_min <= 0 || s.fade_min > s.fade_max || s.fade_max > 10 ||
                s.texture >= particle_sprite_names().size() || !std::isfinite(s.alpha) || s.alpha < 0 || s.alpha > 1)
                throw std::runtime_error("Invalid surface spray row");
        }
        return result;
    }();
    return rows;
}

bool spark_surface(int type) { return type == 9 || type == 13 || type == 14 || type == 18; }

double SurfaceSpray::random() {
    random_ ^= random_ << 13;
    random_ ^= random_ >> 17;
    random_ ^= random_ << 5;
    return double(random_) / 4294967296.;
}

SurfaceSpray::Burst& SurfaceSpray::allocate(std::optional<unsigned>& tick_slot, Kind kind, unsigned count,
                                            unsigned texture, double fade, double opacity, bool flare) {
    if (!tick_slot) {
        tick_slot = cursor_++ % unsigned(ring_.size());
        auto& reused = ring_[*tick_slot];
        for (auto* previous : {&reused.surface, &reused.sparks}) {
            previous->kind = Kind::Empty;
            previous->dots.clear();
        }
    }
    auto& record = ring_[*tick_slot];
    auto& slot = kind == Kind::Spark ? record.sparks : record.surface;
    slot.kind = kind;
    slot.age = slot.previous = 0;
    slot.fade = fade;
    slot.opacity = opacity;
    slot.texture = texture;
    slot.flare = flare;
    slot.dots.clear();
    slot.dots.resize(count);
    if (kind == Kind::Chunk)
        chunks_emitted_ += count;
    if (kind == Kind::Puff)
        puffs_emitted_ += count;
    if (kind == Kind::Spark)
        sparks_emitted_ += count;
    return slot;
}

void SurfaceSpray::reset() {
    for (unsigned bank = 0; bank < 2; ++bank)
        for (auto& record : ring_) {
            auto& slot = bank ? record.sparks : record.surface;
            slot.kind = Kind::Empty;
            slot.dots.clear();
        }
    cursor_ = flares_ = 0;
    chunks_emitted_ = puffs_emitted_ = sparks_emitted_ = 0;
    random_ = 0x5c4a713u;
    air_rate_ = 0;
    rail_spawn_.reset();
}

void SurfaceSpray::step(const Rider& before, const Rider& after, double dt, std::optional<Vec3> contact) {
    if (!std::isfinite(dt) || dt < 0 || dt > .1 || !finite(before.position) || !finite(after.position) ||
        !finite(after.velocity) || !finite(after.normal) || !finite(after.forward) || !std::isfinite(after.lean) ||
        !std::isfinite(after.slide) || !std::isfinite(after.lift) || length(after.velocity) > 1000 ||
        (contact && !finite(*contact)))
        throw std::invalid_argument("Invalid surface spray tick");
    if (dt == 0)
        return;
    if (length(after.position - before.position) > 5)
        reset();
    for (unsigned bank = 0; bank < 2; ++bank)
        for (auto& record : ring_) {
            auto& slot = bank ? record.sparks : record.surface;
            slot.previous = slot.age;
            slot.age += dt;
            if (slot.kind != Kind::Empty && slot.age > slot.fade + (slot.kind == Kind::Spark ? .03 : 0)) {
                slot.kind = Kind::Empty;
                slot.dots.clear();
            }
        }
    std::optional<unsigned> tick_slot;
    const bool ground = after.grounded && after.motion == Motion::Ground, rail = after.motion == Motion::Rail;
    if (!rail)
        rail_spawn_.reset();
    const bool air = !after.grounded && after.motion == Motion::Air;
    const auto speed = length(after.velocity), lean = std::clamp(after.lean, -1., 1.);
    const auto normal = normalized(after.normal),
               forward = normalized(project(after.forward * double(after.lead), normal), {0, 0, -1});
    const auto side = normalized(cross(normal, forward), {1, 0, 0});
    const auto origin =
        ground && contact ? *contact + normal * .02 : after.position + normal * (after.lift + .02) + side * after.slide;
    const auto scatter = [&] { return side * ((random() - .5) * .3) + forward * ((random() - .5) * 1.8); };
    const auto& row = surface_spray_rows()[after.surface >= 0 && after.surface < 20 ? after.surface : 15];
    // [Trailmap: 380-spray-gate] The native metre speed is converted once from
    // the specified centimetre-space motion term. One tick allocates one slot.
    if (ground && !spark_surface(after.surface)) {
        const auto count =
            unsigned(std::min(64., std::trunc(speed * .6 * (1 + 149 * lean * lean) * row.rate * dt + random())));
        if (count) {
            auto& slot = allocate(tick_slot, Kind::Chunk, count, row.texture, row.fade_max, row.alpha);
            const auto raw = std::abs(lean) * 1.1 * speed;
            const auto throw_speed = raw > 4.5 ? 4.5 + (raw - 4.5) * .5 : raw;
            const auto spread = raw > 4.5 ? std::max(0., throw_speed - 1.5) : 3.;
            const auto angle = std::abs(lean) * pi * .5;
            const auto outward = side * (lean >= 0 ? -std::cos(angle) : std::cos(angle)) + normal * std::sin(angle);
            for (auto& dot : slot.dots) {
                dot.position = origin + scatter();
                dot.velocity = after.velocity * random() + outward * (throw_speed + (random() - .5) * spread);
                dot.radius = float(row.size_units * .035 * .5 * (.8 + .4 * random()));
            }
        }
    }
    if (air || (rail && !spark_surface(after.surface))) {
        if (before.motion != Motion::Air || before.grounded || air_rate_ == 0)
            air_rate_ = 70;
        const auto count =
            unsigned(std::min(64., std::trunc((air ? air_rate_ * std::min(1., speed / 2.8) : 30.) * dt + random())));
        if (count) {
            // [Trailmap: 380-burst] Size/opacity are an explicit native puff profile.
            auto& slot = allocate(tick_slot, Kind::Puff, count, 13, .6, .2);
            for (auto& dot : slot.dots) {
                dot.position = origin - forward * .8 + scatter() * .3;
                dot.velocity = after.velocity + side * ((random() - .5) * 4) + forward * ((random() - .5) * 4);
                dot.radius = float(.12 + .04 * random());
            }
        }
        air_rate_ = std::max(10., air_rate_ * std::pow(.947, dt * 60));
    } else
        air_rate_ = 0;
    if ((rail || (ground && spark_surface(after.surface))) && speed > .3) {
        // [Trailmap: 380-sparks] Throw follows travel, independent of which end
        // of a switch deck leads. Seven tapered copies are reconstructed at draw.
        const bool flare = random() < dt;
        const auto count =
            flare ? 17u + unsigned(random() * 2) : unsigned(std::min(18., std::trunc(dt * 60 + random())));
        if (count) {
            const auto f = (flare ? 3 : 2) * std::min(speed, 16.7);
            auto& slot = allocate(tick_slot, Kind::Spark, count, 0, flare ? .65 : .25, .63, flare);
            flares_ += flare;
            const auto centre = origin + after.velocity * (rail ? .04 : .02);
            const auto along = normalized(after.velocity, forward);
            for (auto& dot : slot.dots) {
                const auto at = rail && rail_spawn_ ? *rail_spawn_ + (centre - *rail_spawn_) * random() : centre;
                dot.position = at + scatter();
                dot.velocity = normal * (.05 * f + (random() - .5) * .4 * f) - along * (.1 * f) +
                               side * ((random() - .5) * 2 * std::min(.35 * f, 11.)) +
                               forward * ((random() - .5) * .4 * f);
                dot.radius = float(.015 + .005 * random());
                dot.colour = {1, float(.5 + .4 * random()), .02f};
            }
            if (rail)
                rail_spawn_ = centre;
        }
    } else
        rail_spawn_.reset();
}

std::vector<ParticleSprite> SurfaceSpray::draw(double alpha) const {
    if (!std::isfinite(alpha) || alpha < 0 || alpha > 1)
        throw std::invalid_argument("Invalid spray interpolation");
    std::vector<ParticleSprite> result;
    const auto live = stats();
    result.reserve(live.surface_sprites + live.puffs + live.sparks * 7);
    for (unsigned bank = 0; bank < 2; ++bank)
        for (const auto& record : ring_) {
            const auto& slot = bank ? record.sparks : record.surface;
            if (slot.kind == Kind::Empty)
                continue;
            const auto age = slot.previous + (slot.age - slot.previous) * alpha;
            const auto copies = slot.kind == Kind::Spark ? 7u : 1u;
            for (const auto& dot : slot.dots)
                for (unsigned copy = 0; copy < copies; ++copy) {
                    const auto time = age - copy * .005;
                    if (time < 0 || time >= slot.fade)
                        continue;
                    const auto phase = time / slot.fade;
                    const auto q = std::min(time, slot.kind == Kind::Spark ? 2.7 / 12 : 2.7 / 5);
                    const auto motion = .73 * q - .113 * (slot.kind == Kind::Spark ? 12 : 5) * q * q;
                    const auto gravity = slot.kind == Kind::Spark ? -10 * time * time : -.3 * time * time;
                    auto colour = dot.colour;
                    if (slot.kind == Kind::Spark)
                        colour[2] += float(.88 * phase);
                    result.push_back({dot.position + dot.velocity * motion + Vec3{0, gravity, 0},
                                      dot.radius,
                                      {colour[0], colour[1], colour[2],
                                       float(slot.opacity * (1 - phase) * (copies - copy) / copies)},
                                      slot.texture,
                                      slot.kind == Kind::Chunk ? ParticleBlend::Alpha : ParticleBlend::Additive});
                }
        }
    return result;
}

SurfaceSpray::Stats SurfaceSpray::stats() const {
    Stats result;
    result.flares = flares_;
    result.chunks_emitted = chunks_emitted_;
    result.puffs_emitted = puffs_emitted_;
    result.sparks_emitted = sparks_emitted_;
    for (const auto& record : ring_) {
        const auto& slot = record.surface;
        result.slots += slot.kind != Kind::Empty || record.sparks.kind != Kind::Empty;
        if (slot.kind == Kind::Chunk) {
            ++result.surface_slots;
            result.surface_sprites += unsigned(slot.dots.size());
        }
        if (slot.kind == Kind::Puff) {
            ++result.puff_slots;
            result.puffs += unsigned(slot.dots.size());
        }
    }
    for (const auto& record : ring_)
        if (const auto& slot = record.sparks; slot.kind == Kind::Spark) {
            ++result.spark_slots;
            result.sparks += unsigned(slot.dots.size());
        }
    return result;
}
} // namespace openslope
