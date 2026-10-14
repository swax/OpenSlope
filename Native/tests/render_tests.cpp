#include "vulkan_renderer.hpp"
#include <cmath>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks=0;
struct Target {
    VulkanContext& context;VkImage image{};VkDeviceMemory memory{};
    ~Target(){if(image)vkDestroyImage(context.device,image,nullptr);if(memory)vkFreeMemory(context.device,memory,nullptr);}
    void create(VkFormat format) {
        VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};info.imageType=VK_IMAGE_TYPE_2D;info.format=format;info.extent={128,128,1};info.mipLevels=1;info.arrayLayers=1;info.samples=VK_SAMPLE_COUNT_1_BIT;info.tiling=VK_IMAGE_TILING_OPTIMAL;info.usage=VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT|VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
        vk_check(vkCreateImage(context.device,&info,nullptr,&image),"Create test target");VkMemoryRequirements requirements;vkGetImageMemoryRequirements(context.device,image,&requirements);
        VkPhysicalDeviceMemoryProperties properties;vkGetPhysicalDeviceMemoryProperties(context.physical,&properties);std::uint32_t type=UINT32_MAX;
        for(std::uint32_t i=0;i<properties.memoryTypeCount;++i)if((requirements.memoryTypeBits&(1u<<i))&&(properties.memoryTypes[i].propertyFlags&VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)){type=i;break;}
        if(type==UINT32_MAX)throw std::runtime_error("No test image memory");
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};allocation.allocationSize=requirements.size;allocation.memoryTypeIndex=type;vk_check(vkAllocateMemory(context.device,&allocation,nullptr,&memory),"Allocate test image");vk_check(vkBindImageMemory(context.device,image,memory,0),"Bind test image");
    }
};
std::vector<unsigned char> capture(VulkanRenderer& renderer,const std::filesystem::path& output,const Matrix& camera) {
    auto board=Matrix::identity();board.values[12]=10;
    renderer.render(0,camera,board,VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL);renderer.capture(0,output);
    std::ifstream file(output,std::ios::binary);std::string magic;unsigned width,height,maximum;file>>magic>>width>>height>>maximum;file.get();
    if(magic!="P6"||width!=128||height!=128||maximum!=255)throw std::runtime_error("Invalid GPU capture");
    std::vector<unsigned char> pixels(128*128*3);file.read(reinterpret_cast<char*>(pixels.data()),pixels.size());if(!file)throw std::runtime_error("Truncated GPU capture");return pixels;
}
void pixel(const std::vector<unsigned char>& pixels,double u,double v,std::array<int,3> expected) {
    const auto x=unsigned((.1+.8*u)*128),y=unsigned((.1+.8*v)*128);
    for(unsigned c=0;c<3;++c){++checks;const auto actual=int(pixels[(y*128+x)*3+c]);if(std::abs(actual-expected[c])>1)throw std::runtime_error("GPU pixel differs at ("+std::to_string(u)+","+std::to_string(v)+"), channel "+std::to_string(c)+": "+std::to_string(actual)+" expected "+std::to_string(expected[c]));}
}
}
int main(int argc,char** argv) {
    try {
        if(argc!=2)throw std::runtime_error("Supply authored rendering fixtures");const auto root=std::filesystem::path(argv[1]);VulkanContext context;context.create(false);
        for(const auto samples:{1u,4u})for(const auto name:{"handedness","orientation","lighting","repeat","props","props_cutout","props_blend","minification","antialiasing"}) {
            auto scene=std::make_shared<VulkanScene>(context);Mesh mesh;
            if(std::string(name)=="antialiasing"){mesh.vertices={{-.83f,-.73f,.5f,1,1,1},{.77f,-.61f,.5f,1,1,1},{-.67f,.81f,.5f,1,1,1}};mesh.indices={0,1,2};mesh.batches={{0,3,"",-1}};}
            else mesh=Terrain::load(root/name).mesh(4);
            scene->upload(mesh);
            // The same scene is used by two renderers, just like the stereo host.
            Target unorm{context},srgb{context};unorm.create(VK_FORMAT_R8G8B8A8_UNORM);srgb.create(VK_FORMAT_R8G8B8A8_SRGB);
            VulkanRenderer first(context),second(context);first.use_scene(scene);second.use_scene(scene);first.targets(std::span(&unorm.image,1),VK_FORMAT_R8G8B8A8_UNORM,128,128,samples);second.targets(std::span(&srgb.image,1),VK_FORMAT_R8G8B8A8_SRGB,128,128,samples);
            const auto camera=std::string(name)=="handedness"?projection(-1,1,-1,1)*view({0,0,0},{0,0,-1}):Matrix::identity();
            const auto a=capture(first,root/(std::string(name)+"-unorm.ppm"),camera),b=capture(second,root/(std::string(name)+"-srgb.ppm"),camera);
            if(std::string(name)=="antialiasing"){
                for(const auto* pixels:{&a,&b}){std::size_t partial=0;for(std::size_t p=0;p<pixels->size();p+=3)if((*pixels)[p]>90&&(*pixels)[p]<240)++partial;++checks;if((first.samples()>1)!=(partial>0))throw std::runtime_error("MSAA resolve did not produce expected geometric edge coverage");}
                first.targets(std::span(&unorm.image,1),VK_FORMAT_R8G8B8A8_UNORM,128,128,1);capture(first,root/"aa-recreated.ppm",camera);
                continue;
            }
            for(const auto* pixels:{&a,&b}) {
                if(std::string(name)=="minification") {
                    for(const auto u:{.15,.35,.5,.65,.85})for(const auto v:{.15,.35,.5,.65,.85})pixel(*pixels,u,v,{128,128,128});
                }else if(std::string(name)=="handedness") {
                    pixel(*pixels,.15,.15,{240,20,40});pixel(*pixels,.85,.15,{30,220,50});pixel(*pixels,.15,.85,{40,60,230});pixel(*pixels,.85,.85,{230,210,190});
                }else if(std::string(name)=="orientation") {
                    pixel(*pixels,.15,.15,{240,20,40});pixel(*pixels,.85,.15,{40,60,230});pixel(*pixels,.15,.85,{30,220,50});pixel(*pixels,.85,.85,{230,210,190});
                }else if(std::string(name)=="lighting") {
                    pixel(*pixels,.15,.15,{90,70,50});pixel(*pixels,.85,.15,{113,60,0});pixel(*pixels,.15,.85,{100,170,130});pixel(*pixels,.85,.85,{50,45,40});
                    pixel(*pixels,.01,.01,{90,70,50});pixel(*pixels,.99,.01,{113,60,0});pixel(*pixels,.01,.99,{100,170,130});pixel(*pixels,.99,.99,{50,45,40});
                }else if(std::string(name)=="repeat") {
                    pixel(*pixels,.1,.1,{240,20,40});pixel(*pixels,.35,.1,{40,60,230});pixel(*pixels,.1,.35,{30,220,50});pixel(*pixels,.35,.35,{230,210,190});pixel(*pixels,.6,.6,{240,20,40});
                }else if(std::string(name)=="props") {
                    pixel(*pixels,.25,.5,{150,80,30});pixel(*pixels,.75,.5,{255,160,60});pixel(*pixels,.5,.5,{40,80,120});
                    if(first.stats().visible_props!=2||first.stats().prop_draws!=1||second.stats().prop_draws!=1)throw std::runtime_error("Props are not culled/instanced as expected");
                }else if(std::string(name)=="props_cutout") {
                    pixel(*pixels,.40625,.5,{40,80,120});pixel(*pixels,.59375,.5,{240,100,40});
                }else {
                    pixel(*pixels,.5,.5,pixels==&a?std::array<int,3>{120,120,120}:std::array<int,3>{149,128,120});
                }
            }
        }
        std::cout<<"PASS: "<<checks<<" actual Vulkan texture/lightmap channel checks on UNORM and sRGB targets\n";return 0;
    }catch(const std::exception& e){std::cerr<<"FAIL: "<<e.what()<<'\n';return 1;}
}
