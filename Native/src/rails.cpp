#include "openslope/rails.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <numeric>
#include <stdexcept>

namespace openslope {
namespace {
Vec3 raw(const nlohmann::json& row){const auto v=row.get<std::array<double,3>>();const Vec3 point{v[0],v[2],-v[1]};if(!finite(point)||length(point)>1e9)throw std::runtime_error("Invalid rail vector");return point/100;}
std::array<Vec3,4> controls(const RailCurve& curve){const auto& c=curve.power;return {c[3],c[3]+c[2]/3,c[3]+c[2]*2/3+c[1]/3,c[3]+c[2]+c[1]+c[0]};}
double closest_parameter(const RailCurve& curve,Vec3 position){
    // [Trailmap: 350-analytic] Chords bracket; all refinement evaluates the cubic.
    double best=std::numeric_limits<double>::infinity(),lo=0,hi=.25;
    for(unsigned i=0;i<4;++i){const auto a=curve.point(i*.25),b=curve.point((i+1)*.25),d=b-a;const auto t=dot(d,d)>1e-20?std::clamp(dot(position-a,d)/dot(d,d),0.,1.):0.;const auto delta=a+d*t-position;const auto distance=dot(delta,delta);if(distance<best){best=distance;lo=i*.25;hi=(i+1)*.25;}}
    constexpr double ratio=.6180339887498948482;const auto distance=[&](double t){const auto d=curve.point(t)-position;return dot(d,d);};double a=hi-ratio*(hi-lo),b=lo+ratio*(hi-lo),fa=distance(a),fb=distance(b);
    for(unsigned i=0;i<24&&hi-lo>.0005;++i){if(fa<fb){hi=b;b=a;fb=fa;a=hi-ratio*(hi-lo);fa=distance(a);}else{lo=a;a=b;fa=fb;b=lo+ratio*(hi-lo);fb=distance(b);}}
    double result=(lo+hi)*.5;for(const auto end:{0.,1.})if(distance(end)<distance(result))result=end;return result;
}
bool near_box(const Bounds& b,Vec3 p){return p.x>=b.min.x-3&&p.x<=b.max.x+3&&p.y>=b.min.y-3&&p.y<=b.max.y+3&&p.z>=b.min.z-3&&p.z<=b.max.z+3;}
}
Vec3 RailCurve::point(double t) const {return ((power[0]*t+power[1])*t+power[2])*t+power[3];}
Vec3 RailCurve::tangent(double t) const {return (power[0]*(3*t)+power[1]*2)*t+power[2];}
Rails::Rails(std::vector<RailSpline> splines):splines_(std::move(splines)){
    if(splines_.size()>10000)throw std::runtime_error("Too many rail splines");for(std::size_t i=0;i<splines_.size();++i){const auto& spline=splines_[i];if(spline.surface< -1||spline.surface>19)throw std::runtime_error("Invalid rail surface");initial_.push_back(spline.enabled);
        for(std::size_t j=0;j<spline.curves.size();++j){Curve c{spline.curves[j],{},i,j};for(const auto p:controls(c.curve)){if(!finite(p)||length(p)>1e7)throw std::runtime_error("Rail curve exceeds coordinate limits");c.bounds.add(p);}curves_.push_back(c);if(curves_.size()>100000)throw std::runtime_error("Too many rail curve segments");}
    }order_.resize(curves_.size());std::iota(order_.begin(),order_.end(),0);if(!order_.empty())split(0,order_.size());
}
int Rails::split(std::size_t begin,std::size_t end){
    const auto id=int(nodes_.size());Node node{{},begin,end};for(std::size_t i=begin;i<end;++i){node.bounds.add(curves_[order_[i]].bounds.min);node.bounds.add(curves_[order_[i]].bounds.max);}nodes_.push_back(node);if(end-begin<=8)return id;
    const auto size=node.bounds.max-node.bounds.min;const auto axis=size.x>=size.y&&size.x>=size.z?0:size.y>=size.z?1:2;const auto middle=(begin+end)/2;std::nth_element(order_.begin()+begin,order_.begin()+middle,order_.begin()+end,[&](auto a,auto b){const auto ca=curves_[a].bounds.center(),cb=curves_[b].bounds.center();const auto value=[&](Vec3 p){return axis==0?p.x:axis==1?p.y:p.z;};return value(ca)<value(cb);});nodes_[id].left=split(begin,middle);nodes_[id].right=split(middle,end);return id;
}
void Rails::query(int node,Vec3 position,std::optional<RailHit>& closest) const {
    const auto& n=nodes_[node];if(!near_box(n.bounds,position))return;if(n.left>=0){query(n.left,position,closest);query(n.right,position,closest);return;}
    for(std::size_t i=n.begin;i<n.end;++i){const auto& curve=curves_[order_[i]];const auto& parent=splines_[curve.spline];if(!parent.enabled||parent.surface<0||!near_box(curve.bounds,position))continue;const auto t=closest_parameter(curve.curve,position);const auto point=curve.curve.point(t),derivative=curve.curve.tangent(t);if(length(derivative)<1e-9)continue;const auto delta=position-point;const auto distance=length(delta);if(closest&&(distance>closest->distance+1e-9||(std::abs(distance-closest->distance)<=1e-9&&std::pair{curve.spline,curve.segment}>=std::pair{closest->spline,closest->segment})))continue;
        const auto tangent=normalized(derivative),up=normalized(project({0,1,0},tangent),normalized(project({0,0,1},tangent),{1,0,0})),right=normalized(cross(tangent,up));closest=RailHit{curve.spline,curve.segment,t,distance,point,tangent,up,right,{dot(delta,tangent),dot(delta,right),dot(delta,up)}};
    }
}
std::optional<RailHit> Rails::nearest(Vec3 position) const {if(!finite(position))throw std::runtime_error("Invalid rail query point");std::optional<RailHit> result;if(!nodes_.empty())query(0,position,result);return result;}
bool Rails::accepts(const RailHit& hit,bool entry,double blend) const {blend=std::clamp(blend,0.,1.);const auto scale=entry?.9:1.;return std::abs(hit.offset.x)<(.8+.7*blend)*scale&&std::abs(hit.offset.y)<.72*scale&&std::abs(hit.offset.z)<(.3+.42*blend)*scale;}
void Rails::enable(std::size_t spline,bool value){splines_.at(spline).enabled=value;}
void Rails::reset(){for(std::size_t i=0;i<splines_.size();++i)splines_[i].enabled=initial_[i];}
int Rails::surface(std::size_t spline) const {return splines_.at(spline).surface;}
Rails Rails::load(const std::filesystem::path& root){
    if(root.empty()||!std::filesystem::exists(root/"Splines.json"))return Rails();const auto base=std::filesystem::weakly_canonical(root),file=std::filesystem::weakly_canonical(root/"Splines.json"),relative=file.lexically_relative(base);if(relative.empty()||relative.is_absolute()||*relative.begin()==".."||std::filesystem::file_size(file)>64*1024*1024)throw std::runtime_error("Invalid rail metadata path/size");std::ifstream input(file);const auto doc=nlohmann::json::parse(input);const auto& rows=doc.at("Splines");if(!rows.is_array()||rows.size()>10000)throw std::runtime_error("Invalid spline table");std::vector<RailSpline> splines;std::size_t total=0;
    for(const auto& row:rows){RailSpline spline;spline.surface=row.value("SplineStyle",13);spline.enabled=(row.value("U1",1)&1)!=0;const auto& segments=row.at("Segments");if(!segments.is_array()||total+segments.size()>100000)throw std::runtime_error("Invalid rail segment table");total+=segments.size();
        for(const auto& part:segments){const auto& values=part.at("Points");if(!values.is_array()||values.size()!=4)throw std::runtime_error("A rail segment needs four controls");std::array<Vec3,4> p{};for(unsigned i=0;i<4;++i)p[i]=raw(values[i]);RailCurve curve;curve.power={-p[0]+p[1]*3-p[2]*3+p[3],p[0]*3-p[1]*6+p[2]*3,(p[1]-p[0])*3,p[0]};
            if(part.contains("PowerCoefficients")){const auto& power=part.at("PowerCoefficients");if(!power.is_array()||power.size()!=4)throw std::runtime_error("Invalid cubic rail coefficients");RailCurve stored;for(unsigned i=0;i<4;++i)stored.power[i]=raw(power[i]);const auto expected=controls(stored);bool unchanged=true;for(unsigned i=0;i<4;++i)unchanged&=length(expected[i]-p[i])<=.0001;if(unchanged)curve=stored;}
            spline.curves.push_back(curve);}splines.push_back(std::move(spline));
    }return Rails(std::move(splines));
}
}
