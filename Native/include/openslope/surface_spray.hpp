#pragma once
#include "particles.hpp"

namespace openslope {
struct Rider;

struct SurfaceSprayRow {
    int type{};
    double rate{}, size_units{}, fade_min{}, fade_max{};
    unsigned texture{};
    double alpha{};
};

const std::array<SurfaceSprayRow, 20>& surface_spray_rows();
bool spark_surface(int type);

// One fixed forty-slot simulation ring; either eye reconstructs the same snapshot.
class SurfaceSpray {
public:
    static constexpr unsigned maximum_sprites = 40 * 64 + 40 * 18 * 7;

    struct Stats {
        unsigned slots{}, surface_slots{}, surface_sprites{}, puff_slots{}, puffs{}, spark_slots{}, sparks{}, flares{};
        std::uint64_t chunks_emitted{}, puffs_emitted{}, sparks_emitted{};
    };

    void reset();
    void step(const Rider& before, const Rider& after, double dt, std::optional<Vec3> contact = {});
    std::vector<ParticleSprite> draw(double alpha = 1) const;
    Stats stats() const;

private:
    enum class Kind { Empty, Chunk, Puff, Spark };

    struct Dot {
        Vec3 position{}, velocity{};
        float radius{};
        std::array<float, 3> colour{1, 1, 1};
    };

    struct Burst {
        Kind kind = Kind::Empty;
        double age{}, previous{}, fade{}, opacity{};
        unsigned texture{};
        bool flare = false;
        std::vector<Dot> dots;
    };

    struct Slot {
        Burst surface, sparks;
    };

    std::array<Slot, 40> ring_;
    unsigned cursor_{}, flares_{};
    std::uint64_t chunks_emitted_{}, puffs_emitted_{}, sparks_emitted_{};
    double air_rate_ = 0;
    std::uint32_t random_ = 0x5c4a713u;
    std::optional<Vec3> rail_spawn_;
    double random();
    Burst& allocate(std::optional<unsigned>& tick_slot, Kind kind, unsigned count, unsigned texture, double fade,
                    double opacity, bool flare = false);
};
} // namespace openslope
