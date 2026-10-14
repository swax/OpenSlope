#include "openslope/vr_controls.hpp"
namespace openslope {
double vr_axis(double raw,bool precision){const auto magnitude=std::clamp((std::abs(raw)-.18)/.82,0.,1.);return std::copysign(precision?magnitude*magnitude:magnitude,raw);}
double gaze_yaw(Vec3 gaze,Vec3 reference,Vec3 normal){
    normal=normalized(normal,{0,1,0});gaze=project(gaze,normal);reference=project(reference,normal);
    if(!finite(gaze)||!finite(reference)||length(gaze)<1e-6||length(reference)<1e-6)return 0;
    gaze=normalized(gaze);reference=normalized(reference);return std::atan2(dot(cross(reference,gaze),normal),std::clamp(dot(reference,gaze),-1.,1.));
}
double gaze_carve(Vec3 gaze,Vec3 travel,Vec3 normal,Vec3 fallback){
    const auto reference=length(project(travel,normal))>.5?travel:fallback;const auto angle=gaze_yaw(gaze,reference,normal)*180/pi;
    return std::copysign(std::clamp((std::abs(angle)-5)/30,0.,1.),angle);
}
double gaze_turn(Vec3 gaze,Vec3 reference,double maximum){const auto yaw=gaze_yaw(gaze,reference,{0,1,0});return std::abs(yaw)<=5*pi/180?0:std::clamp(yaw,-maximum,maximum);}
}
