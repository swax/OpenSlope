#include "openslope/player.hpp"
#include <iostream>

int main(int argc,char** argv) {
    try {
        auto terrain=argc>1?openslope::Terrain::load(argv[1]):openslope::Terrain::demo();
        const auto mesh=terrain.mesh(8);const auto bounds=terrain.bounds();
        std::cout<<"Patches: "<<terrain.patches().size()<<"; vertices: "<<mesh.vertices.size()<<"; triangles: "<<mesh.indices.size()/3<<'\n';
        std::cout<<"Bounds (metres): ["<<bounds.min.x<<','<<bounds.min.y<<','<<bounds.min.z<<"] -> ["<<bounds.max.x<<','<<bounds.max.y<<','<<bounds.max.z<<"]\n";
        openslope::Player player(std::move(terrain));
        for(unsigned i=0;i<600;++i) player.tick({});
        const auto& r=player.rider();
        std::cout<<"After 600 fixed ticks: ["<<r.position.x<<','<<r.position.y<<','<<r.position.z<<"], speed "<<openslope::length(r.velocity)<<" m/s\n";
        return 0;
    } catch(const std::exception& e) {std::cerr<<"OpenSlope native: "<<e.what()<<'\n';return 1;}
}
