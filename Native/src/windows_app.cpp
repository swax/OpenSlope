#include "openxr_app.hpp"
#include "vulkan_renderer.hpp"
#include <windows.h>
#include <chrono>
#include <iostream>
#include <sstream>
#include <thread>

namespace {
using namespace openslope;
Vec3 camera_eye(const Player& player,bool first_person=false){const auto p=player.render_position();return first_person?p+Vec3{0,1.65,0}:p-player.rider().forward*7+Vec3{0,3.5,0};}
Matrix camera_for(const Player& player,double aspect,bool first_person=false) {
    const auto position=player.render_position(),forward=player.rider().forward;
    const auto eye=camera_eye(player,first_person);
    const auto direction=first_person?forward:position+forward*12-eye;
    const auto tangent=std::tan(70*pi/360);
    return projection(-tangent*aspect,tangent*aspect,-tangent,tangent)*view(eye,direction);
}
std::uint32_t image_memory_type(VulkanContext& context,std::uint32_t bits) {
    VkPhysicalDeviceMemoryProperties properties;vkGetPhysicalDeviceMemoryProperties(context.physical,&properties);
    for(std::uint32_t i=0;i<properties.memoryTypeCount;++i)if((bits&(1u<<i))&&(properties.memoryTypes[i].propertyFlags&VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT))return i;
    throw std::runtime_error("No device-local image memory");
}
struct Image {
    VulkanContext& context;VkImage image{};VkDeviceMemory memory{};
    explicit Image(VulkanContext& ctx):context(ctx){}
    ~Image(){if(image)vkDestroyImage(context.device,image,nullptr);if(memory)vkFreeMemory(context.device,memory,nullptr);}
    void create(unsigned width,unsigned height) {
        VkImageCreateInfo info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};info.imageType=VK_IMAGE_TYPE_2D;info.format=VK_FORMAT_R8G8B8A8_UNORM;info.extent={width,height,1};info.mipLevels=info.arrayLayers=1;info.samples=VK_SAMPLE_COUNT_1_BIT;info.tiling=VK_IMAGE_TILING_OPTIMAL;info.usage=VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT|VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
        vk_check(vkCreateImage(context.device,&info,nullptr,&image),"Create capture image");
        VkMemoryRequirements requirements;vkGetImageMemoryRequirements(context.device,image,&requirements);
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};allocation.allocationSize=requirements.size;allocation.memoryTypeIndex=image_memory_type(context,requirements.memoryTypeBits);
        vk_check(vkAllocateMemory(context.device,&allocation,nullptr,&memory),"Allocate capture image");vk_check(vkBindImageMemory(context.device,image,memory,0),"Bind capture image");
    }
};
int capture(Player& player,const std::filesystem::path& output,double seconds) {
    for(unsigned i=0;i<unsigned(seconds*60);++i)player.tick({});
    VulkanContext context;context.create(false);Image image(context);image.create(1280,720);
    VulkanRenderer renderer(context);renderer.upload(player.terrain().mesh());renderer.targets(std::span(&image.image,1),VK_FORMAT_R8G8B8A8_UNORM,1280,720);
    renderer.render(0,camera_for(player,1280.0/720),board_transform(player.render_position(),player.rider().forward,player.rider().normal),VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,{},{},camera_eye(player));
    const auto stats=renderer.stats();std::cout<<"Visible props: "<<stats.visible_props<<"; prop draws: "<<stats.prop_draws<<"; CPU frame: "<<stats.cpu_ms<<" ms; GPU frame: "<<stats.gpu_ms<<" ms\n";
    renderer.capture(0,output);std::cout<<"Vulkan capture: "<<output.string()<<'\n';return 0;
}
struct Window {
    VulkanContext& context;VulkanRenderer renderer;HWND handle{};VkSurfaceKHR surface{};VkSwapchainKHR swapchain{};
    VkSemaphore available{},finished{};bool resized=true,quit=false;unsigned width{},height{};
    explicit Window(VulkanContext& ctx):context(ctx),renderer(ctx){}
    ~Window() {
        vkDeviceWaitIdle(context.device);renderer.clear_targets();
        if(available)vkDestroySemaphore(context.device,available,nullptr);if(finished)vkDestroySemaphore(context.device,finished,nullptr);
        if(swapchain)vkDestroySwapchainKHR(context.device,swapchain,nullptr);if(surface)vkDestroySurfaceKHR(context.instance,surface,nullptr);
        if(handle&&IsWindow(handle))DestroyWindow(handle);
    }
    static LRESULT CALLBACK procedure(HWND handle,UINT message,WPARAM wparam,LPARAM lparam) {
        auto* window=reinterpret_cast<Window*>(GetWindowLongPtrW(handle,GWLP_USERDATA));
        if(message==WM_NCCREATE){window=static_cast<Window*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);SetWindowLongPtrW(handle,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(window));}
        if(window){if(message==WM_SIZE)window->resized=true;if(message==WM_CLOSE){window->quit=true;DestroyWindow(handle);return 0;}}
        return DefWindowProcW(handle,message,wparam,lparam);
    }
    void create(const Mesh& mesh,bool visible=true) {
        WNDCLASSW cls{};cls.lpfnWndProc=procedure;cls.hInstance=GetModuleHandleW(nullptr);cls.lpszClassName=L"OpenSlopeNativePreview";cls.hCursor=LoadCursor(nullptr,IDC_ARROW);
        if(!RegisterClassW(&cls)&&GetLastError()!=ERROR_CLASS_ALREADY_EXISTS)throw std::runtime_error("Cannot register preview window");
        handle=CreateWindowExW(0,cls.lpszClassName,L"OpenSlope Native",WS_OVERLAPPEDWINDOW,CW_USEDEFAULT,CW_USEDEFAULT,1280,720,nullptr,nullptr,cls.hInstance,this);
        if(!handle)throw std::runtime_error("Cannot create preview window");
        VkWin32SurfaceCreateInfoKHR info{VK_STRUCTURE_TYPE_WIN32_SURFACE_CREATE_INFO_KHR};info.hinstance=cls.hInstance;info.hwnd=handle;
        vk_check(vkCreateWin32SurfaceKHR(context.instance,&info,nullptr,&surface),"Create preview surface");
        VkBool32 supported=VK_FALSE;vk_check(vkGetPhysicalDeviceSurfaceSupportKHR(context.physical,context.family,surface,&supported),"Check presentation support");
        if(!supported)throw std::runtime_error("Selected Vulkan queue cannot present to this window");
        VkSemaphoreCreateInfo semaphore{VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};vk_check(vkCreateSemaphore(context.device,&semaphore,nullptr,&available),"Create acquire semaphore");vk_check(vkCreateSemaphore(context.device,&semaphore,nullptr,&finished),"Create present semaphore");
        renderer.upload(mesh);if(visible)ShowWindow(handle,SW_SHOW);
    }
    bool resize() {
        RECT rect{};GetClientRect(handle,&rect);if(rect.right<=0||rect.bottom<=0)return false;
        vk_check(vkDeviceWaitIdle(context.device),"Wait for resize");renderer.clear_targets();
        VkSurfaceCapabilitiesKHR capabilities{};vk_check(vkGetPhysicalDeviceSurfaceCapabilitiesKHR(context.physical,surface,&capabilities),"Read window capabilities");
        std::uint32_t count=0;vk_check(vkGetPhysicalDeviceSurfaceFormatsKHR(context.physical,surface,&count,nullptr),"Enumerate window formats");
        std::vector<VkSurfaceFormatKHR> formats(count);vk_check(vkGetPhysicalDeviceSurfaceFormatsKHR(context.physical,surface,&count,formats.data()),"Read window formats");
        if(formats.empty())throw std::runtime_error("No preview surface format");auto format=formats[0];
        for(const auto candidate:formats)if(candidate.format==VK_FORMAT_B8G8R8A8_UNORM){format=candidate;break;}
        const auto extent=capabilities.currentExtent.width!=UINT32_MAX?capabilities.currentExtent:VkExtent2D{std::clamp(unsigned(rect.right),capabilities.minImageExtent.width,capabilities.maxImageExtent.width),std::clamp(unsigned(rect.bottom),capabilities.minImageExtent.height,capabilities.maxImageExtent.height)};
        width=extent.width;height=extent.height;
        VkSwapchainCreateInfoKHR info{VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR};info.surface=surface;info.minImageCount=capabilities.minImageCount+1;
        if(capabilities.maxImageCount)info.minImageCount=std::min(info.minImageCount,capabilities.maxImageCount);
        info.imageFormat=format.format;info.imageColorSpace=format.colorSpace;info.imageExtent=extent;info.imageArrayLayers=1;info.imageUsage=VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
        info.preTransform=capabilities.currentTransform;info.compositeAlpha=VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;info.presentMode=VK_PRESENT_MODE_FIFO_KHR;info.clipped=VK_TRUE;info.oldSwapchain=swapchain;
        VkSwapchainKHR replacement{};vk_check(vkCreateSwapchainKHR(context.device,&info,nullptr,&replacement),"Create preview swapchain");
        if(swapchain)vkDestroySwapchainKHR(context.device,swapchain,nullptr);swapchain=replacement;
        vk_check(vkGetSwapchainImagesKHR(context.device,swapchain,&count,nullptr),"Enumerate preview images");std::vector<VkImage> images(count);vk_check(vkGetSwapchainImagesKHR(context.device,swapchain,&count,images.data()),"Read preview images");
        renderer.targets(images,format.format,width,height);resized=false;return true;
    }
    bool events() {
        MSG message;while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)){if(message.message==WM_QUIT)quit=true;TranslateMessage(&message);DispatchMessageW(&message);}return !quit;
    }
    void draw(const Player& player,bool first_person) {
        if(resized&&!resize())return;
        std::uint32_t image=0;const auto acquired=vkAcquireNextImageKHR(context.device,swapchain,UINT64_MAX,available,{},&image);
        if(acquired==VK_ERROR_OUT_OF_DATE_KHR){resized=true;return;}
        if(acquired!=VK_SUBOPTIMAL_KHR)vk_check(acquired,"Acquire preview image");
        renderer.render(image,camera_for(player,double(width)/height,first_person),board_transform(player.render_position(),player.rider().forward,player.rider().normal),VK_IMAGE_LAYOUT_PRESENT_SRC_KHR,available,finished,camera_eye(player,first_person));
        VkPresentInfoKHR present{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};present.waitSemaphoreCount=1;present.pWaitSemaphores=&finished;present.swapchainCount=1;present.pSwapchains=&swapchain;present.pImageIndices=&image;
        const auto result=vkQueuePresentKHR(context.queue,&present);
        if(result==VK_ERROR_OUT_OF_DATE_KHR||result==VK_SUBOPTIMAL_KHR)resized=true;else vk_check(result,"Present preview frame");
        vk_check(vkQueueWaitIdle(context.queue),"Finish preview presentation");
    }
};
}
int main(int argc,char** argv) {
    try {
        std::filesystem::path map,output;bool xr=false,smoke_window=false;double seconds=0;
        for(int i=1;i<argc;++i) {
            const std::string option=argv[i];
            if(option=="--xr")xr=true;
            else if(option=="--smoke-window")smoke_window=true;
            else if((option=="--map"||option=="--capture"||option=="--seconds")&&i+1<argc) {
                const std::string argument=argv[++i];if(option=="--map")map=argument;else if(option=="--capture")output=argument;else seconds=std::stod(argument);
            }else if(option=="--help") {std::cout<<"openslope_player [--map <map folder>] [--xr] [--capture <output.ppm>] [--seconds <duration>]\nDesktop: A/D steer, Space boost, R reset, F camera, Escape quit.\n";return 0;}
            else throw std::runtime_error("Unknown or incomplete argument: "+option);
        }
        if(!std::isfinite(seconds)||seconds<0||seconds>3600)throw std::runtime_error("Duration must be between 0 and 3600 seconds");
        if(xr&&!output.empty())throw std::runtime_error("Choose either OpenXR or offline capture");
        Player player(map.empty()?Terrain::demo():Terrain::load(map));
        if(xr)return run_openxr(player,{},seconds);
        if(!output.empty())return capture(player,output,seconds);
        if(smoke_window&&seconds==0)seconds=3;
        VulkanContext context;context.create(true);Window window(context);window.create(player.terrain().mesh(),!smoke_window);
        const auto started=std::chrono::steady_clock::now();auto previous=started;bool first_person=false,last_camera=false;
        while(window.events()) {
            const auto now=std::chrono::steady_clock::now();const auto dt=std::chrono::duration<double>(now-previous).count();previous=now;
            if(seconds>0&&std::chrono::duration<double>(now-started).count()>=seconds)break;
            const bool focused=GetForegroundWindow()==window.handle;
            const auto key=[&](int value){return focused&&(GetAsyncKeyState(value)&0x8000)!=0;};
            if(key(VK_ESCAPE))break;
            const auto camera=key('F');if(camera&&!last_camera)first_person=!first_person;last_camera=camera;
            if(focused)player.advance(dt,{double(key('A'))-double(key('D')),key(VK_SPACE),key('R')});
            const auto& stats=window.renderer.stats();
            std::wostringstream title;title<<L"OpenSlope Native | "<<int(length(player.rider().velocity)*3.6)<<L" km/h | "<<stats.visible_props<<L" props / "<<stats.prop_draws<<L" draws | GPU "<<stats.gpu_ms<<L" ms | A/D steer | Space boost | R reset | F camera";SetWindowTextW(window.handle,title.str().c_str());
            window.draw(player,first_person);
            if(IsIconic(window.handle))std::this_thread::sleep_for(std::chrono::milliseconds(30));
        }
        if(smoke_window)std::cout<<"Vulkan window/swapchain smoke: PASS\n";
        return 0;
    }catch(const std::exception& e){std::cerr<<"OpenSlope native: "<<e.what()<<'\n';return 1;}
}
