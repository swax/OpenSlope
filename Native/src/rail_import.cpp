#include "import_internal.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <sstream>

namespace openslope::import_detail {
namespace {
using Json=nlohmann::json;
std::vector<std::string> labels(Bytes linker,std::size_t count){
    std::vector<std::string> result;if(!count)return result;std::istringstream input(linker.text(0,linker.data.size()));std::string line;bool active=false;while(std::getline(input,line)){if(!active){if(line.find("SPLINES BEGIN")!=std::string::npos)active=true;continue;}if(line.find("SPLINES END")!=std::string::npos)break;if(line.empty()||line.front()=='\r'||line.front()=='#')continue;if(line.size()<82)throw std::runtime_error("Invalid spline linker row");auto label=line.substr(0,82);while(!label.empty()&&label.back()==' ')label.pop_back();result.push_back(label);if(result.size()==count)break;}if(result.size()!=count)throw std::runtime_error("Spline linker count disagrees with geometry");return result;
}
std::array<double,3> vector(Bytes b,std::size_t p){return {b.number(p),b.number(p+4),b.number(p+8)};}
}
void write_rails(const std::vector<std::uint8_t>& geometry,const std::vector<std::uint8_t>& linker,const std::vector<std::uint8_t>* behavior,const std::filesystem::path& output,const ImportCancel& cancel){
    // [Trailmap: 220-spline, 220-segment, 220-segment-engine, 230-splines]
    Bytes b{geometry};b.range(0,136);const auto count=b.le(32),segments=b.le(36);if(count>10000||segments>100000)throw std::runtime_error("Spline import exceeds its limits");b.range(b.le(92),std::size_t(count)*40);b.range(b.le(96),std::size_t(segments)*128);const auto names=labels(Bytes{linker},count);Bytes ssf{behavior?std::span<const std::uint8_t>(*behavior):std::span<const std::uint8_t>{}};
    if(behavior){ssf.range(0,76);if(ssf.le(4,2)!=0x1500||ssf.le(68)!=count||ssf.le(60)!=b.le(12))throw std::runtime_error("Spline behavior join disagrees with geometry");ssf.range(ssf.le(72),std::size_t(count)*8);}
    std::vector<bool> used(segments);Json rows=Json::array();
    for(unsigned i=0;i<count;++i){check_cancel(cancel);const auto p=b.le(92)+i*40,first=b.le(p+32),n=b.le(p+28);if(first>segments||n>segments-first)throw std::runtime_error("Invalid spline segment span");Json row={{"SplineName",names[i]},{"U0",behavior?ssf.signed16(ssf.le(72)+i*8):-1},{"U1",behavior?ssf.signed16(ssf.le(72)+i*8+2):0},{"SplineStyle",behavior?static_cast<std::int32_t>(ssf.le(ssf.le(72)+i*8+4)):-1},{"Segments",Json::array()}};
        for(unsigned j=0;j<n;++j){check_cancel(cancel);const auto id=first+j,s=b.le(96)+id*128;if(used[id]||b.le(s+88)!=i)throw std::runtime_error("Spline segment owner/span mismatch");used[id]=true;const auto previous=static_cast<std::int32_t>(b.le(s+80)),next=static_cast<std::int32_t>(b.le(s+84));if(previous< -1||next< -1||(previous>=0&&unsigned(previous)>=segments)||(next>=0&&unsigned(next)>=segments))throw std::runtime_error("Invalid spline links");
            std::array<std::array<double,3>,4> power{},points{};for(unsigned k=0;k<4;++k)power[k]=vector(b,s+k*16);for(unsigned axis=0;axis<3;++axis){points[0][axis]=power[3][axis];points[1][axis]=power[3][axis]+power[2][axis]/3;points[2][axis]=power[3][axis]+power[2][axis]*2/3+power[1][axis]/3;points[3][axis]=power[3][axis]+power[2][axis]+power[1][axis]+power[0][axis];}
            std::array<double,4> arc{};for(unsigned k=0;k<4;++k)arc[k]=b.number(s+64+k*4);const auto length=b.number(s+116),distance=b.number(s+120);if(length<0||distance<0)throw std::runtime_error("Invalid spline arc-length metadata");row["Segments"].push_back({{"Points",points},{"PowerCoefficients",power},{"ArcLengthCoefficients",arc},{"Length",length},{"Distance",distance},{"Previous",previous},{"Next",next},{"SourceSegment",id}});
        }rows.push_back(row);
    }
    if(std::find(used.begin(),used.end(),false)!=used.end())throw std::runtime_error("Unowned spline segment");const Json doc={{"Splines",rows}};const auto text=doc.dump();if(text.size()>64*1024*1024)throw std::runtime_error("Spline metadata exceeds 64 MiB");std::ofstream file(output/"Splines.json",std::ios::binary);file<<text<<'\n';if(!file)throw std::runtime_error("Cannot write rail metadata");
}
}
