#include "openslope/appearance.hpp"
#include "openslope/import.hpp"
#include "openslope/props.hpp"
#include "openslope/riding_effects.hpp"
#include <lodepng.h>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <set>
#include <sstream>
#include <stdexcept>

namespace openslope {
namespace {
constexpr std::size_t image_limit=64*1024*1024,scene_limit=256*1024*1024;
std::string diffuse_file(const std::string& name) {
    if(!valid_map_name(name)||std::filesystem::path(name).filename().string()!=name)throw std::runtime_error("A terrain texture must name a file inside Textures");
    return "Textures/"+name;
}
std::string lightmap_file(int id) {
    if(id<0||id>65535)throw std::runtime_error("Lightmap page index is outside the supported range");
    std::ostringstream name;name<<"Lightmaps/"<<std::setfill('0')<<std::setw(4)<<id<<".png";return name.str();
}
std::vector<std::string> image_names(std::span<const MeshBatch> batches) {
    std::set<std::string> names;
    for(const auto& batch:batches){if(!batch.texture.empty())names.insert(diffuse_file(batch.texture));if(batch.lightmap>=0)names.insert(lightmap_file(batch.lightmap));}
    return {names.begin(),names.end()};
}
std::vector<MeshBatch> terrain_batches(const Terrain& terrain) {
    std::vector<MeshBatch> batches;
    for(const auto& patch:terrain.patches())batches.push_back({0,0,patch.texture,patch.lightmap_rect[2]>0&&patch.lightmap_rect[3]>0?patch.lightmap:-1});
    for(const auto& name:prop_files(terrain.map_root()))if(name.starts_with("Textures/"))batches.push_back({0,0,name.substr(9),-1});
    for(const auto slot:{"Puff","Wake"}){const auto sprite=riding_sprite(terrain.map_root(),slot);if(!sprite.empty())batches.push_back({0,0,sprite,-1});}
    return batches;
}
}
RgbaImage read_png(const std::filesystem::path& path) {
    const auto size=std::filesystem::file_size(path);if(size<33||size>image_limit)throw std::runtime_error("PNG file exceeds the supported size: "+path.filename().string());
    std::ifstream file(path,std::ios::binary);std::vector<unsigned char> bytes(static_cast<std::size_t>(size));file.read(reinterpret_cast<char*>(bytes.data()),static_cast<std::streamsize>(size));if(!file)throw std::runtime_error("Cannot read PNG: "+path.filename().string());
    lodepng::State state;RgbaImage image;
    auto error=lodepng_inspect(&image.width,&image.height,&state,bytes.data(),bytes.size());
    if(error)throw std::runtime_error(std::string("Invalid PNG header: ")+lodepng_error_text(error));
    if(!image.width||!image.height||image.width>4096||image.height>4096||std::uint64_t(image.width)*image.height*4>image_limit)throw std::runtime_error("PNG dimensions exceed the supported size");
    state.decoder.zlibsettings.max_output_size=(std::size_t(image.width)*8+1)*image.height*2+4096;
    error=lodepng::decode(image.pixels,image.width,image.height,state,bytes);
    if(error)throw std::runtime_error("Cannot decode "+path.filename().string()+": "+lodepng_error_text(error));
    if(image.pixels.size()!=std::size_t(image.width)*image.height*4)throw std::runtime_error("PNG decoder returned an invalid RGBA buffer");
    return image;
}
std::vector<std::string> referenced_images(const Terrain& terrain) {
    return image_names(terrain_batches(terrain));
}
Appearance Appearance::load(const Terrain& terrain) {return load(terrain.map_root(),terrain_batches(terrain));}
Appearance Appearance::load(const std::filesystem::path& root,std::span<const MeshBatch> batches) {
    Appearance result;if(root.empty())return result;
    std::size_t total=0;const auto base=std::filesystem::weakly_canonical(root);
    for(const auto& name:image_names(batches)) {
        const auto path=std::filesystem::weakly_canonical(base/name);const auto relative=path.lexically_relative(base);
        if(relative.empty()||relative.is_absolute()||*relative.begin()=="..")throw std::runtime_error("Map image resolves outside its course folder");
        if(!std::filesystem::is_regular_file(path)){result.missing.push_back(name);continue;}
        auto image=read_png(path);total+=image.pixels.size();if(total>scene_limit)throw std::runtime_error("Map textures exceed the 256 MiB decoded image budget");
        result.images.emplace(name,std::move(image));
    }
    return result;
}
std::array<double,3> terrain_light(std::array<double,3> base,std::array<double,4> lightmap) {
    for(unsigned c=0;c<3;++c)base[c]=std::clamp((base[c]-lightmap[c])*lightmap[3],0.0,1.0);
    return base;
}
std::vector<RgbaImage> diffuse_mips(const RgbaImage& base) {
    if(!base.width||!base.height||base.width>4096||base.height>4096||base.pixels.size()!=std::size_t(base.width)*base.height*4)throw std::runtime_error("Invalid diffuse mip input");
    std::vector<RgbaImage> levels{base};
    while(levels.back().width>1||levels.back().height>1){
        const auto& source=levels.back();RgbaImage next{std::max(1u,source.width/2),std::max(1u,source.height/2),{}};next.pixels.resize(std::size_t(next.width)*next.height*4);
        for(unsigned y=0;y<next.height;++y){for(unsigned x=0;x<next.width;++x){
            const double left=double(x)*source.width/next.width,right=double(x+1)*source.width/next.width,top=double(y)*source.height/next.height,bottom=double(y+1)*source.height/next.height;
            std::array<double,3> colour{};double alpha=0,area=0;
            for(unsigned sy=unsigned(top);sy<unsigned(std::ceil(bottom));++sy)for(unsigned sx=unsigned(left);sx<unsigned(std::ceil(right));++sx){
                const auto weight=(std::min(right,double(sx+1))-std::max(left,double(sx)))*(std::min(bottom,double(sy+1))-std::max(top,double(sy)));const auto p=(std::size_t(sy)*source.width+sx)*4;area+=weight;alpha+=weight*source.pixels[p+3];for(unsigned c=0;c<3;++c)colour[c]+=weight*source.pixels[p+c]*source.pixels[p+3];
            }
            const auto p=(std::size_t(y)*next.width+x)*4;for(unsigned c=0;c<3;++c)next.pixels[p+c]=std::uint8_t(std::clamp(std::lround(alpha>0?colour[c]/alpha:0),0l,255l));next.pixels[p+3]=std::uint8_t(std::clamp(std::lround(alpha/area),0l,255l));
        }}
        levels.push_back(std::move(next));
    }return levels;
}
}
