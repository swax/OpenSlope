#include "openslope/avatar.hpp"
#include "figure.hpp"
#include <nlohmann/json.hpp>
#include <cstring>
#include <stdexcept>

namespace openslope {
namespace {
using J=AvatarJoint;
constexpr unsigned id(J j){return unsigned(j);}
Vec3 knee(Vec3 hip,Vec3 ankle,Vec3 bend,double upper,double lower){
    const auto delta=ankle-hip;const auto d=std::clamp(length(delta),.05,upper+lower-.001);const auto axis=normalized(delta,{0,-1,0});
    const auto along=(upper*upper-lower*lower+d*d)/(2*d),height=std::sqrt(std::max(0.,upper*upper-along*along));
    return hip+axis*along+normalized(project(bend,axis),{0,0,-1})*height;
}
Vec3 align(Vec3 v,Vec3 from,Vec3 to){
    from=normalized(from);to=normalized(to);const auto c=std::clamp(dot(from,to),-1.,1.);const auto axis=cross(from,to);
    if(c<-.999999)return rotate(v,normalized(cross(from,std::abs(from.x)<.8?Vec3{1,0,0}:Vec3{0,1,0})),pi);
    return v+cross(axis,v)+cross(axis,cross(axis,v))/(1+c);
}
Vertex vertex(Vec3 p,std::array<float,3> c){return {float(p.x),float(p.y),float(p.z),c[0],c[1],c[2]};}
void quad(std::vector<Vertex>& out,Vec3 a,Vec3 b,Vec3 c,Vec3 d,std::array<float,3> colour){for(auto p:{a,b,c,a,c,d})out.push_back(vertex(p,colour));}
void tube(std::vector<Vertex>& out,Vec3 a,Vec3 b,double radius,std::array<float,3> colour){
    const auto axis=normalized(b-a),r=normalized(cross(axis,std::abs(axis.y)<.8?Vec3{0,1,0}:Vec3{1,0,0})),u=cross(axis,r);
    for(unsigned i=0;i<12;++i){const auto t=i*2*pi/12,s=(i+1)*2*pi/12;const auto x=(r*std::cos(t)+u*std::sin(t))*radius,y=(r*std::cos(s)+u*std::sin(s))*radius;quad(out,a+x,a+y,b+y,b+x,colour);out.push_back(vertex(a,colour));out.push_back(vertex(a+y,colour));out.push_back(vertex(a+x,colour));out.push_back(vertex(b,colour));out.push_back(vertex(b+x,colour));out.push_back(vertex(b+y,colour));}
}
// An authored five-column font; pixels become ordinary depth-tested triangles.
std::array<unsigned char,7> glyph(char c){
    switch(c){
    case 'A':return {14,17,17,31,17,17,17};case 'B':return {30,17,17,30,17,17,30};case 'C':return {14,17,16,16,16,17,14};case 'D':return {30,17,17,17,17,17,30};
    case 'E':return {31,16,16,30,16,16,31};case 'F':return {31,16,16,30,16,16,16};case 'G':return {14,17,16,23,17,17,14};case 'H':return {17,17,17,31,17,17,17};
    case 'I':return {31,4,4,4,4,4,31};case 'J':return {7,2,2,2,2,18,12};case 'K':return {17,18,20,24,20,18,17};case 'L':return {16,16,16,16,16,16,31};
    case 'M':return {17,27,21,21,17,17,17};case 'N':return {17,25,25,21,19,19,17};case 'O':return {14,17,17,17,17,17,14};case 'P':return {30,17,17,30,16,16,16};
    case 'Q':return {14,17,17,17,21,18,13};case 'R':return {30,17,17,30,20,18,17};case 'S':return {15,16,16,14,1,1,30};case 'T':return {31,4,4,4,4,4,4};
    case 'U':return {17,17,17,17,17,17,14};case 'V':return {17,17,17,17,17,10,4};case 'W':return {17,17,17,21,21,21,10};case 'X':return {17,17,10,4,10,17,17};
    case 'Y':return {17,17,10,4,4,4,4};case 'Z':return {31,1,2,4,8,16,31};case '/':return {1,2,2,4,8,8,16};case '-':return {0,0,0,31,0,0,0};default:return {};
    }
}
void label(std::vector<Vertex>& out,std::string_view text,Vec3 anchor,Vec3 eye,double row){
    const auto normal=normalized(eye-anchor,{0,0,1}),right=normalized(cross({0,1,0},normal),{1,0,0}),up=normalized(cross(normal,right));
    constexpr double pixel=.002;const auto width=double(text.size())*6*pixel;const auto base=anchor+up*row-right*(width*.5);
    quad(out,base-right*.003-up*.003,base+right*(width+.003)-up*.003,base+right*(width+.003)+up*.017,base-right*.003+up*.017,{.035f,.045f,.065f});
    for(std::size_t i=0;i<text.size();++i){const auto bits=glyph(text[i]);for(unsigned y=0;y<7;++y)for(unsigned x=0;x<5;++x)if(bits[y]&(1u<<(4-x))){const auto p=base+right*(double(i*6+x)*pixel)+up*((6-y)*pixel)+normal*.0005;quad(out,p,p+right*pixel,p+(right+up)*pixel,p+up*pixel,{1,1,1});}}
}
void controller(std::vector<Vertex>& out,const ControllerPose& c,unsigned side,bool labels,Vec3 eye,bool on_foot){
    if(!c.valid)return;const auto colour=side?std::array<float,3>{1,.62f,.14f}:std::array<float,3>{.52f,.94f,.20f};
    const auto top=c.position+c.up*.04+c.forward*.015;
    tube(out,c.position-c.up*.09,top,.026,{.22f,.25f,.3f});tube(out,top-c.up*.014,top+c.up*.014,.043,{.1f,.12f,.17f});
    tube(out,top+c.up*.016-c.right*.015,top+c.up*.026-c.right*.015,.011,colour);
    tube(out,top+c.up*.016+c.right*.022-c.forward*.008,top+c.up*.020+c.right*.022-c.forward*.008,.008,colour);
    tube(out,c.position+c.forward*.027,c.position+c.forward*.043,.012,{.72f,.77f,.84f});
    if(labels){const auto anchor=top+c.up*.07+c.forward*.08;tube(out,top,anchor,.0015,colour);
        if(c.touch){if(on_foot){if(side){label(out,"TRIGGER RUN",anchor,eye,.050);label(out,"A JUMP",anchor,eye,.025);label(out,"B MOUNT BOARD",anchor,eye,0);}else{label(out,"STICK WALK",anchor,eye,.025);label(out,"X RESET",anchor,eye,0);}}else if(side){label(out,"TRIGGER BOOST",anchor,eye,.050);label(out,"A HOLD JUMP",anchor,eye,.025);label(out,"RELEASE TO JUMP",anchor,eye,0);label(out,"B DISMOUNT",anchor,eye,-.025);}else{label(out,"STICK STEER",anchor,eye,.075);label(out,"UP TUCK / DOWN BRAKE",anchor,eye,.050);label(out,"CLICK EXIT RAIL",anchor,eye,.025);label(out,"X RESET",anchor,eye,0);}}
        else{label(out,"SELECT JUMP",anchor,eye,.025);label(out,"LEFT MENU RESET",anchor,eye,0);label(out,on_foot?"RIGHT MENU MOUNT":"RIGHT MENU DISMOUNT",anchor,eye,-.025);}
    }
}
struct BoneTarget{Vec3 head,tail;};
BoneTarget target(std::string_view name,const AvatarPose& p){
    const auto pair=[&](J a,J b){return BoneTarget{p.joint(a),p.joint(b)};};
    if(name=="Hips")return pair(J::Hips,J::Spine);if(name=="Spine")return pair(J::Spine,J::Chest);if(name=="Chest")return pair(J::Chest,J::Neck);if(name=="Neck")return pair(J::Neck,J::Head);if(name=="Head")return {p.joint(J::Head),p.joint(J::Head)+p.up*.105};
    const bool left=name.ends_with(".L");if(name.starts_with("Clavicle"))return pair(J::Neck,left?J::LeftShoulder:J::RightShoulder);
    if(name.starts_with("UpperArm"))return pair(left?J::LeftShoulder:J::RightShoulder,left?J::LeftElbow:J::RightElbow);
    if(name.starts_with("LowerArm"))return pair(left?J::LeftElbow:J::RightElbow,left?J::LeftWrist:J::RightWrist);
    if(name.starts_with("Hand")){const auto h=p.joint(left?J::LeftWrist:J::RightWrist);const auto& c=p.controllers[left?0:1];return {h,h+(c.valid?c.forward:-p.up)*.1};}
    if(name.starts_with("Pelvis"))return pair(J::Hips,left?J::LeftHip:J::RightHip);
    if(name.starts_with("UpperLeg"))return pair(left?J::LeftHip:J::RightHip,left?J::LeftKnee:J::RightKnee);
    if(name.starts_with("LowerLeg"))return pair(left?J::LeftKnee:J::RightKnee,left?J::LeftAnkle:J::RightAnkle);
    if(name.starts_with("Foot"))return pair(left?J::LeftAnkle:J::RightAnkle,left?J::LeftToe:J::RightToe);
    throw std::runtime_error("Unknown figure bone");
}
}
AvatarPose avatar_pose(const Player& player,const AvatarTracking* tracking){
    if(tracking&&(!finite(tracking->head)||!finite(tracking->forward)||!finite(tracking->up)))tracking=nullptr;
    AvatarPose p;p.on_foot=player.on_foot();const auto root=p.on_foot?player.render_position():player.render_board_position();const auto& rider=player.rider();const auto crouch=std::clamp(rider.crouch,0.,1.);
    p.up=p.on_foot?Vec3{0,1,0}:player.render_up();p.forward=p.on_foot?rider.forward:normalized(rotate(player.render_forward(),p.up,-pi*.5*rider.lead));const auto right=normalized(cross(p.forward,p.up));
    const auto at=[&](double x,double y,double z){return root+right*x+p.up*y+p.forward*z;};
    p.joints[id(J::Hips)]=at(0,1.0364-.35*crouch,.04*crouch);p.joints[id(J::Spine)]=p.joint(J::Hips)+p.up*.14+p.forward*(.09*crouch);
    p.joints[id(J::Chest)]=p.joint(J::Spine)+p.up*.052+p.forward*(.03*crouch);p.joints[id(J::Neck)]=p.joint(J::Chest)+p.up*.242;p.joints[id(J::Head)]=p.joint(J::Neck)+p.up*.075;
    if(tracking){
        p.up={0,1,0};p.forward=normalized(project(tracking->forward,p.up),player.camera_forward());
        const auto r=normalized(cross(p.forward,p.up));const auto h=tracking->head;
        p.joints[id(J::Head)]=h-p.up*.105;p.joints[id(J::Neck)]=h-p.up*.18;p.joints[id(J::Chest)]=h-p.up*.422;p.joints[id(J::Spine)]=h-p.up*.474;p.joints[id(J::Hips)]=h-p.up*.614;
        for(unsigned side=0;side<2;++side)p.joints[id(side?J::RightShoulder:J::LeftShoulder)]=p.joint(J::Neck)+r*(side?.165:-.165)-p.up*.075;
        if(tracking->body_active&&std::isfinite(tracking->confidence)&&tracking->confidence>.05f){for(unsigned i=0;i<avatar_joint_count;++i)if(tracking->valid[i]&&finite(tracking->joints[i])&&length(tracking->joints[i]-h)<2.5){p.joints[i]=tracking->joints[i];p.tracked_body=true;}}
        p.controllers=tracking->controllers;
        for(auto& c:p.controllers){if(!finite(c.position)||!finite(c.right)||!finite(c.up)||!finite(c.forward)||length(c.up)<.5||length(c.forward)<.5||length(cross(c.forward,c.up))<.5)c.valid=false;else{c.forward=normalized(c.forward);c.right=normalized(cross(c.forward,c.up));c.up=normalized(cross(c.right,c.forward));}}
    }
    const auto body_right=normalized(cross(p.forward,p.up));
    for(unsigned side=0;side<2;++side){const bool r=side!=0;const auto sign=r?1.:-1.;const J shoulder=r?J::RightShoulder:J::LeftShoulder,elbow=r?J::RightElbow:J::LeftElbow,wrist=r?J::RightWrist:J::LeftWrist,hip=r?J::RightHip:J::LeftHip,k=r?J::RightKnee:J::LeftKnee,ankle=r?J::RightAnkle:J::LeftAnkle,toe=r?J::RightToe:J::LeftToe;
        const auto tracked=[&](J j){return p.tracked_body&&tracking->valid[id(j)]&&finite(tracking->joints[id(j)])&&length(tracking->joints[id(j)]-tracking->head)<2.5;};
        if(!tracking)p.joints[id(shoulder)]=p.joint(J::Neck)+body_right*(sign*.165)-p.up*.075;
        if(!tracked(wrist))p.joints[id(wrist)]=p.joint(shoulder)+body_right*(sign*.19)+p.forward*.10-p.up*(.49-.10*crouch);
        if(p.controllers[side].valid&&finite(p.controllers[side].position)&&length(p.controllers[side].position-p.joint(shoulder))<1.2)p.joints[id(wrist)]=p.controllers[side].position;else p.controllers[side].valid=false;
        if(!tracked(elbow))p.joints[id(elbow)]=knee(p.joint(shoulder),p.joint(wrist),-p.forward+body_right*sign,.3162,.2482);
        if(!tracked(hip))p.joints[id(hip)]=p.joint(J::Hips)+body_right*(sign*.105)-p.up*.08;
        if(!tracked(ankle)){const auto stride=p.on_foot?std::sin(player.walk_phase()+side*pi)*std::min(.18,length(project(rider.velocity,{0,1,0}))*.05):0.;p.joints[id(ankle)]=at(sign*(p.on_foot?.105:.27),.12+std::max(0.,stride)*.2,stride);if(tracking){const auto along=normalized(project(player.render_forward(),{0,1,0}),player.camera_forward());p.joints[id(ankle)]=p.on_foot?root+project(tracking->head-root,{0,1,0})+body_right*(sign*.105)+p.forward*stride+Vec3{0,.12+std::max(0.,stride)*.2,0}:root+project(tracking->head-root,{0,1,0})+along*(-sign*.27)+Vec3{0,.12,0};}}
        if(!tracked(k))p.joints[id(k)]=knee(p.joint(hip),p.joint(ankle),p.forward,.4165,.4182);
        if(!tracked(toe))p.joints[id(toe)]=p.joint(ankle)+p.forward*.13-p.up*.068;
    }
    p.tracked_legs=p.tracked_body&&tracking->full_body;
    if(p.tracked_legs)for(unsigned i=id(J::LeftHip);i<avatar_joint_count;++i)p.tracked_legs=p.tracked_legs&&tracking->valid[i]&&finite(tracking->joints[i])&&length(tracking->joints[i]-tracking->head)<2.5;
    return p;
}

Avatar::Avatar(){
    const auto bytes=std::span(bundled::stick_figure);const auto word=[&](std::size_t offset){if(offset+4>bytes.size())throw std::runtime_error("Truncated figure");std::uint32_t v;std::memcpy(&v,bytes.data()+offset,4);return v;};
    if(word(0)!=0x46546c67||word(4)!=2||word(8)!=bytes.size()||word(16)!=0x4e4f534a)throw std::runtime_error("Invalid bundled figure");const auto json_size=word(12);const auto binary_header=std::size_t(20)+json_size;
    if(word(binary_header+4)!=0x004e4942||binary_header+8+word(binary_header)!=bytes.size())throw std::runtime_error("Invalid figure binary");const auto binary=bytes.subspan(binary_header+8);
    const auto data=nlohmann::json::parse(bytes.begin()+20,bytes.begin()+binary_header);const auto& nodes=data.at("nodes");const auto& skin=data.at("skins").at(0);const auto& joints=skin.at("joints");
    if(joints.size()>128||nodes.size()>256)throw std::runtime_error("Figure rig exceeds bounds");
    using M=std::array<double,16>;std::vector<M> global(nodes.size());std::vector<unsigned> parents(nodes.size(),0);
    for(unsigned i=0;i<nodes.size();++i)for(const auto& child:nodes[i].value("children",nlohmann::json::array()))parents.at(child.get<unsigned>())=i;
    for(unsigned i=0;i<nodes.size();++i){const auto local=nodes[i].value("matrix",M{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1});if(i&&parents[i]>=i)throw std::runtime_error("Figure rig is not ordered");auto& m=global[i];if(!i)m=local;else for(unsigned c=0;c<4;++c)for(unsigned r=0;r<4;++r)for(unsigned k=0;k<4;++k)m[c*4+r]+=global[parents[i]][k*4+r]*local[c*4+k];}
    const auto position=[&](unsigned node){const auto& m=global.at(node);return Vec3{m[12],m[13],m[14]};};
    for(unsigned i=0;i<joints.size();++i){const auto node=joints[i].get<unsigned>();const auto& m=global.at(node);auto head=position(node),tail=head+Vec3{m[4],m[5],m[6]}*.1;const auto children=nodes[node].value("children",nlohmann::json::array());if(!children.empty()&&!nodes[node].at("name").get<std::string>().starts_with("Hand"))tail=position(children.at(0).get<unsigned>());const auto parent_node=parents[node];unsigned parent=i;for(unsigned k=0;k<joints.size();++k)if(joints[k].get<unsigned>()==parent_node)parent=k;bones_.push_back({nodes[node].at("name").get<std::string>(),head,tail,parent});}
    const auto read=[&](unsigned accessor,unsigned component,unsigned type,unsigned lanes){const auto& a=data.at("accessors").at(accessor);if(a.at("componentType")!=type||a.value("normalized",false)||a.contains("sparse"))throw std::runtime_error("Unsupported figure accessor");const auto count=a.at("count").get<std::size_t>();if(count>30000)throw std::runtime_error("Figure accessor exceeds bounds");const auto& b=data.at("bufferViews").at(a.at("bufferView").get<unsigned>());const auto stride=b.value("byteStride",std::size_t(component*lanes)),offset=b.value("byteOffset",std::size_t(0))+a.value("byteOffset",std::size_t(0));if(b.value("buffer",0)!=0||stride<component*lanes||(count&&offset+(count-1)*stride+component*lanes>binary.size()))throw std::runtime_error("Figure accessor outside binary");std::vector<double> values;values.reserve(count*lanes);for(std::size_t i=0;i<count;++i)for(unsigned lane=0;lane<lanes;++lane){const auto* p=binary.data()+offset+i*stride+lane*component;double v=0;if(type==5126){float f;std::memcpy(&f,p,4);v=f;}else if(type==5125){std::uint32_t u;std::memcpy(&u,p,4);v=u;}else{std::uint16_t u;std::memcpy(&u,p,2);v=u;}if(!std::isfinite(v))throw std::runtime_error("Non-finite figure value");values.push_back(v);}return values;};
    const auto& primitives=data.at("meshes").at(0).at("primitives");const auto& attributes=primitives.at(0).at("attributes");const auto normals=read(attributes.at("NORMAL").get<unsigned>(),4,5126,3);const auto points=read(attributes.at("POSITION").get<unsigned>(),4,5126,3),bones=read(attributes.at("JOINTS_0").get<unsigned>(),2,5123,4),weights=read(attributes.at("WEIGHTS_0").get<unsigned>(),4,5126,4);
    if(points.size()!=normals.size()||points.size()/3!=bones.size()/4||bones.size()!=weights.size())throw std::runtime_error("Figure attribute counts differ");
    for(std::size_t i=0;i<points.size()/3;++i){const auto bone=unsigned(bones[i*4]);if(bone>=bones_.size()||weights[i*4]!=1||weights[i*4+1]!=0||weights[i*4+2]!=0||weights[i*4+3]!=0)throw std::runtime_error("Figure requires rigid skin weights");vertices_.push_back({{points[i*3],points[i*3+1],points[i*3+2]},{normals[i*3],normals[i*3+1],normals[i*3+2]},bone});}
    for(const auto& primitive:primitives){if(primitive.value("mode",4)!=4||primitive.at("attributes")!=attributes)throw std::runtime_error("Unsupported figure primitive");const auto& material=data.at("materials").at(primitive.at("material").get<unsigned>());const auto colour=material.at("pbrMetallicRoughness").value("baseColorFactor",std::array<double,4>{1,1,1,1});std::array<float,3> display{};for(unsigned c=0;c<3;++c)display[c]=float(colour[c]<=.0031308?colour[c]*12.92:1.055*std::pow(colour[c],1/2.4)-.055);const auto indices=read(primitive.at("indices").get<unsigned>(),4,5125,1);if(indices.size()%3)throw std::runtime_error("Incomplete figure triangle");for(const auto index:indices){if(index>=vertices_.size())throw std::runtime_error("Figure index out of bounds");corners_.push_back({unsigned(index),display});}}
    mesh_.reserve(corners_.size()+20000);
}
std::span<const Vertex> Avatar::mesh(const AvatarPose& p,bool first_person,bool labels,Vec3 eye){
    const auto right=normalized(cross(p.forward,p.up));const auto basis=[&](Vec3 v){return right*v.x+p.up*v.y+p.forward*v.z;};
    struct Transform{Vec3 origin,from,to,target;double scale;};std::vector<Transform> transforms;transforms.reserve(bones_.size());
    for(const auto& b:bones_){if(b.name.starts_with("LeftHand")||b.name.starts_with("RightHand")){transforms.push_back(transforms.at(b.parent));continue;}const auto t=target(b.name,p);const auto from=basis(b.tail-b.head),to=t.tail-t.head;transforms.push_back({b.head,from,to,t.head,std::clamp(length(to)/std::max(.001,length(from)),.5,1.5)});}
    std::vector<Vec3> posed;posed.reserve(vertices_.size());std::vector<double> lighting;lighting.reserve(vertices_.size());for(const auto& v:vertices_){const auto& t=transforms[v.bone];auto relative=basis(v.position-t.origin);const auto axis=normalized(t.from);relative+=axis*(dot(relative,axis)*(t.scale-1));posed.push_back(t.target+align(relative,t.from,t.to));const auto normal=normalized(align(basis(v.normal),t.from,t.to));lighting.push_back(.60+.40*std::max(0.,dot(normal,normalized(Vec3{-.3,.8,-.5}))));}
    mesh_.clear();for(std::size_t i=0;i<corners_.size();i+=3){bool hide=false;for(unsigned k=0;k<3;++k){const auto& name=bones_[vertices_[corners_[i+k].vertex].bone].name;hide|=first_person&&(name=="Head"||name=="Neck");}if(!hide)for(unsigned k=0;k<3;++k){const auto& c=corners_[i+k];auto colour=c.colour;for(auto& value:colour)value*=float(lighting[c.vertex]);mesh_.push_back(vertex(posed[c.vertex],colour));}}
    for(unsigned i=0;i<2;++i)controller(mesh_,p.controllers[i],i,labels,eye,p.on_foot);
    if(mesh_.size()>60000)throw std::runtime_error("Avatar submission exceeds bounds");return mesh_;
}
}
