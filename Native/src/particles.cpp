#include "openslope/particles.hpp"
#include "openslope/import.hpp"
#include "particle_sprites.hpp"
#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
namespace {
double random_unit(std::uint32_t seed, std::uint64_t particle, unsigned field) {
    auto n = seed ^ std::uint32_t(particle) ^ (std::uint32_t(particle >> 32) * 0x9e3779b9u) ^ (field * 0x85ebca6bu);
    n ^= n >> 16;
    n *= 0x7feb352du;
    n ^= n >> 15;
    n *= 0x846ca68bu;
    n ^= n >> 16;
    return (double(n) + .5) / 4294967296.;
}

Vec3 vector(const Transform& m, Vec3 v) { return transform_point(m, v) - transform_point(m, {}); }
} // namespace

ParticleLaw ParticleLaw::decode(const std::array<double, 51>& f) {
    for (auto v : f)
        if (!std::isfinite(v) || std::abs(v) > 1e9)
            throw std::runtime_error("Invalid particle field");
    if (f[0] < 0 || f[0] > 8192 || f[1] < 0 || f[1] > 32 || f[49] < 0 || f[49] > 255 || f[0] != std::floor(f[0]) ||
        f[1] != std::floor(f[1]) || f[49] != std::floor(f[49]) || f[3] <= 0 || f[5] < 0 || f[7] < 0 || f[4] < 0 ||
        f[6] < 0 || f[8] < 0 || std::abs(f[2]) > 120 || (f[2] != 0 && std::abs(f[2]) < .0001) || f[3] < .0001 ||
        f[5] + f[7] * .5 > 120 || f[8] > 10)
        throw std::runtime_error("Particle law exceeds its limits");
    ParticleLaw p;
    p.count = unsigned(f[0]);
    p.trails = unsigned(f[1]);
    p.texture = unsigned(f[49]);
    p.window = f[2];
    p.rate = f[3];
    p.life = f[5];
    p.life_range = f[7];
    p.size = f[4] / 100;
    p.size_range = f[6] / 100;
    p.trail_step = f[8];
    const auto v = [&](unsigned i) { return Vec3{f[i], f[i + 2], -f[i + 1]} / 100; };
    p.origin = v(9);
    p.spawn = {v(12), v(15)};
    p.velocity = v(18);
    p.variation = {v(21), v(24), v(27)};
    p.gravity = v(30);
    for (unsigned i = 0; i < 4; ++i)
        p.colours[i] = {float(std::clamp(f[34 + i * 4], 0., 1.)), float(std::clamp(f[35 + i * 4], 0., 1.)),
                        float(std::clamp(f[36 + i * 4], 0., 1.)), float(std::clamp(f[33 + i * 4], 0., 1.))};
    p.blend = f[50] == 1 ? ParticleBlend::Alpha : f[50] == 4 ? ParticleBlend::Darken : ParticleBlend::Additive;
    return p;
}

Vec3 particle_offset(const ParticleLaw& p, Vec3 velocity, double age) {
    // [Trailmap: 180-particle-vu] Shared curve for every emitter family.
    const auto a = age * p.rate, ac = std::min(a, 2.7), curve = -.73 * ac + .113 * ac * ac;
    const auto g = p.gravity / (p.rate * p.rate);
    return g * a + (g - velocity / p.rate) * curve;
}

void WorldParticles::reset() {
    emitters_.clear();
    next_seed_ = 0x34a79213;
}

void WorldParticles::kill(std::size_t owner) {
    std::erase_if(emitters_, [&](const auto& e) { return e.owner == owner; });
}

void WorldParticles::spawn(std::size_t owner, const ParticleLaw& source, const Transform& m,
                           std::optional<ParticleContact> contact) {
    for (auto value : m)
        if (!std::isfinite(value))
            throw std::invalid_argument("Invalid particle placement");
    if (emitters_.size() >= 512 || source.count == 0)
        return;
    auto p = source;
    p.origin = transform_point(m, p.origin);
    p.velocity = vector(m, p.velocity);
    p.gravity = vector(m, p.gravity);
    for (auto& v : p.spawn)
        v = vector(m, v);
    for (auto& v : p.variation)
        v = vector(m, v);
    if (contact) {
        if (!finite(contact->position) || !finite(contact->normal))
            throw std::invalid_argument("Invalid particle contact");
        p.origin = contact->position;
        p.velocity = normalized(contact->normal) * length(p.velocity);
    }
    const auto scale =
        std::max({length(vector(m, {1, 0, 0})), length(vector(m, {0, 1, 0})), length(vector(m, {0, 0, 1}))});
    next_seed_ = next_seed_ * 1664525u + 1013904223u;
    emitters_.push_back({owner, p, 0, 0, scale, next_seed_});
}

void WorldParticles::step(double dt) {
    if (!std::isfinite(dt) || dt < 0 || dt > 1)
        throw std::invalid_argument("Invalid particle time");
    for (auto& e : emitters_) {
        e.previous = e.age;
        e.age += dt;
    }
    std::erase_if(emitters_, [](const auto& e) {
        return e.law.window >= 0 &&
               e.age > e.law.window + e.law.life + e.law.life_range * .5 + e.law.trails * e.law.trail_step;
    });
}

