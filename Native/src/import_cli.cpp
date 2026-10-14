#include "openslope/import.hpp"
#include <iostream>
#include <chrono>
#include <fstream>

int main(int argc,char** argv) {
    try {
        if(argc<3){std::cerr<<"Usage: openslope_import list <iso> | extract <iso> <course> <Maps-folder>\n";return 1;}
        const auto disc=openslope::open_disc(argv[2]);const std::string operation=argv[1];
        if(operation=="directory"&&argc==4){for(const auto& entry:openslope::disc_directory(disc,argv[3]))std::cout<<(entry.directory?"dir ":"file ")<<entry.name<<'\t'<<entry.bytes<<'\n';return 0;}
        if(operation=="read"&&argc==5){const auto data=openslope::disc_file(disc,argv[3]);if(std::filesystem::exists(argv[4]))throw std::runtime_error("Read destination already exists");std::ofstream file(argv[4],std::ios::binary);file.write(reinterpret_cast<const char*>(data.data()),static_cast<std::streamsize>(data.size()));if(!file)throw std::runtime_error("Cannot save disc file");return 0;}
        if(operation=="archive-directory"&&argc==4){for(const auto& entry:openslope::disc_archive_directory(disc,argv[3]))std::cout<<entry.name<<'\t'<<entry.bytes<<'\n';return 0;}
        if(operation=="read-archive"&&argc==6){const auto data=openslope::disc_archive_file(disc,argv[3],argv[4]);if(std::filesystem::exists(argv[5]))throw std::runtime_error("Read destination already exists");std::ofstream file(argv[5],std::ios::binary);file.write(reinterpret_cast<const char*>(data.data()),static_cast<std::streamsize>(data.size()));if(!file)throw std::runtime_error("Cannot save archive member");return 0;}
        if(operation=="list"){for(const auto& course:openslope::disc_courses(disc))std::cout<<course.name<<'\t'<<course.archive_bytes<<'\n';return 0;}
        if(operation!="extract"||argc!=5)throw std::runtime_error("Invalid import arguments");
        const std::string name=argv[3];if(!openslope::valid_map_name(name))throw std::runtime_error("Invalid map name");
        const auto root=std::filesystem::absolute(argv[4]);std::filesystem::create_directories(root);
        const auto destination=root/name;if(std::filesystem::exists(destination))throw std::runtime_error("Map already exists; choose an empty Maps folder for comparison");
        const auto staging=root/(".openslope-import-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        openslope::extract_course(disc,name,staging,[](const auto& text){std::cout<<text<<'\n';});
        try{std::filesystem::rename(staging,destination);}catch(...){std::filesystem::remove_all(staging);throw;}
        std::cout<<"Imported "<<destination.string()<<'\n';return 0;
    }catch(const std::exception& e){std::cerr<<"OpenSlope import: "<<e.what()<<'\n';return 1;}
}
