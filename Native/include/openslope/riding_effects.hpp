#pragma once
#include "math.hpp"
#include <filesystem>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace openslope {
struct Rider;

struct Sprite {
    Vec3 position;
    float radius{}, alpha{}, rotation{};
};

struct WakeContact {
    Vec3 position, normal;
    int surface{};
};

struct WakeVertex {
    Vec3 position, normal;
    float across{}, along{}, alpha{};
};

struct SprayVertex {
    Vec3 position;
    float u{}, v{}, alpha{};
};

using WakeProbe = std::function<std::optional<WakeContact>(Vec3)>;
std::string riding_sprite(const std::filesystem::path& root, const char* slot = "Puff");
double wake_fade(int surface);

class RidingEffects {
public:
    void reset();
    void tick(const Rider& before, const Rider& after, double dt, const WakeProbe& probe = {});

    std::span<const Sprite> sprites() const { return sprites_; }

    std::span<const WakeVertex> wake() const { return wake_mesh_; }

    std::span<const SprayVertex> sheet() const { return sheet_mesh_; }

    std::size_t sheet_columns() const { return sheet_.size(); }

    std::size_t wake_sections() const { return wake_.size(); }

    unsigned carve_emitted() const { return carve_emitted_; }

    unsigned landing_emitted() const { return landing_emitted_; }

    unsigned powder_count() const { return powder_count_; }

private:
    struct Puff {
        Vec3 origin, normal;
        double age{}, alpha{}, rotation{};
        bool landing = false;
    };

    std::vector<Puff> puffs_;
    std::vector<Sprite> sprites_;
    std::uint32_t random_ = 0x73421u;
    double distance_{}, landing_activity_{}, followup_{};
    unsigned carve_emitted_{}, landing_emitted_{}, powder_count_{};

    struct Section {
        WakeVertex left, right;
        double alpha{}, fade{};
        bool join = false;
    };

    std::vector<Section> wake_;
    std::vector<WakeVertex> wake_mesh_;
    double wake_distance_{}, wake_along_{};
    bool wake_active_ = false;
    void wake_tick(const Rider& before, const Rider& after, double dt, const WakeProbe& probe);
    void end_wake();

    struct Column {
        Vec3 origin, throw_velocity;
        double age{}, alpha{}, along{};
        bool join = false;
    };

    std::vector<Column> sheet_;
    std::vector<SprayVertex> sheet_mesh_;
    std::array<std::array<SprayVertex, 4>, 128> sheet_points_{};
    double sheet_distance_{}, sheet_along_{};
    int sheet_side_{};
    bool sheet_active_ = false;
    void sheet_tick(const Rider& before, const Rider& after, double dt, const WakeProbe& probe);
    double random();
    void puff(Vec3 origin, Vec3 normal, double alpha, bool landing);
};
} // namespace openslope
