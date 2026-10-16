#include "openslope/player.hpp"
#include "openslope/surface_spray.hpp"
#include <iostream>
#include <limits>

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void close(double a, double b, const char* message) { check(std::abs(a - b) < 1e-8, message); }

bool same(const std::vector<ParticleSprite>& a, const std::vector<ParticleSprite>& b) {
    if (a.size() != b.size())
        return false;
    for (unsigned i = 0; i < a.size(); ++i)
        if (length(a[i].position - b[i].position) > 1e-10 || a[i].radius != b[i].radius || a[i].colour != b[i].colour ||
            a[i].blend != b[i].blend || a[i].texture != b[i].texture)
            return false;
    return true;
}

Rider ground(int surface = 1, double lean = .9) {
    Rider r;
    r.grounded = true;
    r.motion = Motion::Ground;
    r.surface = surface;
    r.lean = lean;
    r.forward = {0, 0, 1};
    r.velocity = {0, 0, 18};
    return r;
}

void profiles() {
    const auto& rows = surface_spray_rows();
    check(rows.size() == 20, "All twenty surfaces have their own verified functional row");
    for (unsigned i = 0; i < 20; ++i)
        check(rows[i].type == int(i), "Surface indices are stable");
    check(rows[1].rate > .075 && rows[1].rate < .076 && rows[1].texture == 16,
          "Packed snow selects its light blb1 chunk profile");
    check(rows[2].rate > .159 && rows[2].rate < .160 && rows[2].texture == 13,
          "Off-track snow selects its medium soft-puff profile");
    check(rows[3].rate > .505 && rows[3].rate < .506 && rows[3].texture == 20,
          "Powder selects its dense twinkle profile");
    check(rows[5].rate > .199 && rows[5].rate < .201 && rows[5].texture == 15, "Ice selects small crystal shards");
    for (const auto i : {0, 4, 7, 8, 11, 12, 13, 14, 15, 16})
        check(rows[i].rate == 0, "Verified zero-rate rows remain silent");
    for (const auto i : {9, 13, 14, 18})
        check(spark_surface(i), "Hard riding surfaces select sparks");
}

void chunks() {
    SurfaceSpray fx;
    auto r = ground(3);
    fx.step(r, r, 1. / 60, Vec3{});
    const auto fresh = fx.draw();
    check(fx.stats().surface_slots == 1 && fresh.size() >= 6,
          "One powder slot preserves the gate's multiple billboards");
    for (const auto& p : fresh) {
        check(p.blend == ParticleBlend::Alpha && p.texture == 20,
              "Powder chunks use alpha-over and the shared twinkle art");
        check(p.radius * 2 >= .22 && p.radius * 2 <= .34, "Powder size uses the record with twenty-percent variation");
        close(p.colour[3], surface_spray_rows()[3].alpha, "Birth opacity uses the material row");
    }
    const auto stats = fx.stats();
    fx.step(r, r, 0);
    check(same(fresh, fx.draw()) && fx.stats().chunks_emitted == stats.chunks_emitted,
          "Pause changes neither the field nor its randomness");
    auto stopped = r;
    stopped.motion = Motion::OnFoot;
    fx.step(r, stopped, .1);
    const auto flying = fx.draw();
    check(flying.size() == fresh.size(), "Dismount stops emission and lets existing chunks finish");
    Vec3 mean{};
    for (unsigned i = 0; i < fresh.size(); ++i)
        mean += flying[i].position - fresh[i].position;
    check(mean.x < 0 && mean.y > 0 && mean.z > 0, "A positive carve throws up and out with forward momentum");
    const auto held = fx.draw(.25);
    check(same(held, fx.draw(.25)), "Repeated eye draws do not mutate the simulation");
    check(!same(held, fx.draw(.75)), "Motion interpolates smoothly between fixed ticks");
    for (unsigned i = 0; i < 10; ++i)
        fx.step(stopped, stopped, .1);
    check(fx.draw().empty(), "Surface alpha expires at the row's fade time");
    fx.reset();
    fx.step(r, r, 1. / 60, Vec3{});
    check(same(fresh, fx.draw()), "Reset reproduces the first deterministic emission");
    SurfaceSpray other;
    r.lean = -.9;
    other.step(r, r, 1. / 60, Vec3{});
    const auto opposite = other.draw();
    stopped = r;
    stopped.motion = Motion::OnFoot;
    other.step(r, stopped, .1);
    const auto moved = other.draw();
    Vec3 reverse{};
    for (unsigned i = 0; i < opposite.size(); ++i)
        reverse += moved[i].position - opposite[i].position;
    check(reverse.x > 0 && reverse.y > 0, "The other carve throws to the other side while retaining lift");
    for (int type = 0; type < 20; ++type) {
        SurfaceSpray row;
        auto s = ground(type);
        for (unsigned tick = 0; tick < 60; ++tick)
            row.step(s, s, 1. / 60);
        check(row.stats().surface_slots <= 40 && row.stats().surface_sprites <= 40 * 64,
              "Every surface stays inside the fixed ring budget");
        if (surface_spray_rows()[type].rate == 0 || spark_surface(type))
            check(row.stats().chunks_emitted == 0, "Zero-rate and hard surfaces emit no snow chunks");
    }
    SurfaceSpray straight;
    auto s = ground(1, 0);
    for (unsigned tick = 0; tick < 600; ++tick)
        straight.step(s, s, 1. / 60);
    check(straight.stats().chunks_emitted >= 2 && straight.stats().chunks_emitted < 20,
          "Straight packed snow has only a near-one-per-second trickle");
    SurfaceSpray buried;
    s = ground(3);
    s.position.y = -.3;
    buried.step(s, s, 1. / 60, Vec3{});
    for (const auto& p : buried.draw())
        check(p.position.y >= .019, "Chunks leave the visible contact even when the deck is buried in powder");
}

