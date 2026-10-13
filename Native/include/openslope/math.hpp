#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>

namespace openslope {
struct Vec3 {
    double x{}, y{}, z{};
    Vec3 operator+(Vec3 b) const { return {x+b.x,y+b.y,z+b.z}; }
    Vec3 operator-(Vec3 b) const { return {x-b.x,y-b.y,z-b.z}; }
    Vec3 operator-() const { return {-x,-y,-z}; }
    Vec3 operator*(double s) const { return {x*s,y*s,z*s}; }
    Vec3 operator/(double s) const { return *this*(1/s); }
    Vec3& operator+=(Vec3 b) { return *this=*this+b; }
    Vec3& operator-=(Vec3 b) { return *this=*this-b; }
    Vec3& operator*=(double s) { return *this=*this*s; }
};
inline double dot(Vec3 a, Vec3 b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
inline Vec3 cross(Vec3 a, Vec3 b) { return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x}; }
inline double length(Vec3 a) { return std::sqrt(dot(a,a)); }
inline Vec3 normalized(Vec3 a, Vec3 fallback={0,1,0}) { const auto n=length(a); return n>1e-12?a/n:fallback; }
inline Vec3 project(Vec3 v, Vec3 n) { return v-n*dot(v,n); }
inline Vec3 rotate(Vec3 v, Vec3 axis, double angle) {
    const auto c=std::cos(angle), s=std::sin(angle);
    return v*c+cross(axis,v)*s+axis*(dot(axis,v)*(1-c));
}
inline bool finite(Vec3 v) { return std::isfinite(v.x)&&std::isfinite(v.y)&&std::isfinite(v.z); }
inline double approach(double a,double b,double step) { return a+std::clamp(b-a,-step,step); }
inline constexpr double pi=3.14159265358979323846;

struct Bounds {
    Vec3 min{std::numeric_limits<double>::infinity(),std::numeric_limits<double>::infinity(),std::numeric_limits<double>::infinity()};
    Vec3 max{-std::numeric_limits<double>::infinity(),-std::numeric_limits<double>::infinity(),-std::numeric_limits<double>::infinity()};
    void add(Vec3 v) {
        min={std::min(min.x,v.x),std::min(min.y,v.y),std::min(min.z,v.z)};
        max={std::max(max.x,v.x),std::max(max.y,v.y),std::max(max.z,v.z)};
    }
    Vec3 center() const { return (min+max)*0.5; }
    bool intersects(Vec3 start,Vec3 direction) const {
        double lo=0,hi=1;
        const std::array<double,3> a{start.x,start.y,start.z}, d{direction.x,direction.y,direction.z};
        const std::array<double,3> lower{min.x,min.y,min.z}, upper{max.x,max.y,max.z};
        for(std::size_t i=0;i<3;++i) {
            if(std::abs(d[i])<1e-12) { if(a[i]<lower[i]-1e-8||a[i]>upper[i]+1e-8) return false; }
            else {
                auto p=(lower[i]-a[i])/d[i],q=(upper[i]-a[i])/d[i];
                if(p>q) std::swap(p,q);
                lo=std::max(lo,p);hi=std::min(hi,q);
                if(lo>hi) return false;
            }
        }
        return true;
    }
};
}
