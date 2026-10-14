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
std::vector<unsigned char> capture(VulkanRenderer& renderer,const std::filesystem::path& output,const Matrix& camera,std::span<const Sprite> sprites={},std::span<const WakeVertex> wake={}) {
    auto board=Matrix::identity();board.values[12]=10;
    renderer.render(0,camera,board,VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,{},{},{},sprites,wake);renderer.capture(0,output);
    std::ifstream file(output,std::ios::binary);std::string magic;unsigned width,height,maximum;file>>magic>>width>>height>>maximum;file.get();
    if(magic!="P6"||width!=128||height!=128||maximum!=255)throw std::runtime_error("Invalid GPU capture");
    std::vector<unsigned char> pixels(128*128*3);file.read(reinterpret_cast<char*>(pixels.data()),pixels.size());if(!file)throw std::runtime_error("Truncated GPU capture");return pixels;
}
void pixel(const std::vector<unsigned char>& pixels,double u,double v,std::array<int,3> expected) {
    const auto x=unsigned((.1+.8*u)*128),y=unsigned((.1+.8*v)*128);
    for(unsigned c=0;c<3;++c){++checks;const auto actual=int(pixels[(y*128+x)*3+c]);if(std::abs(actual-expected[c])>1)throw std::runtime_error("GPU pixel differs at ("+std::to_string(u)+","+std::to_string(v)+"), channel "+std::to_string(c)+": "+std::to_string(actual)+" expected "+std::to_string(expected[c]));}
}
std::array<WakeVertex,6> ribbon(double z,float alpha=.5f){
    const WakeVertex a{{-.8,-.8,z},{0,0,-1},0,0,alpha},b{{.8,-.8,z},{0,0,-1},1,0,alpha},c{{.8,.8,z},{0,0,-1},1,2,alpha},d{{-.8,.8,z},{0,0,-1},0,2,alpha};return {a,b,c,a,c,d};
}
}
int main(int argc,char** argv) {
    try {
        if(argc!=2)throw std::runtime_error("Supply authored rendering fixtures");const auto root=std::filesystem::path(argv[1]);VulkanContext context;context.create(false);
        for(const auto samples:{1u,4u})for(const auto name:{"handedness","orientation","lighting","repeat","props","props_cutout","props_blend","minification","antialiasing","visibility","sprites","wake","wake_repeat"}) {
            auto scene=std::make_shared<VulkanScene>(context);Mesh mesh;
            if(std::string(name)=="antialiasing"){mesh.vertices={{-.83f,-.73f,.5f,1,1,1},{.77f,-.61f,.5f,1,1,1},{-.67f,.81f,.5f,1,1,1}};mesh.indices={0,1,2};mesh.batches={{0,3,"",-1}};}
            else if(std::string(name)=="visibility"){
                std::vector<Patch> patches;for(const auto center:std::array<Vec3,8>{{{-.6,0,.5},{.6,0,.5},{-3,0,.5},{3,0,.5},{0,0,-2},{0,4,.5},{0,-4,.5},{0,0,2}}}){Patch p;p.texture=patches.size()%2?"missing-b":"missing-a";for(unsigned u=0;u<4;++u)for(unsigned v=0;v<4;++v)p.points[u*4+v]=center+Vec3{u*.8/3-.4,v*.8/3-.4,0};patches.push_back(p);}mesh=Terrain(std::move(patches)).mesh(4);
            }
            else mesh=Terrain::load(root/name).mesh(4);
            scene->upload(mesh);
            // The same scene is used by two renderers, just like the stereo host.
            Target unorm{context},srgb{context};unorm.create(VK_FORMAT_R8G8B8A8_UNORM);srgb.create(VK_FORMAT_R8G8B8A8_SRGB);
            VulkanRenderer first(context),second(context);first.use_scene(scene);second.use_scene(scene);first.targets(std::span(&unorm.image,1),VK_FORMAT_R8G8B8A8_UNORM,128,128,samples);second.targets(std::span(&srgb.image,1),VK_FORMAT_R8G8B8A8_SRGB,128,128,samples);
            const auto camera=std::string(name)=="handedness"?projection(-1,1,-1,1)*view({0,0,0},{0,0,-1}):Matrix::identity();
            if(std::string(name)=="wake"||std::string(name)=="wake_repeat"){
                const auto plain=capture(first,root/"wake-plain.ppm",camera);const auto front=ribbon(.25),behind=ribbon(.75);
                const auto hidden=capture(first,root/"wake-hidden.ppm",camera,{},behind);++checks;if(plain!=hidden)throw std::runtime_error("Wake ignores scene depth");
                const auto drawn=capture(first,root/"wake-drawn.ppm",camera,{},front);++checks;if(first.stats().wake_segments!=1||first.stats().wake_draws!=2)throw std::runtime_error("Wake did not submit both alpha passes");
                if(std::string(name)=="wake"){
                    pixel(drawn,.5,.5,{110,89,89});
                    const auto further=ribbon(.35);std::vector<WakeVertex> stacked(front.begin(),front.end());stacked.insert(stacked.end(),further.begin(),further.end());pixel(capture(first,root/"wake-stacked.ppm",camera,{},stacked),.5,.5,{150,94,72});
                    const auto transparent=ribbon(.25,0);++checks;if(capture(first,root/"wake-zero.ppm",camera,{},transparent)!=plain)throw std::runtime_error("Zero-alpha wake changed scene pixels");
                    const auto fade=capture(first,root/"wake-fade.ppm",camera,{},ribbon(.25,.25f));pixel(fade,.5,.5,{78,85,104});
                    auto gradient=ribbon(.25);for(auto& v:gradient)v.alpha=v.along*.5f;const auto tapered=capture(first,root/"wake-taper.ppm",camera,{},gradient);pixel(tapered,.5,.125,{59,82,112});pixel(tapered,.5,.875,{149,94,72});
                    const auto encoded=capture(second,root/"wake-srgb.ppm",camera,{},front);pixel(encoded,.5,.5,{141,89,97});
                    first.targets(std::span(&unorm.image,1),VK_FORMAT_R8G8B8A8_UNORM,128,128,samples);pixel(capture(first,root/"wake-recreated.ppm",camera,{},front),.5,.5,{110,89,89});
                }else{
                    for(const auto u:{.125,.875})for(const auto v:{.125,.625})pixel(drawn,u,v,{120,140,160});
                    for(const auto v:{.125,.375,.625,.875})pixel(drawn,.5,v,{40,80,120});
                    for(const auto u:{.125,.875})for(const auto v:{.375,.875})pixel(drawn,u,v,{40,80,120});
                }
                ++checks;if(capture(first,root/"wake-cleared.ppm",camera)!=plain)throw std::runtime_error("Wake pass retained stale geometry");continue;
            }
            if(std::string(name)=="sprites"){
                const std::array<Sprite,1> front{{{{0,0,.25},.2f,.25f,0}}},behind{{{{0,0,.75},.2f,.25f,0}}};
                const auto plain=capture(first,root/"sprite-plain.ppm",camera),hidden=capture(first,root/"sprite-hidden.ppm",camera,behind);++checks;if(plain!=hidden)throw std::runtime_error("Sprite depth test failed");
                const auto additive=capture(first,root/"sprite-add.ppm",camera,front);pixel(additive,.5,.5,{104,144,184});++checks;if(first.stats().sprites!=1)throw std::runtime_error("Sprite draw was not submitted");
                const std::array<Sprite,2> stacked{{front[0],{{0,0,.35},.2f,.25f,0}}};pixel(capture(first,root/"sprite-stack.ppm",camera,stacked),.5,.5,{168,208,248});
                const auto cleared=capture(first,root/"sprite-cleared.ppm",camera);++checks;if(cleared!=plain)throw std::runtime_error("Sprite pass left stale geometry");
                const auto encoded=capture(second,root/"sprite-srgb.ppm",camera,front);pixel(encoded,.5,.5,{142,156,177});continue;
            }
            const auto a=capture(first,root/(std::string(name)+"-unorm.ppm"),camera),b=capture(second,root/(std::string(name)+"-srgb.ppm"),camera);
            const auto visibility=first.stats();first.cull_terrain(false);second.cull_terrain(false);
            const auto baseline_a=capture(first,root/"baseline-unorm.ppm",camera),baseline_b=capture(second,root/"baseline-srgb.ppm",camera);checks+=2;if(a!=baseline_a||b!=baseline_b)throw std::runtime_error("Culled pixels differ from complete terrain submission");first.cull_terrain(true);second.cull_terrain(true);
            if(std::string(name)=="visibility"){
                ++checks;if(visibility.visible_terrain!=2||visibility.terrain_patches!=8||visibility.terrain_indices*4!=visibility.terrain_total_indices||visibility.terrain_draws!=2)throw std::runtime_error("Terrain compaction did not retain two visible material groups");
                auto empty=camera;empty.values[12]=100;const auto culled=capture(first,root/"empty-cull.ppm",empty);++checks;if(first.stats().terrain_indices||first.stats().terrain_draws)throw std::runtime_error("Empty view still submitted terrain");first.cull_terrain(false);const auto complete=capture(first,root/"empty-full.ppm",empty);++checks;if(culled!=complete)throw std::runtime_error("Empty view lost visible pixels");continue;
            }
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
