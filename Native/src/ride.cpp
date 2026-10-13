#include "openslope/ride.hpp"
#include "contract.hpp"
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace openslope {
struct RideContract::Data { nlohmann::json document; };
RideContract::RideContract():data_(std::make_unique<Data>()) {
    auto& doc=data_->document;doc=nlohmann::json::parse(embedded_ride_contract);
    if(doc.at("schema")!="ride-contract/v1"||doc.at("version")!=1||doc.at("simulation").at("hz")!=60)
        throw std::runtime_error("Unsupported ride contract");
    const auto& rows=doc.at("surfaces");if(rows.size()!=20) throw std::runtime_error("Ride contract requires 20 surface rows");
    for(std::size_t i=0;i<20;++i) {
        const auto& r=rows[i];if(r.at("type").get<int>()!=static_cast<int>(i)) throw std::runtime_error("Unordered surface table");
        surfaces_[i]={r.at("type"),r.at("A"),r.at("P"),r.at("bog"),r.at("budget"),r.at("threshold"),r.at("lift"),r.at("drag"),r.at("target"),r.at("multiplier"),r.at("tiltDeg"),r.at("resistanceA"),r.at("resistanceB"),r.at("resistanceC")};
    }
    const auto stat=response("defaults","normalizedStat");
    const auto edge=static_cast<int>(response("defaults","edge"));
    defaults_={stat,stat,stat,stat,static_cast<int>(response("defaults","mode")),edge,edge,response("defaults","loadRatio"),response("defaults","skid")};
}
RideContract::~RideContract()=default;
const Surface& RideContract::surface(int type) const { return surfaces_[type>=0&&type<20?type:15]; }
double RideContract::value(std::string_view section,std::string_view key) const {
    return data_->document.at(std::string(section)).at(std::string(key)).get<double>();
}
double RideContract::response(std::string_view section,std::string_view key) const {
    return data_->document.at("response").at(std::string(section)).at("values").at(std::string(key)).get<double>();
}
double RideContract::tick_seconds() const { return 1/value("simulation","hz"); }
unsigned RideContract::max_catchup_ticks() const { return static_cast<unsigned>(value("simulation","maxCatchupTicks")); }
double RideContract::stance(const ResponseTuning& t) const {
    return t.edge==t.preferred_edge||t.mode==1?1:response("stance",t.mode==0?"mode0Mismatch":"otherMismatch");
}
// [Trailmap: 330-resistance, 330-lateral] Coefficients are sourced from the shared
// contract; these independent C++ equations are checked against scalar fixtures.
double RideContract::forward_resistance(const Surface& s,double u,double error,double budget,double charge,double boost,const ResponseTuning& t) const {
    const auto k=stance(t);
    const auto a=(response("forward",t.mode==2?"mode2LinearBase":"linearBase")-response("forward",t.mode==2?"mode2LinearStatScale":"linearStatScale")*t.linear_stat)*k;
    const auto c=(response("forward","quadraticBase")-response("forward","quadraticStatScale")*t.quadratic_stat)*k;
    const auto skid=(response("forward","skidBase")+response("forward","skidStatScale")*t.skid_stat)*k;
    const auto q=std::max(1.0,t.load_ratio),x=std::abs(u)*response("forward","speedScale");
    const auto depth=s.type==3||s.type==4?response("forward","powderDepthBase")-error/std::max(budget,response("guards","budgetMetres")):1;
    return -u*depth*(q*s.resistance_a*a+(1-charge)*response("forward","unchargedDrag")
        +(1+boost*response("forward","boostSkidScale"))*response("forward","skidDrag")*t.skid*t.skid*skid
        +x*(q*s.resistance_b+x*q*s.resistance_c*c));
}
double RideContract::lateral_resistance(double drag,double u,double w,double lean,double boost,const ResponseTuning& t) const {
    const auto speed=std::abs(u);
    const auto low=response("lateral","lowSpeedMps"),mid=response("lateral","midSpeedMps");
    const auto gain=speed<low?response("lateral","lowBase")+speed*response("lateral","lowSlope")
        :speed<mid?response("lateral","midBase")+(speed-low)*response("lateral","midSlope")
        :response("lateral","highBase")-(speed-mid)*response("lateral","highFalloff");
    const auto rider=(response("lateral","riderBase")+response("lateral","riderStatScale")*t.lateral_stat)*stance(t);
    const auto boost_gain=boost>0?1/(1+response("lateral","boostScale")*boost):1;
    return -w*drag*gain*std::max(1.0,std::abs(lean)*response("lateral","leanScale"))*rider*boost_gain;
}
double RideContract::heading_lead(double lean,double charge,int mode) const {
    const auto shape=response("lead",mode==2?"mode2Shape":mode==0?"mode0Shape":"defaultShape");
    const auto angle=response("lead",mode==2?"mode2AngleRad":mode==0?"mode0AngleRad":"defaultAngleRad");
    return lean*angle*(1+response("lead","shapeScale")*shape*(1-lean*lean))/(1+charge*response("lead","chargeScale"));
}
double RideContract::heading_yaw(double lean,double lead,double slip,double speed,double forward_speed,double fall_line_speed,double dt) const {
    if(speed<response("guards","speedMps")||dt<=0) return 0;
    auto candidate=lead-std::asin(std::clamp(slip,-response("yaw","slipProjectionLimit"),response("yaw","slipProjectionLimit")));
    if(forward_speed<0) candidate=-candidate;
    const auto gate=std::min(1.0,speed*speed*response("yaw","speedGate")*dt);
    const auto align=std::min(1.0,std::max(0.0,response("yaw","alignScale")*std::min(1.0,speed/response("yaw","alignSpeedMps"))*(response("yaw","alignRatio")-std::abs(fall_line_speed)/speed))+response("yaw","alignBase"));
    const auto cap=response("yaw","capRadPerTick");
    return std::clamp(candidate*gate*std::max(candidate>0?lean:-lean,align),-cap,cap);
}
double RideContract::contact_response(const Surface& s,double error,double vn,double bog,double budget) const {
    const auto accel=s.A/response("units","centimetresPerMetre");
    // [Trailmap: 320-spring] The current specification explicitly damps both
    // normal-velocity signs above the surface. Existing port helpers differ.
    if(error>0) return -(s.A/response("contact","aboveLengthCm"))*error-s.P*vn;
    if(error> -bog) return -accel*error/bog-s.P*vn;
    const auto span=std::max(budget-bog,response("guards","contactSpanMetres"));
    return accel*(1-response("contact","deepGain")*(std::max(error,-budget)+bog)/span)-s.P*vn;
}
Vec3 RideContract::redirect(Vec3 velocity,Vec3 normal,int type) const {
    // [Trailmap: 320-redirect] Re-probe first; powder skips redirect.
    if(type==3||type==4) return velocity;
    const auto speed=length(velocity);
    auto result=velocity-normal*(value("contact","redirect")*dot(velocity,normal));
    const auto magnitude=length(result);
    return magnitude>0?result*(speed/magnitude):result;
}
unsigned FixedClock::advance(double seconds) {
    if(!std::isfinite(seconds)||seconds<0) throw std::invalid_argument("Frame duration must be finite and nonnegative");
    accumulator_+=std::min(seconds,step_*maximum_);
    const auto ticks=std::min(maximum_,static_cast<unsigned>(std::floor((accumulator_+step_*1e-9)/step_)));
    accumulator_-=ticks*step_;accumulator_=std::clamp(accumulator_,0.0,step_);
    return ticks;
}
}
