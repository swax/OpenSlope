#include "openslope/terrain.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <numeric>
#include <stdexcept>

namespace openslope {
namespace {
std::array<double,4> basis(double t) {
    const auto s=1-t;
    return {s*s*s,3*s*s*t,3*s*t*t,t*t*t};
}
std::array<double,4> derivative(double t) {
    const auto s=1-t;
    return {-3*s*s,3*s*s-6*s*t,6*s*t-3*t*t,3*t*t};
}
Vec3 evaluate_basis(const Patch& p,const std::array<double,4>& u,const std::array<double,4>& v) {
    Vec3 result;
    for(std::size_t r=0;r<4;++r) for(std::size_t c=0;c<4;++c) result+=p.points[r*4+c]*(u[r]*v[c]);
    return result;
}
struct TriangleHit { double t,a,b; };
std::optional<TriangleHit> triangle(Vec3 origin,Vec3 direction,Vec3 a,Vec3 b,Vec3 c) {
    const auto ab=b-a,ac=c-a,p=cross(direction,ac);
    const auto det=dot(ab,p);
    if(std::abs(det)<1e-12) return {};
    const auto s=origin-a;
    const auto u=dot(s,p)/det;
    if(u< -1e-8||u>1+1e-8) return {};
    const auto q=cross(s,ab);
    const auto v=dot(direction,q)/det;
    if(v< -1e-8||u+v>1+1e-8) return {};
    const auto t=dot(ac,q)/det;
    if(t<0||t>1) return {};
    return TriangleHit{t,u,v};
}
TerrainHit refine(const Patch& p,std::size_t index,Vec3 start,Vec3 direction,double u,double v,double t) {
    const auto seed_u=u,seed_v=v,seed_t=t;
    bool valid=true;
    // [Trailmap: 110-analytic-normal, 320-probe] Solve the patch/ray equation,
    // including ray t; evaluating only the coarse u/v seed is not a contact.
    for(unsigned i=0;i<4;++i) {
        const auto residual=p.evaluate(u,v)-(start+direction*t);
        if(length(residual)<1e-8) break;
        const auto tangents=p.tangents(u,v);
        const auto a=tangents[0],b=tangents[1],c=-direction;
        const auto det=dot(a,cross(b,c));
        if(std::abs(det)<1e-12) { valid=false;break; }
        u-=dot(residual,cross(b,c))/det;
        v-=dot(a,cross(residual,c))/det;
        t-=dot(a,cross(b,residual))/det;
        if(u< -1e-8||u>1+1e-8||v< -1e-8||v>1+1e-8||t<0||t>1) { valid=false;break; }
    }
    valid=valid&&length(p.evaluate(u,v)-(start+direction*t))<=0.001;
    if(!valid) { u=seed_u;v=seed_v;t=seed_t; }
    u=std::clamp(u,0.0,1.0);v=std::clamp(v,0.0,1.0);
    return {start+direction*t,p.normal(u,v),t,u,v,index,p.surface,valid};
}
}

Vec3 Patch::evaluate(double u,double v) const { return evaluate_basis(*this,basis(u),basis(v)); }
std::array<Vec3,2> Patch::tangents(double u,double v) const {
    return {evaluate_basis(*this,derivative(u),basis(v)),evaluate_basis(*this,basis(u),derivative(v))};
}
Vec3 Patch::normal(double u,double v) const {
    const auto t=tangents(u,v);
    auto n=normalized(cross(t[0],t[1]));
    if(n.y<0) n=-n; // Initial terrain player uses the skyward terrain side.
    return n;
}
Bounds Patch::bounds() const { Bounds b;for(auto p:points) b.add(p);return b; }

Terrain::Terrain(std::vector<Patch> patches):patches_(std::move(patches)) {
    if(patches_.empty()||patches_.size()>100000) throw std::runtime_error("A course must contain 1..100000 patches");
    samples_.resize(patches_.size());order_.resize(patches_.size());
    std::iota(order_.begin(),order_.end(),0);
    for(std::size_t p=0;p<patches_.size();++p) {
        for(auto v:patches_[p].points) {
            if(!finite(v)) throw std::runtime_error("Non-finite terrain control point");
            bounds_.add(v);
        }
        for(unsigned u=0;u<=8;++u) for(unsigned v=0;v<=8;++v)
            samples_[p].points[u*9+v]=patches_[p].evaluate(u/8.0,v/8.0);
    }
    build_node(0,patches_.size());
}
Terrain Terrain::load(const std::filesystem::path& map) {
    const auto path=std::filesystem::is_directory(map)?map/"Patches.json":map;
    if(std::filesystem::file_size(path)>128*1024*1024) throw std::runtime_error("Patches.json exceeds the prototype's 128 MiB limit");
    std::ifstream stream(path);
    if(!stream) throw std::runtime_error("Cannot open terrain: "+path.string());
    const auto doc=nlohmann::json::parse(stream);
    const auto& rows=doc.at("Patches");
    if(!rows.is_array()||rows.empty()||rows.size()>100000) throw std::runtime_error("Invalid terrain patch count");
    std::vector<Patch> patches;patches.reserve(rows.size());
    for(const auto& row:rows) {
        Patch p;
        p.name=row.at("PatchName").get<std::string>();
        p.surface=row.at("SurfaceType").get<int>();
        p.texture=row.at("TexturePath").get<std::string>();
        p.lightmap=row.at("LightmapID").get<int>();
        p.trick_only=row.at("TrickOnlyPatch").get<bool>();
        const auto& points=row.at("Points");
        if(!points.is_array()||points.size()!=16) throw std::runtime_error("Each patch requires 16 control points");
        for(std::size_t i=0;i<16;++i) {
            if(!points[i].is_array()||points[i].size()!=3) throw std::runtime_error("Each control point requires three coordinates");
            // [Trailmap: 002-axes] Same right-handed metre frame as Slopesmith.
            p.points[i]={-points[i][0].get<double>()/100,points[i][2].get<double>()/100,-points[i][1].get<double>()/100};
        }
        p.uv=row.at("UVPoints").get<decltype(p.uv)>();
        p.lightmap_rect=row.at("LightMapPoint").get<decltype(p.lightmap_rect)>();
        patches.push_back(std::move(p));
    }
    return Terrain(std::move(patches));
}
Terrain Terrain::demo() {
    std::vector<Patch> patches;
    for(unsigned segment=0;segment<12;++segment) {
        Patch p;p.name="Original prototype slope "+std::to_string(segment);
        for(unsigned u=0;u<4;++u) for(unsigned v=0;v<4;++v) {
            const auto distance=(segment+u/3.0)*40;
            const auto x=(v/3.0-0.5)*60;
            p.points[u*4+v]={x,80-distance*0.13+0.002*x*x,-distance};
        }
        patches.push_back(std::move(p));
    }
    return Terrain(std::move(patches));
}
int Terrain::build_node(std::size_t begin,std::size_t end) {
    const auto index=static_cast<int>(nodes_.size());nodes_.push_back({});
    Bounds b;
    for(auto i=begin;i<end;++i) { const auto pb=patches_[order_[i]].bounds();b.add(pb.min);b.add(pb.max); }
    nodes_[index]={b,begin,end,-1,-1};
    if(end-begin>8) {
        const auto span=b.max-b.min;
        const int axis=span.x>span.y&&span.x>span.z?0:span.y>span.z?1:2;
        const auto center=[&](std::size_t p) { const auto c=patches_[p].bounds().center();return axis==0?c.x:axis==1?c.y:c.z; };
        const auto mid=begin+(end-begin)/2;
        std::nth_element(order_.begin()+begin,order_.begin()+mid,order_.begin()+end,[&](auto a,auto c){return center(a)<center(c);});
        const auto left=build_node(begin,mid),right=build_node(mid,end);
        nodes_[index].left=left;nodes_[index].right=right;
    }
    return index;
}
void Terrain::intersect_node(int node,Vec3 start,Vec3 direction,std::optional<TerrainHit>& hit) const {
    const auto& n=nodes_[node];if(!n.bounds.intersects(start,direction)) return;
    if(n.left>=0) { intersect_node(n.left,start,direction,hit);intersect_node(n.right,start,direction,hit);return; }
    for(auto i=n.begin;i<n.end;++i) {
        const auto index=order_[i];const auto& p=patches_[index];
        if(p.surface==17||!p.bounds().intersects(start,direction)) continue;
        const auto& sample=samples_[index].points;
        for(unsigned u=0;u<8;++u) for(unsigned v=0;v<8;++v) {
            const auto a=sample[u*9+v],b=sample[(u+1)*9+v],c=sample[(u+1)*9+v+1],d=sample[u*9+v+1];
            const auto accept=[&](const std::optional<TriangleHit>& coarse,bool second) {
                if(!coarse) return;
                const auto du=second?coarse->a:coarse->a+coarse->b;
                const auto dv=second?coarse->a+coarse->b:coarse->b;
                auto candidate=refine(p,index,start,direction,(u+du)/8,(v+dv)/8,coarse->t);
                if(!hit||candidate.t<hit->t) hit=candidate;
            };
            accept(triangle(start,direction,a,b,c),false);accept(triangle(start,direction,a,c,d),true);
        }
    }
}
std::optional<TerrainHit> Terrain::intersect(Vec3 start,Vec3 end) const {
    if(!finite(start)||!finite(end)||length(end-start)<1e-12) return {};
    std::optional<TerrainHit> hit;intersect_node(0,start,end-start,hit);return hit;
}
Mesh Terrain::mesh(unsigned subdivisions) const {
    if(subdivisions<1||subdivisions>32) throw std::runtime_error("Terrain subdivisions must be 1..32");
    if(patches_.size()*(subdivisions+1)*(subdivisions+1)>8000000) throw std::runtime_error("Requested terrain mesh exceeds 8 million vertices");
    Mesh mesh;
    for(const auto& p:patches_) {
        const auto first=static_cast<std::uint32_t>(mesh.vertices.size());
        for(unsigned u=0;u<=subdivisions;++u) for(unsigned v=0;v<=subdivisions;++v) {
            const auto point=p.evaluate(u/double(subdivisions),v/double(subdivisions));
            const auto normal=p.normal(u/double(subdivisions),v/double(subdivisions));
            const auto light=static_cast<float>(.48+.52*std::max(0.0,dot(normal,normalized(Vec3{-.3,.9,.2}))));
            const auto ice=p.surface==5;
            const auto rock=p.surface==9;
            mesh.vertices.push_back({static_cast<float>(point.x),static_cast<float>(point.y),static_cast<float>(point.z),light*(rock?.48f:ice?.55f:.91f),light*(rock?.44f:ice?.82f:.96f),light});
        }
        for(unsigned u=0;u<subdivisions;++u) for(unsigned v=0;v<subdivisions;++v) {
            const auto a=first+u*(subdivisions+1)+v,b=a+subdivisions+1;
            mesh.indices.insert(mesh.indices.end(),{a,b,b+1,a,b+1,a+1});
        }
    }
    return mesh;
}
std::pair<Vec3,Vec3> Terrain::spawn() const {
    const Patch* best=nullptr;double height=-std::numeric_limits<double>::infinity();
    for(const auto& p:patches_) {
        if(p.surface==0||p.surface==17||p.normal(.5,.5).y<.5) continue;
        const auto y=std::max(p.evaluate(.03,.5).y,p.evaluate(.97,.5).y);
        if(y>height) {height=y;best=&p;}
    }
    if(!best) throw std::runtime_error("No rideable skyward terrain found");
    const auto u=best->evaluate(.03,.5).y>best->evaluate(.97,.5).y?.03:.97;
    const auto position=best->evaluate(u,.5);
    auto downhill=project(Vec3{0,-1,0},best->normal(u,.5));
    if(length(downhill)<.01) downhill=best->tangents(u,.5)[0];
    return {position,normalized(downhill,{0,0,-1})};
}
}
