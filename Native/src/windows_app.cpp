#include "openxr_app.hpp"
#include "vulkan_renderer.hpp"
#include "openslope/replay.hpp"
#include "openslope/audio_scene.hpp"
#include "audio_device.hpp"
#include "openslope/avatar.hpp"
#include <windows.h>
#include <chrono>
#include <iostream>
#include <sstream>
#include <thread>

namespace {
using namespace openslope;
Vec3 camera_eye(const Player& player,bool first_person=false){const auto p=player.render_position();return first_person?avatar_pose(player).joint(AvatarJoint::Head)+avatar_pose(player).up*.105:player.camera_position(p-player.camera_forward()*7+Vec3{0,3.5,0});}
Matrix camera_for(const Player& player,double aspect,bool first_person=false,bool look_down=false) {
    const auto position=player.render_position(),forward=player.camera_forward();
    const auto eye=camera_eye(player,first_person);
    const auto direction=first_person?normalized(forward*(look_down?.22:1.)+Vec3{0,look_down?-1.:-.06,0}):position+forward*12-eye;
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
int capture(Player& player,const std::filesystem::path& output,double seconds,const std::filesystem::path& replay,const std::filesystem::path& audio_output,unsigned msaa,bool terrain_culling,bool first_person,bool look_down) {
    VulkanContext context;context.create(false);Image image(context);image.create(1280,720);
    VulkanRenderer renderer(context);renderer.cull_terrain(terrain_culling);renderer.upload(player.terrain().mesh());renderer.targets(std::span(&image.image,1),VK_FORMAT_R8G8B8A8_UNORM,1280,720,msaa);
    std::cout<<"MSAA samples: "<<renderer.samples()<<'\n';
    std::unique_ptr<AudioScene> audio;PcmClip recorded;recorded.channels=2;if(!audio_output.empty()){audio=std::make_unique<AudioScene>(player.terrain().map_root());player.observe_ticks([&](const Player& p,const Rider& before){audio->listener({camera_eye(p),p.camera_forward(),{0,1,0}});audio->tick(p,before);std::array<float,1600> block{};audio->mixer().render(block);if(recorded.samples.size()+block.size()>32*1024*1024)throw std::runtime_error("Audio capture exceeds its sample limit");recorded.samples.insert(recorded.samples.end(),block.begin(),block.end());});}
    Avatar avatar;unsigned frames=0,packed_frames=0;double wall=0,gpu=0,cull=0;std::uint64_t submitted=0;const auto draw=[&]{const auto started=std::chrono::steady_clock::now();renderer.render(0,camera_for(player,1280.0/720,first_person,look_down),board_transform(player.render_board_position(),player.render_forward(),player.render_up()),VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,{},{},camera_eye(player,first_person),player.effects().sprites(),player.effects().wake(),player.effects().sheet(),avatar.mesh(avatar_pose(player),first_person,false,camera_eye(player,first_person)));wall+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();gpu+=renderer.stats().gpu_ms;cull+=renderer.stats().cull_ms;submitted+=renderer.stats().terrain_indices;packed_frames+=renderer.stats().terrain_compacted;++frames;};
    if(replay.empty()){for(unsigned i=0;i<unsigned(seconds*60);++i)player.tick({});draw();}else{
        const auto started=std::chrono::steady_clock::now();Replay::load(replay).run(player,draw);const auto total=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
        const auto& r=player.rider();std::cout<<"Replay: "<<frames<<" rendered frames; launches "<<r.launches<<"; landings "<<r.landings<<"; grounded "<<r.grounded<<"; switch "<<(r.lead<0)<<"; spin "<<r.spin_degrees<<" deg; flip "<<r.flip_degrees<<" deg; surface "<<r.surface<<"; ground prop "<<(r.ground_instance?std::to_string(*r.ground_instance):"none")<<"; contacts "<<r.world_contacts<<"; bounces "<<r.bounces<<"; hard impacts "<<r.hard_impacts<<"; wipeout "<<(r.motion==Motion::Wipeout)<<"; position ["<<r.position.x<<','<<r.position.y<<','<<r.position.z<<"]; velocity ["<<r.velocity.x<<','<<r.velocity.y<<','<<r.velocity.z<<"]; average simulation "<<std::max(0.,total-wall)/frames<<" ms; render wall "<<wall/frames<<" ms; GPU "<<gpu/frames<<" ms\n";
    }
    const auto stats=renderer.stats();std::cout<<"Visible props: "<<stats.visible_props<<"; prop draws: "<<stats.prop_draws<<"; CPU frame: "<<stats.cpu_ms<<" ms; GPU frame: "<<stats.gpu_ms<<" ms\n";
    std::cout<<"Terrain: "<<stats.visible_terrain<<'/'<<stats.terrain_patches<<" patches; "<<stats.terrain_indices<<'/'<<stats.terrain_total_indices<<" indices; "<<stats.terrain_draws<<" draws; "<<stats.visibility_tests<<" bounds tests; average visibility "<<cull/frames<<" ms; average submitted "<<double(submitted)/frames<<" indices; packed frames "<<packed_frames<<'/'<<frames<<'\n';
    std::cout<<"Riding effects: "<<stats.sprites<<" drawn sprites; "<<player.effects().carve_emitted()<<" carve puffs; "<<player.effects().landing_emitted()<<" landing puffs; "<<player.effects().powder_count()<<" powder sprites\n";
    std::cout<<"Wake: "<<player.effects().wake_sections()<<" sections; "<<stats.wake_segments<<" segments; "<<stats.wake_draws<<" alpha passes\n";
    std::cout<<"Spray sheet: "<<player.effects().sheet_columns()<<" columns; "<<stats.sheet_segments<<" segments; "<<stats.sheet_draws<<" additive draws\n";
    const auto& recovered=player.rider();std::cout<<"Recovery: "<<recovered.crashes<<" crashes; "<<recovered.recoveries<<" get-ups; waiting "<<(recovered.control==Control::RecoverWait)<<"; standing "<<recovered.recovery_standing<<"; cause "<<int(recovered.crash_cause)<<'\n';
    const auto& grinding=player.rider();std::cout<<"Rails: "<<grinding.grinds<<" grinds; "<<grinding.rail_transfers<<" transfers; "<<grinding.rail_exits<<" exits; on rail "<<(grinding.motion==Motion::Rail)<<"; spin "<<grinding.rail_spin<<" deg; spline "<<(grinding.rail_spline?std::to_string(*grinding.rail_spline):"none")<<'\n';
    if(audio){write_wave(audio_output,recorded);const auto sound=audio->stats();std::cout<<"Audio capture: "<<recorded.frames()<<" stereo frames; contact sounds "<<sound.contacts<<"; transients "<<sound.transients<<"; ambient voices "<<sound.ambient<<"; music node "<<sound.music_node<<'\n';player.observe_ticks({});}
    std::cout<<"Boarding: on foot "<<player.on_foot()<<"; distance "<<player.board_distance()<<" m; coasting "<<player.board_coasting()<<"; board ["<<player.render_board_position().x<<','<<player.render_board_position().y<<','<<player.render_board_position().z<<"]\n";
    const auto& run=player.course_run().status();std::cout<<"Run: "<<run_name(run.mode)<<"; "<<run_name(run.phase)<<"; clock "<<run_clock(run.clock)<<"; elapsed "<<run.elapsed<<"; checkpoints "<<run.checkpoints<<"; lap "<<run.lap<<'/'<<run.passes<<"; remaining "<<run.remaining;if(run.progress)std::cout<<"; DTF "<<run.progress->distance_to_finish<<" m; progress "<<run.progress->fraction*100<<'%';std::cout<<'\n';
    renderer.capture(0,output);std::cout<<"Vulkan capture: "<<output.string()<<'\n';return 0;
}
struct Window {
    VulkanContext& context;VulkanRenderer renderer;HWND handle{};VkSurfaceKHR surface{};VkSwapchainKHR swapchain{};
    VkSemaphore available{},finished{};bool resized=true,quit=false;unsigned width{},height{},msaa=4;
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
        renderer.targets(images,format.format,width,height,msaa);resized=false;return true;
    }
    bool events() {
        MSG message;while(PeekMessageW(&message,nullptr,0,0,PM_REMOVE)){if(message.message==WM_QUIT)quit=true;TranslateMessage(&message);DispatchMessageW(&message);}return !quit;
    }
    Avatar avatar;
    void draw(const Player& player,bool first_person,bool look_down) {
        if(resized&&!resize())return;
        std::uint32_t image=0;const auto acquired=vkAcquireNextImageKHR(context.device,swapchain,UINT64_MAX,available,{},&image);
        if(acquired==VK_ERROR_OUT_OF_DATE_KHR){resized=true;return;}
        if(acquired!=VK_SUBOPTIMAL_KHR)vk_check(acquired,"Acquire preview image");
        renderer.render(image,camera_for(player,double(width)/height,first_person,look_down),board_transform(player.render_board_position(),player.render_forward(),player.render_up()),VK_IMAGE_LAYOUT_PRESENT_SRC_KHR,available,finished,camera_eye(player,first_person),player.effects().sprites(),player.effects().wake(),player.effects().sheet(),avatar.mesh(avatar_pose(player),first_person,false,camera_eye(player,first_person)));
        VkPresentInfoKHR present{VK_STRUCTURE_TYPE_PRESENT_INFO_KHR};present.waitSemaphoreCount=1;present.pWaitSemaphores=&finished;present.swapchainCount=1;present.pSwapchains=&swapchain;present.pImageIndices=&image;
        const auto result=vkQueuePresentKHR(context.queue,&present);
        if(result==VK_ERROR_OUT_OF_DATE_KHR||result==VK_SUBOPTIMAL_KHR)resized=true;else vk_check(result,"Present preview frame");
        vk_check(vkQueueWaitIdle(context.queue),"Finish preview presentation");
    }
};
}
int main(int argc,char** argv) {
    try {
        std::filesystem::path map,output,replay,audio_output;bool xr=false,smoke_window=false,no_audio=false,audio_smoke=false,msaa_set=false,terrain_culling=true,first_person_option=false,look_down_option=false,on_foot_option=false;double seconds=0;unsigned msaa=4;
        RunMode run_option=RunMode::Freeride;
        for(int i=1;i<argc;++i) {
            const std::string option=argv[i];
            if(option=="--xr")xr=true;
            else if(option=="--mode"&&i+1<argc)run_option=run_mode(argv[++i]);
            else if(option=="--on-foot")on_foot_option=true;
            else if(option=="--first-person")first_person_option=true;
            else if(option=="--look-down"){first_person_option=true;look_down_option=true;}
            else if(option=="--smoke-window")smoke_window=true;
            else if(option=="--msaa"&&i+1<argc){const std::string value=argv[++i];if(value!="1"&&value!="2"&&value!="4"&&value!="8")throw std::runtime_error("MSAA must be 1, 2, 4 or 8");msaa=unsigned(std::stoul(value));msaa_set=true;}
            else if(option=="--no-terrain-culling")terrain_culling=false;
            else if(option=="--no-audio")no_audio=true;
            else if(option=="--audio-smoke")audio_smoke=true;
            else if((option=="--map"||option=="--capture"||option=="--seconds"||option=="--replay"||option=="--audio-capture")&&i+1<argc) {
                const std::string argument=argv[++i];if(option=="--map")map=argument;else if(option=="--capture")output=argument;else if(option=="--replay")replay=argument;else if(option=="--audio-capture")audio_output=argument;else seconds=std::stod(argument);
            }else if(option=="--help") {std::cout<<"openslope_player [--map <map folder>] [--xr] [--mode freeride|race|showoff] [--first-person] [--look-down] [--on-foot] [--capture <output.ppm>] [--audio-capture <output.wav>] [--seconds <duration>] [--replay <sequence.json>] [--no-audio] [--audio-smoke] [--msaa 1|2|4|8] [--no-terrain-culling]\nDesktop: A/D steer/spin, W/S tuck/brake/flip, Space charged jump, Shift boost, R reset, F/V camera, C look down, P pause, M mute, E exit rail, G mount/dismount, T restart run, Escape quit.\n";return 0;}
            else throw std::runtime_error("Unknown or incomplete argument: "+option);
        }
        if(!std::isfinite(seconds)||seconds<0||seconds>3600)throw std::runtime_error("Duration must be between 0 and 3600 seconds");
        if(xr&&(msaa_set||!terrain_culling))throw std::runtime_error("MSAA/culling options currently apply to desktop window/capture mode");
        if(audio_smoke){AudioMixer mixer;auto clip=std::make_shared<PcmClip>();clip->samples.resize(48000);for(std::size_t i=0;i<clip->samples.size();++i)clip->samples[i]=float(.03*std::sin(2*pi*440*i/48000.));mixer.play(clip);AudioDevice device(mixer);if(!device.active())throw std::runtime_error("No audio output device accepted stereo float PCM");std::this_thread::sleep_for(std::chrono::milliseconds(1100));std::cout<<"Audio device: "<<device.frames()<<" frames queued\n";return device.frames()>=48000?0:1;}
        if(xr&&!output.empty())throw std::runtime_error("Choose either OpenXR or offline capture");
        if(!replay.empty()&&(output.empty()||seconds!=0))throw std::runtime_error("Replay requires --capture and cannot combine with --seconds");
        Player player(map.empty()?Terrain::demo():Terrain::load(map));
        if(run_option!=RunMode::Freeride)player.configure_run(run_option);
        if(xr)return run_openxr(player,{},seconds);
        if(!audio_output.empty()&&output.empty())throw std::runtime_error("Audio capture requires --capture");
        if(on_foot_option)player.start_on_foot();
        if(!output.empty())return capture(player,output,seconds,replay,audio_output,msaa,terrain_culling,first_person_option,look_down_option);
        if(smoke_window&&seconds==0)seconds=3;
        VulkanContext context;context.create(true);Window window(context);window.renderer.cull_terrain(terrain_culling);window.msaa=msaa;window.create(player.terrain().mesh(),!smoke_window);
        std::unique_ptr<AudioScene> audio;std::unique_ptr<AudioDevice> device;std::unique_ptr<AudioService> audio_service;if(!no_audio&&!smoke_window){audio=std::make_unique<AudioScene>(player.terrain().map_root());audio->mixer().paused(true);device=std::make_unique<AudioDevice>(audio->mixer());audio_service=std::make_unique<AudioService>(*audio);player.observe_ticks([&](const Player& p,const Rider& before){audio->tick(p,before);});if(!device->active())std::cerr<<"Audio output unavailable; use --no-audio for silent playback\n";}
        const auto started=std::chrono::steady_clock::now();auto previous=started;bool first_person=first_person_option,last_camera=false,paused=false,last_pause=false,last_focus=false,muted=false,last_mute=false;
        while(window.events()) {
            const auto now=std::chrono::steady_clock::now();const auto dt=std::chrono::duration<double>(now-previous).count();previous=now;
            if(seconds>0&&std::chrono::duration<double>(now-started).count()>=seconds)break;
            const bool focused=GetForegroundWindow()==window.handle;
            const auto key=[&](int value){return focused&&(GetAsyncKeyState(value)&0x8000)!=0;};
            if(key(VK_ESCAPE))break;
            const auto camera=key('F')||key('V');if(camera&&!last_camera)first_person=!first_person;last_camera=camera;
            const auto pause=key('P');if(pause&&!last_pause){paused=!paused;if(paused)player.release_inputs();}last_pause=pause;
            const auto mute=key('M');if(mute&&!last_mute)muted=!muted;last_mute=mute;
            if(audio){audio->listener({camera_eye(player,first_person),player.camera_forward(),{0,1,0}});audio->mixer().paused(paused||!focused);audio->mixer().volume(muted?0:1);}
            if(!focused&&last_focus)player.release_inputs();last_focus=focused;
            if(focused&&!paused)player.advance(dt,{double(key('A')||key(VK_LEFT))-double(key('D')||key(VK_RIGHT)),key(VK_SHIFT),key('R'),key(VK_SPACE),double(key('W')||key(VK_UP))-double(key('S')||key(VK_DOWN)),key('E'),key('G'),{},{},key('T')});
            const auto& stats=window.renderer.stats();
            const auto& rider=player.rider();std::wostringstream title;title<<L"OpenSlope Native | "<<int(length(rider.velocity)*3.6)<<L" km/h | ";
            const auto& run=player.course_run().status();if(run.mode!=RunMode::Freeride){const auto clock=run_clock(run.clock),phase=std::string(run_name(run.phase));title<<std::wstring(clock.begin(),clock.end())<<L" | "<<std::wstring(phase.begin(),phase.end())<<L" | CP "<<run.checkpoints<<L" | Lap "<<run.lap<<L"/"<<run.passes<<L" | T restart | ";if(run.phase==RunPhase::Countdown)title<<int(std::ceil(run.countdown))<<L" | ";}
            if(player.on_foot())title<<L"On foot | G mount ("<<int(player.board_distance()*100)<<L" cm) | ";
            if(paused)title<<L"PAUSED";else if(rider.control==Control::RecoverWait)title<<L"Getting up "<<int(rider.recovery_standing*100)<<L"%";else if(rider.motion==Motion::Wipeout)title<<L"Wipeout - recovering | R to reset";else if(rider.control==Control::Charge)title<<L"Charge "<<int(rider.charge*100)<<L"%";else if(rider.motion==Motion::Rail)title<<L"Grinding | Spin "<<int(rider.rail_spin)<<L" deg | E exit";else if(player.on_foot())title<<L"Walking";else title<<(rider.grounded?(rider.lead<0?L"Switch":L"Riding"):L"Air");
            title<<L" | "<<stats.visible_props<<L" props / "<<stats.prop_draws<<L" draws | A/D steer | W/S tuck/brake | Space jump | Shift boost | P pause | F/V camera | C look down | M "<<(muted?L"unmute":L"mute");SetWindowTextW(window.handle,title.str().c_str());
            window.draw(player,first_person,key('C')||look_down_option);
            if(IsIconic(window.handle))std::this_thread::sleep_for(std::chrono::milliseconds(30));
        }
        if(smoke_window)std::cout<<"Vulkan window/swapchain smoke: PASS\n";
        player.observe_ticks({});
        return 0;
    }catch(const std::exception& e){std::cerr<<"OpenSlope native: "<<e.what()<<'\n';return 1;}
}