void air_and_sparks() {
    auto a = ground(), b = a;
    b.grounded = false;
    b.motion = Motion::Air;
    b.velocity = {0, 6, 14};
    SurfaceSpray air;
    for (unsigned i = 0; i < 30; ++i) {
        air.step(a, b, 1. / 60);
        a = b;
    }
    const auto early = air.stats().puffs_emitted;
    check(early >= 12 && early < 40, "Takeoff starts with a dense burst of puffs");
    for (unsigned i = 0; i < 90; ++i)
        air.step(b, b, 1. / 60);
    const auto start = air.stats().puffs_emitted;
    for (unsigned i = 0; i < 60; ++i)
        air.step(b, b, 1. / 60);
    check(air.stats().puffs_emitted - start < early && air.stats().puffs_emitted - start >= 3,
          "Long airtime decays toward the small steady puff rate");
    for (const auto& p : air.draw())
        check(p.texture == 13 && p.blend == ParticleBlend::Additive, "Air puffs use additive swp2");
    auto foot = b;
    foot.motion = Motion::OnFoot;
    const auto count = air.stats().puffs_emitted;
    for (unsigned i = 0; i < 90; ++i)
        air.step(foot, foot, 1. / 60);
    check(air.draw().empty() && air.stats().puffs_emitted == count,
          "Walking and free flight do not emit board takeoff puffs");
    for (const auto surface : {1, 9, 13, 14, 18}) {
        SurfaceSpray sparks;
        auto r = ground(surface, 0);
        if (surface == 1)
            r.motion = Motion::Rail;
        for (unsigned i = 0; i < 12; ++i)
            sparks.step(r, r, 1. / 60);
        const auto dots = sparks.draw();
        check(sparks.stats().sparks >= 6 && sparks.stats().surface_sprites == 0,
              "Rails and hard contacts spark without snow chunks");
        const auto additive = std::count_if(dots.begin(), dots.end(), [](const auto& p) { return p.texture == 0; });
        check(additive > int(sparks.stats().sparks * 2), "Each established spark draws a tapered comet trail");
        for (const auto& p : dots) {
            check(p.radius <= .16 && p.colour[3] > 0 && p.colour[3] <= .63f,
                  "Spark/puff sizes and opacity remain bounded");
            if (p.texture == 0)
                check(p.blend == ParticleBlend::Additive && p.colour[0] > .99,
                      "Sparks retain their bright warm red component");
        }
    }
    SurfaceSpray flare;
    auto metal = ground(13, 0);
    for (unsigned i = 0; i < 6000; ++i) {
        flare.step(metal, metal, 1. / 60);
        if (i % 20 == 0)
            check(flare.draw().size() <= SurfaceSpray::maximum_sprites, "Flare storms retain the bounded draw budget");
    }
    check(flare.stats().flares >= 60 && flare.stats().flares <= 140,
          "The fixed seed produces about one flare per second");
    auto idle = metal;
    idle.velocity = {};
    SurfaceSpray stopped;
    for (unsigned i = 0; i < 60; ++i)
        stopped.step(idle, idle, 1. / 60);
    check(stopped.draw().empty(), "Stationary metal does not sparkle");
    SurfaceSpray reentry;
    auto old_rail = ground(13, 0);
    old_rail.motion = Motion::Rail;
    reentry.step(old_rail, old_rail, 1. / 60);
    auto hard = ground(13, 0);
    hard.position.z = 4;
    for (unsigned i = 0; i < 45; ++i)
        reentry.step(hard, hard, 1. / 60);
    auto next_rail = hard;
    next_rail.motion = Motion::Rail;
    reentry.step(hard, next_rail, 1. / 60);
    unsigned fresh = 0;
    for (const auto& p : reentry.draw())
        if (p.texture == 0 && p.colour[3] == .63f) {
            ++fresh;
            check(p.position.z >= 4 + 18 * .04 - .9 - 1e-8,
                  "Reentering a rail cannot bridge back to its old spark spawn point");
        }
    check(fresh > 0, "Rail reentry produces a new contact sample");
    SurfaceSpray transitions;
    for (unsigned tick = 0; tick < 600; ++tick) {
        auto state = ground(tick % 9 < 5 ? 3 : 1);
        state.velocity = {0, 0, 1000};
        if (state.surface == 1)
            state.motion = Motion::Rail;
        const auto previous = transitions.stats().slots;
        transitions.step(state, state, .005);
        const auto live = transitions.stats();
        check(live.slots <= 40 && live.slots <= previous + 1,
              "Surface changes and simultaneous rail puffs/sparks reuse one bounded slot per tick");
        check(transitions.draw().size() <= SurfaceSpray::maximum_sprites,
              "Mixed surface/rail transitions retain the global billboard bound");
    }
    SurfaceSpray teleport;
    teleport.step(metal, metal, 1. / 60);
    auto moved = metal;
    moved.position.x = 100;
    moved.motion = Motion::OnFoot;
    teleport.step(metal, moved, 1. / 60);
    check(teleport.draw().empty(), "A placement jump clears the old contact stream");
    bool rejected = false;
    try {
        teleport.draw(std::numeric_limits<double>::quiet_NaN());
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    check(rejected, "Invalid render interpolation is rejected");
}
} // namespace

int main() {
    try {
        profiles();
        chunks();
        air_and_sparks();
        std::cout << "PASS: " << checks << " surface chunk, takeoff, spark, flare, lifecycle and snapshot checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
