#include "openxr_app.hpp"
#include <iostream>

int main(int argc,char** argv) {
    try {
        openslope::Player player(argc>1?openslope::Terrain::load(argv[1]):openslope::Terrain::demo());
        return openslope::run_openxr(player);
    }catch(const std::exception& e){std::cerr<<"OpenSlope native: "<<e.what()<<'\n';return 1;}
}
