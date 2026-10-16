#include "openslope/player.hpp"
#include "openslope/snowfall.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool condition, const char* what) {
    ++checks;
    if (!condition)
        throw std::runtime_error(what);
}

void close(double a, double b, const char* what) { check(std::abs(a - b) < 1e-8, what); }

void close(Vec3 a, Vec3 b, const char* what) { check(length(a - b) < 1e-7, what); }
} // namespace

int main() {
    try {
        const auto port = snow_settings(3), storm = snow_settings(10);
        check(port.flakes == 600 && port.box.x == 40 && port.box.y == 34 && port.box.z == 40,
              "Default weather matches the public 600-flake play profile");
        check(port.lift == 5 && port.fall_min == 2.2 && port.fall_max == 4 && port.drift == .7,
              "Default lift, fall and wind match the documented play stop");
        check(port.size_min == .1 && port.size_max == .3 && port.alpha == .5 && port.brightness == .6 &&
                  port.softness == .55 && port.near_start == .25 && port.near_end == .6 && port.edge_fade == .2,
              "Default flake shape, intensity and fades retain the public profile");
        check(snow_settings(-1).flakes == 0 && snow_settings(0).flakes == 0 &&
                  snow_settings(20).flakes == maximum_snowflakes,
              "The weather dial clamps from clear to bounded whiteout");
        const auto thin = snow_settings(1.5);
        check(thin.flakes == 300 && thin.box.x == port.box.x && thin.drift == port.drift && thin.alpha == port.alpha,
              "Below the default stop weather thins without changing its motion");
        for (int i = 0; i < 100; ++i) {
            const auto a = snow_settings(i * .1), b = snow_settings((i + 1) * .1);
            check(a.flakes <= b.flakes && a.box.x >= b.box.x && a.drift <= b.drift && a.alpha <= b.alpha,
                  "Increasing weather adds density and wind monotonically");
            check(a.size_min == port.size_min && a.size_max == port.size_max && a.softness == port.softness,
                  "Whiteout adds snow rather than enlarging the flakes");
        }
        const auto flakes = snow_flakes(), repeat = snow_flakes(), other = snow_flakes(600, snow_seed + 1);
        check(flakes.size() == maximum_snowflakes && flakes.size() * sizeof(SnowFlake) == 2800000,
              "A bounded 28-byte instance field is baked once");
        for (unsigned i = 0; i < flakes.size(); ++i) {
            check(flakes[i].base == repeat[i].base && flakes[i].random == repeat[i].random,
                  "A fixed seed reproduces the identical flake field");
            for (const auto x : flakes[i].base)
                check(x >= 0 && x < 1, "Baked base points stay in the unit field");
            for (const auto x : flakes[i].random)
                check(x >= 0 && x < 1, "Baked variation stays in its unit range");
        }
        check(flakes[0].base != other[0].base, "A different seed changes the field");
        for (const auto count : {200u, 600u, maximum_snowflakes})
            for (unsigned axis = 0; axis < 3; ++axis) {
                unsigned low = 0;
                for (unsigned i = 0; i < count; ++i)
                    low += flakes[i].base[axis] < .5f;
                check(std::abs(double(low) / count - .5) < .08, "Even sparse prefixes fill every field axis");
            }
        for (const auto& s : {port, storm})
            for (const auto eye : {Vec3{}, Vec3{37, -210, 88}, Vec3{-4000, 900, 12000}, Vec3{1e6, -1e6, 1e6}})
                for (const auto time : {0., 7.5, 600.})
                    for (unsigned i = 0; i < s.flakes; ++i) {
                        const auto path = snow_path(flakes[i], time, s);
                        const auto offset = snow_offset(path, snow_centre(eye, s), s);
                        check(std::abs(offset.x) <= s.box.x * .5 + 1e-8 && std::abs(offset.y) <= s.box.y * .5 + 1e-8 &&
                                  std::abs(offset.z) <= s.box.z * .5 + 1e-8,
                              "Fast travel and teleports wrap every flake into the field in one step");
                    }
        unsigned stayed = 0;
        for (unsigned i = 0; i < 600; ++i) {
            const auto p = snow_path(flakes[i], 3.5, port);
            const auto a = snow_centre({}, port), b = snow_centre({1, 0, .5}, port);
            const auto x = a + snow_offset(p, a, port), y = b + snow_offset(p, b, port);
            if (length(x - y) < 1e-6) {
                close(x, y, "Unrecycled flakes stay fixed in the world when the eye moves");
                ++stayed;
            }
        }
        check(stayed > 550, "Camera movement preserves the field's ride-through parallax");
        const Vec3 p{3, 2, -5};
        close(snow_offset(p, {}, port), snow_offset(p + Vec3{40, -34, 80}, {}, port),
              "Whole-box translations preserve the field exactly");
        close(snow_edge_scale({}, port), 1, "Central flakes keep their full size");
        for (const auto face : {Vec3{20, 0, 0}, Vec3{0, -17, 0}, Vec3{0, 0, 20}})
            close(snow_edge_scale(face, port), 0, "Flakes disappear before recycling across a face");
        close(snow_near_scale(.25, port), 0, "Near-eye flakes disappear before reaching the face");
        close(snow_near_scale(.6, port), 1, "Flakes return to full size outside the near fade");
        bool rejected = false;
        try {
            static_cast<void>(snow_settings(std::numeric_limits<double>::quiet_NaN()));
        } catch (const std::invalid_argument&) {
            rejected = true;
        }
        check(rejected, "Invalid weather values cannot reach the GPU");
        Player player(Terrain::demo());
        close(player.weather_time(), 0, "A new map begins with a fresh weather phase");
        player.advance(1. / 120, {});
        close(player.weather_time(), 1. / 120, "Weather interpolates between simulation ticks at high display rates");
        player.advance(1. / 120, {});
        close(player.weather_time(), 1. / 60, "Weather remains continuous across simulation ticks");
        const auto paused = player.weather_time();
        player.advance(0, {});
        close(player.weather_time(), paused, "A paused game does not move the snow");
        player.reset();
        close(player.weather_time(), paused, "Rider reset preserves the weather phase");
        player.restart_run();
        close(player.weather_time(), 0, "Restarting the run resets the weather clock");
        std::cout << "PASS: " << checks
                  << " snowfall profile, deterministic field, parallax, wrap, fade and clock checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