std::vector<ParticleSprite> WorldParticles::draw(double alpha, Vec3 eye) const {
    if (!finite(eye) || !std::isfinite(alpha))
        throw std::invalid_argument("Invalid particle view");
    std::vector<ParticleSprite> out;
    for (const auto& e : emitters_) {
        const auto& p = e.law;
        const auto time = e.previous + (e.age - e.previous) * std::clamp(alpha, 0., 1.);
        const auto longest = p.life + p.life_range * .5 + p.trails * p.trail_step;
        const auto interval = std::abs(p.window) / p.count;
        const auto first = interval > 0 ? std::uint64_t(std::max(0., std::floor((time - longest) / interval))) : 0;
        const auto end = interval > 0 ? std::uint64_t(std::floor(time / interval)) + 1 : p.count;
        const auto last = p.window < 0 ? end : std::min(end, std::uint64_t(p.count));
        for (auto i = first; i < last && out.size() < maximum_sprites; ++i) {
            const auto life = p.life + (random_unit(e.seed, i, 0) - .5) * p.life_range;
            const auto radius = std::max(0., p.size + (random_unit(e.seed, i, 1) - .5) * p.size_range) * e.scale;
            if (life <= 0 || radius <= 0)
                continue;
            auto origin = p.origin;
            for (unsigned j = 0; j < 2; ++j)
                origin += p.spawn[j] * (random_unit(e.seed, i, 2 + j) - .5);
            auto velocity = p.velocity;
            for (unsigned j = 0; j < 3; ++j)
                velocity += p.variation[j] * (random_unit(e.seed, i, 4 + j) - .5);
            for (unsigned tail = 0; tail <= p.trails && out.size() < maximum_sprites; ++tail) {
                const auto age = time - i * interval - tail * p.trail_step;
                if (age < 0 || age >= life)
                    continue;
                const auto position = origin + particle_offset(p, velocity, age);
                if (length(position - eye) > 500)
                    continue;
                const auto ramp = std::clamp(age / life * 3, 0., 3.);
                const auto stop = std::min(2u, unsigned(ramp));
                const auto t = float(ramp - stop), taper = float(1 - double(tail) / (p.trails + 1));
                std::array<float, 4> colour{};
                for (unsigned c = 0; c < 4; ++c)
                    colour[c] = p.colours[stop][c] + (p.colours[stop + 1][c] - p.colours[stop][c]) * t;
                colour[3] *= taper;
                if (colour[3] > 0)
                    out.push_back({position, float(radius * taper), colour, p.texture, p.blend});
            }
        }
    }
    return out;
}

std::span<const std::string> particle_sprite_names() {
    static const auto names = [] {
        const auto doc =
            nlohmann::json::parse(std::begin(bundled::particle_sprites), std::end(bundled::particle_sprites));
        if (doc.at("schema") != "openslope-particle-sprites/v1" || doc.at("version") != 1)
            throw std::runtime_error("Unsupported particle sprite contract");
        return doc.at("sprites").get<std::vector<std::string>>();
    }();
    return names;
}

std::vector<std::string> particle_textures(const std::filesystem::path& root, bool include_candidates) {
    std::vector<std::string> result;
    if (root.empty())
        return result;
    const auto path = root / "RidingEffects.json";
    nlohmann::json profile = nlohmann::json::object();
    if (std::filesystem::exists(path)) {
        if (std::filesystem::file_size(path) > 65536)
            throw std::runtime_error("Particle profile exceeds limit");
        std::ifstream file(path);
        profile = nlohmann::json::parse(file);
        if (profile.value("Schema", "") != "openslope-riding-effects/v1")
            throw std::runtime_error("Unsupported particle profile");
    }
    if (!profile.value("Enabled", true))
        return result;
    if (profile.contains("EmitterSprites")) {
        result = profile.at("EmitterSprites").get<std::vector<std::string>>();
        if (result.size() > 256)
            throw std::runtime_error("Particle sprite table exceeds limit");
    } else {
        const auto names = particle_sprite_names();
        result.resize(names.size());
        for (std::size_t i = 0; i < names.size(); ++i) {
            const auto& name = names[i];
            if (profile.contains("SpriteBank") && profile.at("SpriteBank").contains(name))
                result[i] = profile.at("SpriteBank").at(name).get<std::string>();
            else if (include_candidates || std::filesystem::exists(root / "Textures" / "Particles" / (name + ".png")))
                result[i] = "Particles/" + name + ".png";
        }
    }
    for (const auto& name : result) {
        if (name.empty())
            continue;
        const std::filesystem::path relative(name);
        if (name.find('\\') != std::string::npos || relative.is_absolute() || relative.has_root_name())
            throw std::runtime_error("Unsafe particle sprite path");
        for (const auto& part : relative)
            if (!valid_map_name(part.string()))
                throw std::runtime_error("Unsafe particle sprite path");
    }
    return result;
}
} // namespace openslope
