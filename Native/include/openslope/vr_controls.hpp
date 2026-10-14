#pragma once
#include "math.hpp"
namespace openslope {
struct VrInput {bool enabled=false,head=false,stick=false;Vec3 gaze{};double spin=0;};
double vr_axis(double raw,bool precision);
double gaze_yaw(Vec3 gaze,Vec3 reference,Vec3 normal);
double gaze_carve(Vec3 gaze,Vec3 travel,Vec3 normal,Vec3 fallback);
double gaze_turn(Vec3 gaze,Vec3 reference,double maximum_radians);
}
