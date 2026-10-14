#include "openslope/spline_motion.hpp"
#include <algorithm>
#include <stdexcept>

namespace openslope {
namespace {
double arc_length(const RailCurve& curve,double a,double b){
    // Five-point Gauss-Legendre quadrature on short parameter intervals.
    constexpr std::array<double,5> x{0,-.5384693101056831,.5384693101056831,-.9061798459386640,.9061798459386640};
    constexpr std::array<double,5> w{.5688888888888889,.4786286704993665,.4786286704993665,.2369268850561891,.2369268850561891};
    const auto mid=(a+b)*.5,half=(b-a)*.5;double sum=0;for(unsigned i=0;i<x.size();++i)sum+=w[i]*length(curve.tangent(mid+half*x[i]));return sum*half;
}
}
PropRoute::PropRoute(std::vector<RailCurve> curves):curves_(std::move(curves)){
    if(curves_.size()>100000)throw std::invalid_argument("Too many mover curve segments");for(const auto& curve:curves_){for(const auto point:curve.power)if(!finite(point)||openslope::length(point)>1e8)throw std::invalid_argument("Invalid mover curve");starts_.push_back(length_);std::array<double,65> arc{};for(unsigned i=1;i<arc.size();++i)arc[i]=arc[i-1]+arc_length(curve,(i-1)/64.,i/64.);length_+=arc.back();arc_.push_back(arc);}if(!std::isfinite(length_)||length_>1e8)throw std::invalid_argument("Invalid mover route length");
}
RouteSample PropRoute::sample(double distance) const {
    if(!std::isfinite(distance)||distance<0||distance>length_+1e-6||curves_.empty()||length_<=1e-9)throw std::invalid_argument("Invalid mover distance");distance=std::clamp(distance,0.,length_);auto found=std::upper_bound(starts_.begin(),starts_.end(),distance);auto segment=found==starts_.begin()?0:std::size_t(found-starts_.begin()-1);while(segment+1<curves_.size()&&arc_[segment].back()<=1e-12)++segment;const auto local=std::clamp(distance-starts_[segment],0.,arc_[segment].back());const auto& arc=arc_[segment];auto index=std::upper_bound(arc.begin(),arc.end(),local);const auto cell=std::min(std::size_t(63),index==arc.begin()?0:std::size_t(index-arc.begin()-1));const auto base=cell/64.;double lo=base,hi=(cell+1)/64.,t=(lo+hi)*.5;for(unsigned i=0;i<24;++i){const auto error=arc[cell]+arc_length(curves_[segment],base,t)-local;if(std::abs(error)<1e-8)break;if(error<0)lo=t;else hi=t;const auto speed=openslope::length(curves_[segment].tangent(t));const auto next=speed>1e-10?t-error/speed:(lo+hi)*.5;t=next>lo&&next<hi?next:(lo+hi)*.5;}if(local==0)t=0;if(local==arc.back())t=1;auto tangent=curves_[segment].tangent(t);if(openslope::length(tangent)<1e-10){const auto a=std::max(0.,t-.0001),b=std::min(1.,t+.0001);tangent=curves_[segment].point(b)-curves_[segment].point(a);}return {curves_[segment].point(t),normalized(tangent,{0,0,-1}),segment,t};
}
RoutePlayback::RoutePlayback(RouteLaw law,double length):law_(law),length_(length),speed_(law.speed),direction_(law.speed<0?-1:1){if(!std::isfinite(length)||length<0||length>1e8||!std::isfinite(speed_)||std::abs(speed_)>10000||!std::isfinite(law.yaw)||law.copies==0||law.copies>1024)throw std::invalid_argument("Invalid spline playback law");for(const auto c:law.colour)if(!std::isfinite(c)||c<0||c>1)throw std::invalid_argument("Invalid spline line colour");if(length<=1e-9)retired_=true;}
void RoutePlayback::step(double seconds){
    if(!std::isfinite(seconds)||seconds<0||seconds>3600)throw std::invalid_argument("Invalid spline playback duration");if(retired_)return;if(finished_){retired_=true;return;}if(seconds==0||speed_==0)return;auto next=distance_+speed_*seconds;
    if(law_.end_mode==2){const auto period=length_*2;auto phase=std::fmod(next,period);if(phase<0)phase+=period;const bool descending=phase>length_;distance_=descending?period-phase:phase;if(next<=0||next>=length_){const auto initial_sign=speed_<0?-1.:1.;const auto folded_sign=descending?-1.:1.;speed_=std::abs(speed_)*folded_sign*initial_sign;if(next==0)speed_=std::abs(speed_);if(next==length_)speed_=-std::abs(speed_);}direction_=speed_<0?-1:1;return;}
    if(next<0){distance_=0;speed_=0;return;}if(next>=length_-1e-9){if(std::abs(next-length_)<1e-9)next=length_;if(law_.end_mode==0){distance_=length_;finished_=true;return;}if(law_.end_mode==3){distance_=length_;speed_=0;return;}next=std::fmod(next,length_);}distance_=next;
}
std::vector<double> RoutePlayback::distances() const {std::vector<double> result;if(retired_)return result;result.reserve(law_.copies);for(unsigned i=0;i<law_.copies;++i){auto d=distance_+length_*i/law_.copies;if(d>length_)d=std::fmod(d,length_);result.push_back(d);}return result;}
Transform route_pose(const RouteSample& sample,int orientation,double offset,double direction){
    if(!finite(sample.position)||!finite(sample.tangent)||!std::isfinite(offset)||(direction!=1&&direction!=-1))throw std::invalid_argument("Invalid spline orientation");const auto tangent=normalized(sample.tangent,{0,0,-1});const bool yaw=orientation!=2&&orientation!=3,pitch=orientation!=1&&orientation!=3;const auto heading=-offset+(yaw?std::atan2(-tangent.z,tangent.x)-pi/2:0)+(direction<0?pi:0);const auto tilt=pitch?tangent.y*direction:0;const auto sx=std::sin(tilt*.5),cx=std::cos(tilt*.5),sz=std::sin(heading*.5),cz=std::cos(heading*.5);auto result=map_transform(placement({}, {sx*cz,sx*sz,cx*sz,cx*cz},{1,1,1}));result[12]=sample.position.x;result[13]=sample.position.y;result[14]=sample.position.z;return result;
}
}
