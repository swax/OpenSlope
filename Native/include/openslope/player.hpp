#pragma once
#include "ride.hpp"
#include "terrain.hpp"

namespace openslope {
struct RideInput { double steer{}; bool boost{},reset{}; }; // Positive steer is left in the port's right-handed frame.
struct Rider {
    Vec3 position,previous_position,velocity,forward{0,0,-1},normal{0,1,0},smoothed_up{0,1,0};
    double lean{},slide{},bog{},budget{},lift{},speed_cap{},contact_error{};
    int surface=1;
    bool grounded=false;
};

// First playable terrain/contact slice. Full jump, rail, prop, and race state
// machines remain separate ports; see Native/README.md's conformance table.
class Player {
public:
    explicit Player(Terrain terrain);
    void reset();
    void tick(const RideInput& input);
    void advance(double seconds,const RideInput& input);
    Vec3 render_position() const;
    const Rider& rider() const { return rider_; }
    const Terrain& terrain() const { return terrain_; }
    const RideContract& contract() const { return contract_; }
private:
    Terrain terrain_;
    RideContract contract_;
    FixedClock clock_;
    Rider rider_;
    Vec3 spawn_position_,spawn_forward_;
    std::optional<TerrainHit> probe(Vec3 position) const;
};
}
