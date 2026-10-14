#pragma once
#include "math.hpp"
#include <filesystem>
#include <span>
#include <string>
#include <vector>

namespace openslope {
struct Rider;
struct Sprite {Vec3 position;float radius{},alpha{},rotation{};};
std::string riding_sprite(const std::filesystem::path& root);
class RidingEffects {
public:
    void reset();
    void tick(const Rider& before,const Rider& after,double dt);
    std::span<const Sprite> sprites() const {return sprites_;}
    unsigned carve_emitted() const {return carve_emitted_;}
    unsigned landing_emitted() const {return landing_emitted_;}
    unsigned powder_count() const {return powder_count_;}
private:
    struct Puff {Vec3 origin,normal;double age{},alpha{},rotation{};bool landing=false;};
    std::vector<Puff> puffs_;std::vector<Sprite> sprites_;std::uint32_t random_=0x73421u;
    double distance_{},landing_activity_{},followup_{};
    unsigned carve_emitted_{},landing_emitted_{},powder_count_{};
    double random();
    void puff(Vec3 origin,Vec3 normal,double alpha,bool landing);
};
}
