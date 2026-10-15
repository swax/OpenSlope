#pragma once
#include "props.hpp"
#include <cstdint>
#include <optional>

namespace openslope {
enum class ParticleBlend { Additive, Alpha, Darken };

struct ParticleSprite {
    Vec3 position{};
    float radius{};
    std::array<float, 4> colour{};
    unsigned texture{};
    ParticleBlend blend = ParticleBlend::Additive;
};

struct ParticleContact {
    Vec3 position{}, normal{0, 1, 0};
};

struct ParticleLaw {
    unsigned count{}, trails{}, texture{};
    double window{}, rate = 1, life{}, life_range{}, size{}, size_range{}, trail_step{};
    Vec3 origin{}, velocity{}, gravity{};
    std::array<Vec3, 2> spawn{};
    std::array<Vec3, 3> variation{};
    std::array<std::array<float, 4>, 4> colours{};
    ParticleBlend blend = ParticleBlend::Additive;
    static ParticleLaw decode(const std::array<double, 51>& fields);
};

Vec3 particle_offset(const ParticleLaw& law, Vec3 velocity, double age);
std::vector<std::string> particle_textures(const std::filesystem::path& root, bool include_candidates = false);
std::span<const std::string> particle_sprite_names();

// Compact emitter records reconstruct particles without mutating during either eye's draw.
class WorldParticles {
public:
    static constexpr std::size_t maximum_sprites = 32768;
    void reset();
    void spawn(std::size_t owner, const ParticleLaw& law, const Transform& matrix,
               std::optional<ParticleContact> contact = {});
    void kill(std::size_t owner);
    void step(double seconds);
    std::vector<ParticleSprite> draw(double alpha, Vec3 eye) const;

    std::size_t emitters() const { return emitters_.size(); }

private:
    struct Emitter {
        std::size_t owner{};
        ParticleLaw law{};
        double age{}, previous{}, scale = 1;
        std::uint32_t seed{};
    };

    std::vector<Emitter> emitters_;
    std::uint32_t next_seed_ = 0x34a79213;
};
} // namespace openslope
