#include "openxr_app.hpp"
#include "vulkan_renderer.hpp"
#ifdef __ANDROID__
#include <jni.h>
#include <android/log.h>
#endif
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <thread>

namespace openslope {
namespace {
void xr_check(XrResult result,const char* operation) {
    if(result==XR_ERROR_FORM_FACTOR_UNAVAILABLE)throw std::runtime_error("No headset is available to the active OpenXR runtime. Connect your headset and try again.");
    if(result==XR_ERROR_RUNTIME_UNAVAILABLE)throw std::runtime_error("No OpenXR runtime is installed or active.");
    if(XR_FAILED(result)) throw std::runtime_error(std::string(operation)+": OpenXR result "+std::to_string(result));
}
template<class T> T function(XrInstance instance,const char* name) {
    PFN_xrVoidFunction result{};xr_check(xrGetInstanceProcAddr(instance,name,&result),name);
    return reinterpret_cast<T>(result);
}
Vec3 quaternion_rotate(XrQuaternionf q,Vec3 v) {
    const Vec3 axis{q.x,q.y,q.z};return v+cross(axis,v)*(2*q.w)+cross(axis,cross(axis,v))*2;
}
struct Eye {
    XrSwapchain swapchain{};
    std::unique_ptr<VulkanRenderer> renderer;
    std::uint32_t width{},height{};
};
struct State {
    XrInstance instance{};XrSystemId system{};XrSession session{};XrSpace space{};
    XrActionSet actions{};XrAction steer{},boost{},reset{},jump{};
    VulkanContext vulkan;
    std::vector<Eye> eyes;
    bool floor_space=false,running=false,focused=false,quit=false;
    ~State() {
        for(auto& eye:eyes){eye.renderer.reset();if(eye.swapchain)xrDestroySwapchain(eye.swapchain);}
        if(space)xrDestroySpace(space);if(session)xrDestroySession(session);
        if(actions)xrDestroyActionSet(actions);if(instance)xrDestroyInstance(instance);
    }
    XrPath path(const char* text) const { XrPath result{};xr_check(xrStringToPath(instance,text,&result),"Create input path");return result; }
    void create(const XrPlatform& platform,const Mesh& mesh) {
#ifdef __ANDROID__
        if(!platform.java_vm||!platform.activity)throw std::runtime_error("Android OpenXR requires an Activity and JavaVM");
        PFN_xrVoidFunction init_pointer{};
        xr_check(xrGetInstanceProcAddr(XR_NULL_HANDLE,"xrInitializeLoaderKHR",&init_pointer),"Find Android loader initialization");
        XrLoaderInitInfoAndroidKHR loader{XR_TYPE_LOADER_INIT_INFO_ANDROID_KHR};loader.applicationVM=platform.java_vm;loader.applicationContext=platform.activity;
        xr_check(reinterpret_cast<PFN_xrInitializeLoaderKHR>(init_pointer)(reinterpret_cast<const XrLoaderInitInfoBaseHeaderKHR*>(&loader)),"Initialize Android OpenXR loader");
#else
        static_cast<void>(platform);
#endif
        std::uint32_t count=0;xr_check(xrEnumerateInstanceExtensionProperties(nullptr,0,&count,nullptr),"Enumerate OpenXR extensions");
        std::vector<XrExtensionProperties> extensions(count,{XR_TYPE_EXTENSION_PROPERTIES});
        xr_check(xrEnumerateInstanceExtensionProperties(nullptr,count,&count,extensions.data()),"Read OpenXR extensions");
        std::vector<const char*> requested{XR_KHR_VULKAN_ENABLE2_EXTENSION_NAME};
#ifdef __ANDROID__
        requested.push_back(XR_KHR_ANDROID_CREATE_INSTANCE_EXTENSION_NAME);
#endif
        for(auto name:requested) if(std::none_of(extensions.begin(),extensions.end(),[&](const auto& e){return std::strcmp(e.extensionName,name)==0;}))
            throw std::runtime_error(std::string("Runtime lacks required OpenXR extension: ")+name);
        XrInstanceCreateInfo create{XR_TYPE_INSTANCE_CREATE_INFO};std::strcpy(create.applicationInfo.applicationName,"OpenSlope Native");create.applicationInfo.apiVersion=XR_MAKE_VERSION(1,0,0);
        create.enabledExtensionCount=std::uint32_t(requested.size());create.enabledExtensionNames=requested.data();
#ifdef __ANDROID__
        XrInstanceCreateInfoAndroidKHR android{XR_TYPE_INSTANCE_CREATE_INFO_ANDROID_KHR};android.applicationVM=platform.java_vm;android.applicationActivity=platform.activity;create.next=&android;
#endif
        xr_check(xrCreateInstance(&create,&instance),"Create OpenXR instance");
        XrSystemGetInfo system_info{XR_TYPE_SYSTEM_GET_INFO};system_info.formFactor=XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
        xr_check(xrGetSystem(instance,&system_info,&system),"Find connected headset");
        XrGraphicsRequirementsVulkan2KHR requirements{XR_TYPE_GRAPHICS_REQUIREMENTS_VULKAN2_KHR};
        xr_check(function<PFN_xrGetVulkanGraphicsRequirements2KHR>(instance,"xrGetVulkanGraphicsRequirements2KHR")(instance,system,&requirements),"Read Vulkan requirements");
        vk_check(volkInitialize(),"Load Vulkan driver");
        VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};app.pApplicationName="OpenSlope Native";
        app.apiVersion=std::max(VK_API_VERSION_1_1,VK_MAKE_API_VERSION(0,std::uint32_t(XR_VERSION_MAJOR(requirements.minApiVersionSupported)),std::uint32_t(XR_VERSION_MINOR(requirements.minApiVersionSupported)),0));
        VkInstanceCreateInfo vk_instance{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};vk_instance.pApplicationInfo=&app;
        XrVulkanInstanceCreateInfoKHR instance_info{XR_TYPE_VULKAN_INSTANCE_CREATE_INFO_KHR};instance_info.systemId=system;instance_info.pfnGetInstanceProcAddr=vkGetInstanceProcAddr;instance_info.vulkanCreateInfo=&vk_instance;
        VkResult result{};
        xr_check(function<PFN_xrCreateVulkanInstanceKHR>(instance,"xrCreateVulkanInstanceKHR")(instance,&instance_info,&vulkan.instance,&result),"Create XR Vulkan instance");vk_check(result,"Create XR Vulkan instance");volkLoadInstance(vulkan.instance);
        XrVulkanGraphicsDeviceGetInfoKHR physical_info{XR_TYPE_VULKAN_GRAPHICS_DEVICE_GET_INFO_KHR};physical_info.systemId=system;physical_info.vulkanInstance=vulkan.instance;
        xr_check(function<PFN_xrGetVulkanGraphicsDevice2KHR>(instance,"xrGetVulkanGraphicsDevice2KHR")(instance,&physical_info,&vulkan.physical),"Select XR GPU");
        std::uint32_t family_count=0;vkGetPhysicalDeviceQueueFamilyProperties(vulkan.physical,&family_count,nullptr);
        std::vector<VkQueueFamilyProperties> families(family_count);vkGetPhysicalDeviceQueueFamilyProperties(vulkan.physical,&family_count,families.data());
        const auto found=std::find_if(families.begin(),families.end(),[](const auto& f){return (f.queueFlags&VK_QUEUE_GRAPHICS_BIT)!=0;});
        if(found==families.end())throw std::runtime_error("XR GPU has no graphics queue");vulkan.family=std::uint32_t(found-families.begin());
        const float priority=1;VkDeviceQueueCreateInfo queue{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};queue.queueFamilyIndex=vulkan.family;queue.queueCount=1;queue.pQueuePriorities=&priority;
        VkDeviceCreateInfo device{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};device.queueCreateInfoCount=1;device.pQueueCreateInfos=&queue;
        XrVulkanDeviceCreateInfoKHR device_info{XR_TYPE_VULKAN_DEVICE_CREATE_INFO_KHR};device_info.systemId=system;device_info.pfnGetInstanceProcAddr=vkGetInstanceProcAddr;device_info.vulkanPhysicalDevice=vulkan.physical;device_info.vulkanCreateInfo=&device;
        xr_check(function<PFN_xrCreateVulkanDeviceKHR>(instance,"xrCreateVulkanDeviceKHR")(instance,&device_info,&vulkan.device,&result),"Create XR Vulkan device");vk_check(result,"Create XR Vulkan device");volkLoadDevice(vulkan.device);vkGetDeviceQueue(vulkan.device,vulkan.family,0,&vulkan.queue);
        XrGraphicsBindingVulkan2KHR graphics{XR_TYPE_GRAPHICS_BINDING_VULKAN2_KHR};graphics.instance=vulkan.instance;graphics.physicalDevice=vulkan.physical;graphics.device=vulkan.device;graphics.queueFamilyIndex=vulkan.family;
        XrSessionCreateInfo session_info{XR_TYPE_SESSION_CREATE_INFO};session_info.systemId=system;session_info.next=&graphics;
        xr_check(xrCreateSession(instance,&session_info,&session),"Create OpenXR session");
        std::uint32_t spaces_count=0;xr_check(xrEnumerateReferenceSpaces(session,0,&spaces_count,nullptr),"Enumerate reference spaces");
        std::vector<XrReferenceSpaceType> spaces(spaces_count);xr_check(xrEnumerateReferenceSpaces(session,spaces_count,&spaces_count,spaces.data()),"Read reference spaces");
        floor_space=std::find(spaces.begin(),spaces.end(),XR_REFERENCE_SPACE_TYPE_STAGE)!=spaces.end();
        XrReferenceSpaceCreateInfo reference{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};reference.referenceSpaceType=floor_space?XR_REFERENCE_SPACE_TYPE_STAGE:XR_REFERENCE_SPACE_TYPE_LOCAL;reference.poseInReferenceSpace.orientation.w=1;
        xr_check(xrCreateReferenceSpace(session,&reference,&space),"Create play space");
        create_input();
        std::uint32_t view_count=0;xr_check(xrEnumerateViewConfigurationViews(instance,system,XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO,0,&view_count,nullptr),"Enumerate stereo views");
        if(view_count!=2)throw std::runtime_error("Prototype requires a two-view stereo headset");
        std::vector<XrViewConfigurationView> views(view_count,{XR_TYPE_VIEW_CONFIGURATION_VIEW});
        xr_check(xrEnumerateViewConfigurationViews(instance,system,XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO,view_count,&view_count,views.data()),"Read stereo views");
        std::uint32_t format_count=0;xr_check(xrEnumerateSwapchainFormats(session,0,&format_count,nullptr),"Enumerate XR formats");
        std::vector<std::int64_t> formats(format_count);xr_check(xrEnumerateSwapchainFormats(session,format_count,&format_count,formats.data()),"Read XR formats");
        VkFormat format=VK_FORMAT_UNDEFINED;
        for(auto candidate:{VK_FORMAT_R8G8B8A8_SRGB,VK_FORMAT_B8G8R8A8_SRGB,VK_FORMAT_R8G8B8A8_UNORM,VK_FORMAT_B8G8R8A8_UNORM})if(std::find(formats.begin(),formats.end(),candidate)!=formats.end()){format=candidate;break;}
        if(format==VK_FORMAT_UNDEFINED)throw std::runtime_error("No supported XR colour format");
        auto scene=std::make_shared<VulkanScene>(vulkan);scene->upload(mesh);
        eyes.reserve(2);
        for(const auto& config:views) {
            eyes.emplace_back();auto& eye=eyes.back();eye.width=config.recommendedImageRectWidth;eye.height=config.recommendedImageRectHeight;
            XrSwapchainCreateInfo swapchain{XR_TYPE_SWAPCHAIN_CREATE_INFO};swapchain.usageFlags=XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;swapchain.format=format;swapchain.sampleCount=1;swapchain.width=eye.width;swapchain.height=eye.height;swapchain.faceCount=swapchain.arraySize=swapchain.mipCount=1;
            xr_check(xrCreateSwapchain(session,&swapchain,&eye.swapchain),"Create eye swapchain");
            std::uint32_t images_count=0;xr_check(xrEnumerateSwapchainImages(eye.swapchain,0,&images_count,nullptr),"Enumerate eye images");
            std::vector<XrSwapchainImageVulkan2KHR> xr_images(images_count,{XR_TYPE_SWAPCHAIN_IMAGE_VULKAN2_KHR});
            xr_check(xrEnumerateSwapchainImages(eye.swapchain,images_count,&images_count,reinterpret_cast<XrSwapchainImageBaseHeader*>(xr_images.data())),"Read eye images");
            std::vector<VkImage> images;for(const auto& image:xr_images)images.push_back(image.image);
            eye.renderer=std::make_unique<VulkanRenderer>(vulkan);eye.renderer->use_scene(scene);eye.renderer->targets(images,format,eye.width,eye.height);
        }
        std::cout<<"OpenXR stereo session prepared. Left stick: steer/posture; right trigger: boost; A: charged jump; X: reset.\n";
    }
    void create_input() {
        XrActionSetCreateInfo set{XR_TYPE_ACTION_SET_CREATE_INFO};std::strcpy(set.actionSetName,"ride");std::strcpy(set.localizedActionSetName,"Riding");
        xr_check(xrCreateActionSet(instance,&set,&actions),"Create riding action set");
        const auto action=[&](const char* name,XrActionType type,XrAction& result){
            XrActionCreateInfo info{XR_TYPE_ACTION_CREATE_INFO};info.actionType=type;std::strcpy(info.actionName,name);std::strcpy(info.localizedActionName,name);xr_check(xrCreateAction(actions,&info,&result),"Create riding action");};
        action("steer",XR_ACTION_TYPE_VECTOR2F_INPUT,steer);action("boost",XR_ACTION_TYPE_FLOAT_INPUT,boost);action("reset",XR_ACTION_TYPE_BOOLEAN_INPUT,reset);action("jump",XR_ACTION_TYPE_BOOLEAN_INPUT,jump);
        const std::array<XrActionSuggestedBinding,4> bindings{{{steer,path("/user/hand/left/input/thumbstick")},{boost,path("/user/hand/right/input/trigger/value")},{reset,path("/user/hand/left/input/x/click")},{jump,path("/user/hand/right/input/a/click")}}};
        XrInteractionProfileSuggestedBinding suggested{XR_TYPE_INTERACTION_PROFILE_SUGGESTED_BINDING};suggested.interactionProfile=path("/interaction_profiles/oculus/touch_controller");suggested.countSuggestedBindings=std::uint32_t(bindings.size());suggested.suggestedBindings=bindings.data();
        xr_check(xrSuggestInteractionProfileBindings(instance,&suggested),"Suggest Touch-compatible bindings");
        XrSessionActionSetsAttachInfo attach{XR_TYPE_SESSION_ACTION_SETS_ATTACH_INFO};attach.countActionSets=1;attach.actionSets=&actions;xr_check(xrAttachSessionActionSets(session,&attach),"Attach riding input");
    }
    RideInput input() const {
        if(!focused)return {};
        const XrActiveActionSet active{actions,XR_NULL_PATH};XrActionsSyncInfo sync{XR_TYPE_ACTIONS_SYNC_INFO};sync.countActiveActionSets=1;sync.activeActionSets=&active;xr_check(xrSyncActions(session,&sync),"Read controller actions");
        XrActionStateGetInfo info{XR_TYPE_ACTION_STATE_GET_INFO};info.action=steer;
        XrActionStateVector2f steering{XR_TYPE_ACTION_STATE_VECTOR2F};xr_check(xrGetActionStateVector2f(session,&info,&steering),"Read steering");
        info.action=boost;XrActionStateFloat boosting{XR_TYPE_ACTION_STATE_FLOAT};xr_check(xrGetActionStateFloat(session,&info,&boosting),"Read boost");
        info.action=reset;XrActionStateBoolean resetting{XR_TYPE_ACTION_STATE_BOOLEAN};xr_check(xrGetActionStateBoolean(session,&info,&resetting),"Read reset");
        info.action=jump;XrActionStateBoolean jumping{XR_TYPE_ACTION_STATE_BOOLEAN};xr_check(xrGetActionStateBoolean(session,&info,&jumping),"Read charged jump");
        const auto y=steering.isActive&&std::abs(steering.currentState.y)>.1f&&std::abs(steering.currentState.y)>=std::abs(steering.currentState.x)?steering.currentState.y:0;
        return {steering.isActive?-steering.currentState.x:0,boosting.isActive&&boosting.currentState>.5f,resetting.isActive&&resetting.changedSinceLastSync&&resetting.currentState,jumping.isActive&&jumping.currentState,y};
    }
    void events() {
        XrEventDataBuffer event{XR_TYPE_EVENT_DATA_BUFFER};XrResult result;
        while((result=xrPollEvent(instance,&event))==XR_SUCCESS) {
            if(event.type==XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING)quit=true;
            if(event.type==XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED) {
                const auto state=reinterpret_cast<XrEventDataSessionStateChanged*>(&event)->state;
                focused=state==XR_SESSION_STATE_FOCUSED;
                if(state==XR_SESSION_STATE_READY){XrSessionBeginInfo begin{XR_TYPE_SESSION_BEGIN_INFO};begin.primaryViewConfigurationType=XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;xr_check(xrBeginSession(session,&begin),"Begin VR session");running=true;}
                if(state==XR_SESSION_STATE_STOPPING){xr_check(xrEndSession(session),"End VR session");running=false;}
                if(state==XR_SESSION_STATE_EXITING||state==XR_SESSION_STATE_LOSS_PENDING)quit=true;
            }
            event={XR_TYPE_EVENT_DATA_BUFFER};
        }
        xr_check(result,"Poll OpenXR events");
    }
};
}
int run_openxr(Player& player,const XrPlatform& platform,double seconds) {
    State state;state.create(platform,player.terrain().mesh());
    const auto started=std::chrono::steady_clock::now();auto next_stats=started+std::chrono::seconds(5);XrTime previous_time=0;
    while(!state.quit) {
        if(platform.process_events&&!platform.process_events())break;
        if(seconds>0&&std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count()>=seconds)break;
        state.events();if(state.quit)break;
        if(!state.running){previous_time=0;std::this_thread::sleep_for(std::chrono::milliseconds(10));continue;}
        XrFrameWaitInfo wait{XR_TYPE_FRAME_WAIT_INFO};XrFrameState frame{XR_TYPE_FRAME_STATE};xr_check(xrWaitFrame(state.session,&wait,&frame),"Wait for VR frame");
        XrFrameBeginInfo begin{XR_TYPE_FRAME_BEGIN_INFO};xr_check(xrBeginFrame(state.session,&begin),"Begin VR frame");
        const auto dt=previous_time?double(frame.predictedDisplayTime-previous_time)*1e-9:0;previous_time=frame.predictedDisplayTime;
        if(state.focused)player.advance(std::max(0.0,dt),state.input());else player.release_inputs();
        std::array<XrCompositionLayerProjectionView,2> projections{{{XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW},{XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW}}};
        bool rendered=false;
        if(frame.shouldRender) {
            std::array<XrView,2> views{{{XR_TYPE_VIEW},{XR_TYPE_VIEW}}};XrViewState view_state{XR_TYPE_VIEW_STATE};std::uint32_t count=0;
            XrViewLocateInfo locate{XR_TYPE_VIEW_LOCATE_INFO};locate.viewConfigurationType=XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;locate.displayTime=frame.predictedDisplayTime;locate.space=state.space;
            xr_check(xrLocateViews(state.session,&locate,&view_state,2,&count,views.data()),"Locate stereo cameras");
            const auto valid=XR_VIEW_STATE_POSITION_VALID_BIT|XR_VIEW_STATE_ORIENTATION_VALID_BIT;
            if(count==2&&(view_state.viewStateFlags&valid)==valid) {
                const auto body=player.render_position();
                const auto facing=player.camera_forward();const auto yaw=std::atan2(-facing.x,-facing.z);const XrQuaternionf body_rotation{0,float(std::sin(yaw*.5)),0,float(std::cos(yaw*.5))};
                for(unsigned i=0;i<2;++i) {
                    auto& eye=state.eyes[i];std::uint32_t image=0;XrSwapchainImageAcquireInfo acquire{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};xr_check(xrAcquireSwapchainImage(eye.swapchain,&acquire,&image),"Acquire eye image");
                    XrSwapchainImageWaitInfo image_wait{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};image_wait.timeout=XR_INFINITE_DURATION;xr_check(xrWaitSwapchainImage(eye.swapchain,&image_wait),"Wait for eye image");
                    const auto& camera=views[i];
                    const auto eye_position=body+quaternion_rotate(body_rotation,{camera.pose.position.x,camera.pose.position.y,camera.pose.position.z})+Vec3{0,state.floor_space?0:1.65,0};
                    const auto forward=quaternion_rotate(body_rotation,quaternion_rotate(camera.pose.orientation,{0,0,-1}));
                    const auto up=quaternion_rotate(body_rotation,quaternion_rotate(camera.pose.orientation,{0,1,0}));
                    const auto matrix=projection(std::tan(camera.fov.angleLeft),std::tan(camera.fov.angleRight),std::tan(camera.fov.angleDown),std::tan(camera.fov.angleUp))*view(eye_position,forward,up);
                    eye.renderer->render(image,matrix,board_transform(body,player.render_forward(),player.render_up()),VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,{},{},eye_position);
                    XrSwapchainImageReleaseInfo release{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};xr_check(xrReleaseSwapchainImage(eye.swapchain,&release),"Release eye image");
                    projections[i].pose=camera.pose;projections[i].fov=camera.fov;projections[i].subImage.swapchain=eye.swapchain;projections[i].subImage.imageRect.extent={std::int32_t(eye.width),std::int32_t(eye.height)};
                }
                rendered=true;
            }
        }
        XrCompositionLayerProjection layer{XR_TYPE_COMPOSITION_LAYER_PROJECTION};layer.space=state.space;layer.viewCount=2;layer.views=projections.data();
        const XrCompositionLayerBaseHeader* layer_pointer=reinterpret_cast<const XrCompositionLayerBaseHeader*>(&layer);
        XrFrameEndInfo end{XR_TYPE_FRAME_END_INFO};end.displayTime=frame.predictedDisplayTime;end.environmentBlendMode=XR_ENVIRONMENT_BLEND_MODE_OPAQUE;end.layerCount=rendered?1:0;end.layers=rendered?&layer_pointer:nullptr;
        xr_check(xrEndFrame(state.session,&end),"Submit VR frame");
        const auto now=std::chrono::steady_clock::now();
        if(rendered&&now>=next_stats){
            double cpu=0,gpu=0;unsigned visible=0,draws=0;bool timed=true;
            for(const auto& eye:state.eyes){const auto& s=eye.renderer->stats();cpu+=s.cpu_ms;gpu+=s.gpu_ms;timed&=s.gpu_ms>=0;visible+=s.visible_props;draws+=s.prop_draws;}
            // Serialized per-eye render wall time includes the GPU fence wait.
#ifdef __ANDROID__
            __android_log_print(ANDROID_LOG_INFO,"OpenSlopeNative","Frame sample: %u visible prop submissions, %u prop draws, render wall %.2f ms, GPU %.2f ms (both eyes)",visible,draws,cpu,timed?gpu:-1);
#else
            std::cout<<"Frame sample: "<<visible<<" visible prop submissions, "<<draws<<" prop draws, render wall "<<cpu<<" ms, GPU "<<(timed?gpu:-1)<<" ms (both eyes)\n";
#endif
            next_stats=now+std::chrono::seconds(5);
        }
    }
    return 0;
}
}
