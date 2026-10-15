#pragma once
#include "math.hpp"
#include <set>
#include <cstdint>

namespace openslope {
class PropChecklist {
public:
    explicit PropChecklist(std::uint32_t count=0);
    void control(unsigned command,double input);
    bool take_trigger();
    std::uint32_t remaining() const {return remaining_;}
private:
    std::uint32_t remaining_=0;std::set<unsigned> marked_;bool pending_=false,fired_=false;
};
class FragileProp {
public:
    FragileProp(double strength=5,double lifetime=-1);
    void step(double seconds);
    bool hit(double force);
    bool take_trigger();
    bool expired() const {return expired_;}
    double strength() const {return strength_;}
private:
    double strength_=0,lifetime_=-1,age_=0,cooldown_=0;bool pending_=false,fired_=false,expired_=false;
};
// First-party play profile: measured gate, carried cost and representative impact price.
double fragile_contact_cost(double normal_speed,Vec3 normal,bool supported);
struct PropTextureFrame {std::size_t instance=0;unsigned frame=0;};
}
