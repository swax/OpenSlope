#include "openslope/player.hpp"
#include "openslope/appearance.hpp"
#include "openslope/props.hpp"
#include "openslope/paths.hpp"
#include <iostream>

int main(int argc,char** argv) {
    try {
        auto terrain=argc>1?openslope::Terrain::load(argv[1]):openslope::Terrain::demo();
        const auto mesh=terrain.mesh(8);const auto bounds=terrain.bounds();
        std::cout<<"Patches: "<<terrain.patches().size()<<"; vertices: "<<mesh.vertices.size()<<"; triangles: "<<mesh.indices.size()/3<<'\n';
        const auto appearance=openslope::Appearance::load(terrain);std::size_t bytes=0;for(const auto& [name,image]:appearance.images)bytes+=image.pixels.size();
        std::cout<<"Map images: "<<appearance.images.size()<<" loaded; "<<appearance.missing.size()<<" missing; "<<bytes<<" decoded RGBA bytes; "<<mesh.batches.size()<<" draw batches\n";
        const auto props=openslope::Props::load(terrain.map_root());std::size_t visible=0;for(const auto& instance:props.instances)visible+=instance.visible?1:0;
        std::cout<<"Props: "<<props.models.size()<<" models; "<<props.parts.size()<<" mesh parts; "<<props.instances.size()<<" instances ("<<visible<<" authored visible); "<<props.geometry.vertices.size()<<" shared vertices\n";
        std::cout<<"Bounds (metres): ["<<bounds.min.x<<','<<bounds.min.y<<','<<bounds.min.z<<"] -> ["<<bounds.max.x<<','<<bounds.max.y<<','<<bounds.max.z<<"]\n";
        openslope::Player player(std::move(terrain));
        const auto paths=openslope::CoursePaths::load(player.terrain().map_root());const auto& start=player.rider();
        std::cout<<"Paths: "<<paths.ai.size()<<" AI; "<<paths.race.size()<<" race lines; "<<paths.starts.size()<<" start slots\nStart: ["<<start.position.x<<','<<start.position.y<<','<<start.position.z<<"], heading ["<<start.forward.x<<','<<start.forward.y<<','<<start.forward.z<<"]\n";
        for(unsigned i=0;i<600;++i) player.tick({});
        const auto& r=player.rider();
        std::cout<<"After 600 fixed ticks: ["<<r.position.x<<','<<r.position.y<<','<<r.position.z<<"], speed "<<openslope::length(r.velocity)<<" m/s\n";
        return 0;
    } catch(const std::exception& e) {std::cerr<<"OpenSlope native: "<<e.what()<<'\n';return 1;}
}
