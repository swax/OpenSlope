#pragma once
#include "math.hpp"
#include <array>
#include <memory>
#include <string_view>

namespace openslope {
struct Surface {
    int type{};
    double A{},P{},bog{},budget{},threshold{},lift{},drag{},target{},multiplier{},tilt_degrees{};
    double resistance_a{},resistance_b{},resistance_c{};
};
struct ResponseTuning {
    double linear_stat=.5,quadratic_stat=.5,skid_stat=.5,lateral_stat=.5;
    int mode=1,edge=0,preferred_edge=0;
    double load_ratio=1,skid=0;
};

class RideContract {
public:
    RideContract();
    ~RideContract();
    RideContract(const RideContract&)=delete;
    RideContract& operator=(const RideContract&)=delete;
    const Surface& surface(int type) const;
    double value(std::string_view section,std::string_view key) const;
    double response(std::string_view section,std::string_view key) const;
    double tick_seconds() const;
    unsigned max_catchup_ticks() const;
    const ResponseTuning& default_tuning() const { return defaults_; }
    double forward_resistance(const Surface& s,double u,double error,double budget,double charge,double boost,const ResponseTuning& t) const;
    double forward_resistance(const Surface& s,double u,double error,double budget,double charge,double boost) const {
        return forward_resistance(s,u,error,budget,charge,boost,defaults_);
    }
    double lateral_resistance(double drag,double u,double w,double lean,double boost,const ResponseTuning& t) const;
    double lateral_resistance(double drag,double u,double w,double lean,double boost) const {
        return lateral_resistance(drag,u,w,lean,boost,defaults_);
    }
    double heading_lead(double lean,double charge,int mode) const;
    double heading_lead(double lean,double charge) const { return heading_lead(lean,charge,defaults_.mode); }
    double heading_yaw(double lean,double lead,double slip,double speed,double forward_speed,double fall_line_speed,double dt) const;
    double contact_response(const Surface& s,double error,double vn,double bog,double budget) const;
    Vec3 redirect(Vec3 velocity,Vec3 normal,int surface_type) const;
private:
    struct Data;
    std::unique_ptr<Data> data_;
    std::array<Surface,20> surfaces_;
    ResponseTuning defaults_;
    double stance(const ResponseTuning& t) const;
};

// Rendering frequency never changes the 60 Hz simulation step. Excess wall-clock
// time is discarded after a bounded catch-up, avoiding a post-suspend spiral.
class FixedClock {
public:
    explicit FixedClock(double step=1.0/60.0,unsigned maximum=6):step_(step),maximum_(maximum){}
    unsigned advance(double seconds);
    double alpha() const { return accumulator_/step_; }
    void reset() { accumulator_=0; }
private:
    double step_,accumulator_=0;
    unsigned maximum_;
};
}
