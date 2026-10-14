#include "openxr_app.hpp"
#include "audio_device.hpp"
#include "openslope/avatar.hpp"
#include "body_tracking_compat.hpp"
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
#include <cstdio>
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
void tracking_log(const std::string& message){
#ifdef __ANDROID__
    __android_log_print(ANDROID_LOG_INFO,"OpenSlopeNative","%s",message.c_str());
#else
    std::cout<<message<<'\n';
#endif
}
struct Eye {
    XrSwapchain swapchain{};
    std::unique_ptr<VulkanRenderer> renderer;
    std::uint32_t width{},height{};
};
struct State {
    XrInstance instance{};XrSystemId system{};XrSession session{};XrSpace space{};
    XrActionSet actions{};XrAction steer{},boost{},reset{},jump{},rail_exit{},mount{},restart{},grip{};
    std::array<XrPath,2> hands{};std::array<XrSpace,2> grips{};
    Vec3 walk_forward{},room_offset{};bool walking=true;
    XrPath touch_profile{};
    XrBodyTrackerFB body_tracker{};PFN_xrDestroyBodyTrackerFB destroy_body{};PFN_xrLocateBodyJointsFB locate_body{};
    bool body_extension=false,full_extension=false,fidelity_extension=false,full_body=false,fidelity_supported=false;
    bool anchored=false;Vec3 origin{};double reference_yaw=0;std::uint64_t anchor_serial=0;XrTime reference_change=0;
    int tracking_mode=-1,actual_fidelity=-1,boarding_mode=-1,pose_mode=-1,run_phase=-1;unsigned run_checkpoints=0;
    Avatar avatar;
    VulkanContext vulkan;
    std::vector<Eye> eyes;
    bool floor_space=false,running=false,focused=false,quit=false;
    ~State() {
        for(auto& eye:eyes){eye.renderer.reset();if(eye.swapchain)xrDestroySwapchain(eye.swapchain);}
        if(body_tracker&&destroy_body)destroy_body(body_tracker);
        for(auto grip_space:grips)if(grip_space)xrDestroySpace(grip_space);
        if(space)xrDestroySpace(space);if(session)xrDestroySession(session);
        if(actions)xrDestroyActionSet(actions);if(instance)xrDestroyInstance(instance);
    }
    XrPath path(const char* text) const { XrPath result{};xr_check(xrStringToPath(instance,text,&result),"Create input path");return result; }
    void create(const XrPlatform& platform,const Mesh& mesh) {
        if(!std::isfinite(platform.render_scale)||platform.render_scale<1||platform.render_scale>1.5||(platform.msaa!=1&&platform.msaa!=2&&platform.msaa!=4))throw std::runtime_error("Invalid VR image quality");
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
        const auto available=[&](const char* name){return std::any_of(extensions.begin(),extensions.end(),[&](const auto& e){return std::strcmp(e.extensionName,name)==0;});};
        body_extension=available(XR_FB_BODY_TRACKING_EXTENSION_NAME);
        full_extension=body_extension&&available(XR_META_BODY_TRACKING_FULL_BODY_EXTENSION_NAME);
        fidelity_extension=body_extension&&available(XR_META_BODY_TRACKING_FIDELITY_EXTENSION_NAME);
        if(body_extension)requested.push_back(XR_FB_BODY_TRACKING_EXTENSION_NAME);
        if(full_extension)requested.push_back(XR_META_BODY_TRACKING_FULL_BODY_EXTENSION_NAME);
        if(fidelity_extension)requested.push_back(XR_META_BODY_TRACKING_FIDELITY_EXTENSION_NAME);
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
        create_body();
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
            eyes.emplace_back();auto& eye=eyes.back();eye.width=std::min(config.maxImageRectWidth,std::uint32_t(std::lround(config.recommendedImageRectWidth*platform.render_scale)));eye.height=std::min(config.maxImageRectHeight,std::uint32_t(std::lround(config.recommendedImageRectHeight*platform.render_scale)));
            XrSwapchainCreateInfo swapchain{XR_TYPE_SWAPCHAIN_CREATE_INFO};swapchain.usageFlags=XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;swapchain.format=format;swapchain.sampleCount=1;swapchain.width=eye.width;swapchain.height=eye.height;swapchain.faceCount=swapchain.arraySize=swapchain.mipCount=1;
            xr_check(xrCreateSwapchain(session,&swapchain,&eye.swapchain),"Create eye swapchain");
            std::uint32_t images_count=0;xr_check(xrEnumerateSwapchainImages(eye.swapchain,0,&images_count,nullptr),"Enumerate eye images");
            std::vector<XrSwapchainImageVulkan2KHR> xr_images(images_count,{XR_TYPE_SWAPCHAIN_IMAGE_VULKAN2_KHR});
            xr_check(xrEnumerateSwapchainImages(eye.swapchain,images_count,&images_count,reinterpret_cast<XrSwapchainImageBaseHeader*>(xr_images.data())),"Read eye images");
            std::vector<VkImage> images;for(const auto& image:xr_images)images.push_back(image.image);
            eye.renderer=std::make_unique<VulkanRenderer>(vulkan);eye.renderer->use_scene(scene);eye.renderer->deferred(true);eye.renderer->targets(images,format,eye.width,eye.height,platform.msaa);
            tracking_log("XR eye "+std::to_string(eyes.size()-1)+": recommended "+std::to_string(config.recommendedImageRectWidth)+"x"+std::to_string(config.recommendedImageRectHeight)+"; actual "+std::to_string(eye.width)+"x"+std::to_string(eye.height)+"; MSAA "+std::to_string(eye.renderer->samples())+"; queued GPU submission");
        }
        std::cout<<"OpenXR stereo session prepared. Left stick: steer/posture; right trigger: boost; A: charged jump; X: reset; left stick click: exit rail; B: mount/dismount. Start on foot.\n";
    }
    void create_input() {
        XrActionSetCreateInfo set{XR_TYPE_ACTION_SET_CREATE_INFO};std::strcpy(set.actionSetName,"ride");std::strcpy(set.localizedActionSetName,"Riding");
        xr_check(xrCreateActionSet(instance,&set,&actions),"Create riding action set");
        const auto action=[&](const char* name,XrActionType type,XrAction& result){
            XrActionCreateInfo info{XR_TYPE_ACTION_CREATE_INFO};info.actionType=type;std::strcpy(info.actionName,name);std::strcpy(info.localizedActionName,name);xr_check(xrCreateAction(actions,&info,&result),"Create riding action");};
        action("steer",XR_ACTION_TYPE_VECTOR2F_INPUT,steer);action("boost",XR_ACTION_TYPE_FLOAT_INPUT,boost);action("reset",XR_ACTION_TYPE_BOOLEAN_INPUT,reset);action("jump",XR_ACTION_TYPE_BOOLEAN_INPUT,jump);action("rail_exit",XR_ACTION_TYPE_BOOLEAN_INPUT,rail_exit);action("mount",XR_ACTION_TYPE_BOOLEAN_INPUT,mount);
        action("restart_run",XR_ACTION_TYPE_BOOLEAN_INPUT,restart);
        touch_profile=path("/interaction_profiles/oculus/touch_controller");
        hands={path("/user/hand/left"),path("/user/hand/right")};
        XrActionCreateInfo pose{XR_TYPE_ACTION_CREATE_INFO};pose.actionType=XR_ACTION_TYPE_POSE_INPUT;std::strcpy(pose.actionName,"grip_pose");std::strcpy(pose.localizedActionName,"Controller grip");pose.countSubactionPaths=2;pose.subactionPaths=hands.data();xr_check(xrCreateAction(actions,&pose,&grip),"Create controller poses");
        const std::array<XrActionSuggestedBinding,9> bindings{{{steer,path("/user/hand/left/input/thumbstick")},{boost,path("/user/hand/right/input/trigger/value")},{reset,path("/user/hand/left/input/x/click")},{jump,path("/user/hand/right/input/a/click")},{rail_exit,path("/user/hand/left/input/thumbstick/click")},{grip,path("/user/hand/left/input/grip/pose")},{grip,path("/user/hand/right/input/grip/pose")},{mount,path("/user/hand/right/input/b/click")},{restart,path("/user/hand/left/input/y/click")}}};
        XrInteractionProfileSuggestedBinding suggested{XR_TYPE_INTERACTION_PROFILE_SUGGESTED_BINDING};suggested.interactionProfile=path("/interaction_profiles/oculus/touch_controller");suggested.countSuggestedBindings=std::uint32_t(bindings.size());suggested.suggestedBindings=bindings.data();
        xr_check(xrSuggestInteractionProfileBindings(instance,&suggested),"Suggest Touch-compatible bindings");
        const std::array<XrActionSuggestedBinding,6> simple{{{grip,path("/user/hand/left/input/grip/pose")},{grip,path("/user/hand/right/input/grip/pose")},{reset,path("/user/hand/left/input/menu/click")},{jump,path("/user/hand/right/input/select/click")},{mount,path("/user/hand/right/input/menu/click")},{restart,path("/user/hand/left/input/select/click")}}};
        suggested.interactionProfile=path("/interaction_profiles/khr/simple_controller");suggested.countSuggestedBindings=std::uint32_t(simple.size());suggested.suggestedBindings=simple.data();xr_check(xrSuggestInteractionProfileBindings(instance,&suggested),"Suggest simple controller bindings");
        XrSessionActionSetsAttachInfo attach{XR_TYPE_SESSION_ACTION_SETS_ATTACH_INFO};attach.countActionSets=1;attach.actionSets=&actions;xr_check(xrAttachSessionActionSets(session,&attach),"Attach riding input");
        for(unsigned i=0;i<2;++i){XrActionSpaceCreateInfo info{XR_TYPE_ACTION_SPACE_CREATE_INFO};info.action=grip;info.subactionPath=hands[i];info.poseInActionSpace.orientation.w=1;xr_check(xrCreateActionSpace(session,&info,&grips[i]),"Create controller grip space");}
    }
    void create_body(){
        if(!body_extension){tracking_log("Avatar: procedural body; runtime has no body extension");return;}
        XrSystemBodyTrackingPropertiesFB body{XR_TYPE_SYSTEM_BODY_TRACKING_PROPERTIES_FB};
        XrSystemPropertiesBodyTrackingFullBodyMETA full{XR_TYPE_SYSTEM_PROPERTIES_BODY_TRACKING_FULL_BODY_META};
        XrSystemPropertiesBodyTrackingFidelityMETA fidelity{XR_TYPE_SYSTEM_PROPERTIES_BODY_TRACKING_FIDELITY_META};
        if(full_extension){body.next=&full;if(fidelity_extension)full.next=&fidelity;}else if(fidelity_extension)body.next=&fidelity;
        XrSystemProperties properties{XR_TYPE_SYSTEM_PROPERTIES};properties.next=&body;
        if(XR_FAILED(xrGetSystemProperties(instance,system,&properties))||!body.supportsBodyTracking){tracking_log("Avatar: body tracking unavailable; using head/controller pose");return;}
        try{
            const auto create_body=function<PFN_xrCreateBodyTrackerFB>(instance,"xrCreateBodyTrackerFB");destroy_body=function<PFN_xrDestroyBodyTrackerFB>(instance,"xrDestroyBodyTrackerFB");locate_body=function<PFN_xrLocateBodyJointsFB>(instance,"xrLocateBodyJointsFB");
            full_body=full_extension&&full.supportsFullBodyTracking;XrBodyTrackerCreateInfoFB info{XR_TYPE_BODY_TRACKER_CREATE_INFO_FB};info.bodyJointSet=full_body?XR_BODY_JOINT_SET_FULL_BODY_META:XR_BODY_JOINT_SET_DEFAULT_FB;
            auto result=create_body(session,&info,&body_tracker);
            if(XR_FAILED(result)&&full_body){full_body=false;info.bodyJointSet=XR_BODY_JOINT_SET_DEFAULT_FB;result=create_body(session,&info,&body_tracker);}
            if(XR_FAILED(result)){body_tracker=XR_NULL_HANDLE;tracking_log("Avatar: body tracker creation failed ("+std::to_string(result)+"); using head/controller pose");return;}
            fidelity_supported=fidelity_extension&&fidelity.supportsBodyTrackingFidelity;
            if(fidelity_supported){const auto request=function<PFN_xrRequestBodyTrackingFidelityMETA>(instance,"xrRequestBodyTrackingFidelityMETA");const auto requested=request(body_tracker,XR_BODY_TRACKING_FIDELITY_HIGH_META);tracking_log("Avatar: high body fidelity request result "+std::to_string(requested));}
            tracking_log(full_body?"Avatar: full body tracker ready (runtime legs)":"Avatar: upper body tracker ready (procedural legs)");
        }catch(const std::exception& error){tracking_log(std::string("Avatar: optional tracking setup: ")+error.what());}
    }
    AvatarTracking tracking(XrTime time,const XrPosef& head,Vec3 body,XrQuaternionf rotation){
        AvatarTracking result;const auto point=[&](XrVector3f p){return body+quaternion_rotate(rotation,Vec3{p.x,p.y,p.z}-origin);};
        const auto direction=[&](XrQuaternionf q,Vec3 v){return quaternion_rotate(rotation,quaternion_rotate(q,v));};
        result.head=point(head.position);result.forward=direction(head.orientation,{0,0,-1});result.up=direction(head.orientation,{0,1,0});
        if(focused)for(unsigned i=0;i<2;++i){XrActionStateGetInfo get{XR_TYPE_ACTION_STATE_GET_INFO};get.action=grip;get.subactionPath=hands[i];XrActionStatePose pose{XR_TYPE_ACTION_STATE_POSE};if(XR_FAILED(xrGetActionStatePose(session,&get,&pose))||!pose.isActive)continue;
            XrSpaceLocation location{XR_TYPE_SPACE_LOCATION};const auto valid=XR_SPACE_LOCATION_POSITION_VALID_BIT|XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
            if(XR_SUCCEEDED(xrLocateSpace(grips[i],space,time,&location))&&(location.locationFlags&valid)==valid){auto& c=result.controllers[i];c.valid=true;c.position=point(location.pose.position);c.right=direction(location.pose.orientation,{1,0,0});c.up=direction(location.pose.orientation,{0,1,0});c.forward=direction(location.pose.orientation,{0,0,-1});XrInteractionProfileState profile{XR_TYPE_INTERACTION_PROFILE_STATE};c.touch=XR_SUCCEEDED(xrGetCurrentInteractionProfile(session,hands[i],&profile))&&profile.interactionProfile==touch_profile;}
        }
        if(focused&&body_tracker){std::array<XrBodyJointLocationFB,XR_FULL_BODY_JOINT_COUNT_META> joints{};XrBodyJointsLocateInfoFB info{XR_TYPE_BODY_JOINTS_LOCATE_INFO_FB};info.baseSpace=space;info.time=time;
            XrBodyJointLocationsFB locations{XR_TYPE_BODY_JOINT_LOCATIONS_FB};locations.jointCount=full_body?XR_FULL_BODY_JOINT_COUNT_META:XR_BODY_JOINT_COUNT_FB;locations.jointLocations=joints.data();XrBodyTrackingFidelityStatusMETA fidelity{XR_TYPE_BODY_TRACKING_FIDELITY_STATUS_META};if(fidelity_supported)locations.next=&fidelity;
            if(XR_SUCCEEDED(locate_body(body_tracker,&info,&locations))&&locations.isActive){
                if(fidelity_supported&&int(fidelity.fidelity)!=actual_fidelity){actual_fidelity=int(fidelity.fidelity);tracking_log("Avatar: actual body fidelity "+std::to_string(actual_fidelity)+" (1 low / 2 high)");}
                result.body_active=true;result.full_body=full_body;result.confidence=locations.confidence;
                const std::array<unsigned,avatar_joint_count> mapping{XR_BODY_JOINT_HIPS_FB,XR_BODY_JOINT_SPINE_LOWER_FB,XR_BODY_JOINT_CHEST_FB,XR_BODY_JOINT_NECK_FB,XR_BODY_JOINT_HEAD_FB,XR_BODY_JOINT_LEFT_ARM_UPPER_FB,XR_BODY_JOINT_LEFT_ARM_LOWER_FB,XR_BODY_JOINT_LEFT_HAND_WRIST_FB,XR_BODY_JOINT_RIGHT_ARM_UPPER_FB,XR_BODY_JOINT_RIGHT_ARM_LOWER_FB,XR_BODY_JOINT_RIGHT_HAND_WRIST_FB,XR_FULL_BODY_JOINT_LEFT_UPPER_LEG_META,XR_FULL_BODY_JOINT_LEFT_LOWER_LEG_META,XR_FULL_BODY_JOINT_LEFT_FOOT_ANKLE_META,XR_FULL_BODY_JOINT_LEFT_FOOT_BALL_META,XR_FULL_BODY_JOINT_RIGHT_UPPER_LEG_META,XR_FULL_BODY_JOINT_RIGHT_LOWER_LEG_META,XR_FULL_BODY_JOINT_RIGHT_FOOT_ANKLE_META,XR_FULL_BODY_JOINT_RIGHT_FOOT_BALL_META};
                for(unsigned i=0;i<mapping.size();++i){const auto j=mapping[i];if(j<locations.jointCount&&(joints[j].locationFlags&XR_SPACE_LOCATION_POSITION_VALID_BIT)){result.valid[i]=true;result.joints[i]=point(joints[j].pose.position);}}
            }
        }
        const auto mode=result.body_active&&std::isfinite(result.confidence)&&result.confidence>.05f?(result.full_body?2:1):0;if(mode!=tracking_mode){tracking_mode=mode;tracking_log(mode==2?"Avatar pose: full body / runtime legs":mode==1?"Avatar pose: upper body / procedural legs":"Avatar pose: head/controllers / procedural body");}
        return result;
    }
    RideInput input() const {
        if(!focused)return {};
        const XrActiveActionSet active{actions,XR_NULL_PATH};XrActionsSyncInfo sync{XR_TYPE_ACTIONS_SYNC_INFO};sync.countActiveActionSets=1;sync.activeActionSets=&active;xr_check(xrSyncActions(session,&sync),"Read controller actions");
        XrActionStateGetInfo info{XR_TYPE_ACTION_STATE_GET_INFO};info.action=steer;
        XrActionStateVector2f steering{XR_TYPE_ACTION_STATE_VECTOR2F};xr_check(xrGetActionStateVector2f(session,&info,&steering),"Read steering");
        info.action=boost;XrActionStateFloat boosting{XR_TYPE_ACTION_STATE_FLOAT};xr_check(xrGetActionStateFloat(session,&info,&boosting),"Read boost");
        info.action=reset;XrActionStateBoolean resetting{XR_TYPE_ACTION_STATE_BOOLEAN};xr_check(xrGetActionStateBoolean(session,&info,&resetting),"Read reset");
        info.action=jump;XrActionStateBoolean jumping{XR_TYPE_ACTION_STATE_BOOLEAN};xr_check(xrGetActionStateBoolean(session,&info,&jumping),"Read charged jump");
        info.action=mount;XrActionStateBoolean mounting{XR_TYPE_ACTION_STATE_BOOLEAN};xr_check(xrGetActionStateBoolean(session,&info,&mounting),"Read board mounting");
        info.action=restart;XrActionStateBoolean restarting{XR_TYPE_ACTION_STATE_BOOLEAN};xr_check(xrGetActionStateBoolean(session,&info,&restarting),"Read run restart");
        info.action=rail_exit;XrActionStateBoolean leaving{XR_TYPE_ACTION_STATE_BOOLEAN};xr_check(xrGetActionStateBoolean(session,&info,&leaving),"Read rail exit");
        const auto y=walking?(steering.isActive?steering.currentState.y:0):steering.isActive&&std::abs(steering.currentState.y)>.1f&&std::abs(steering.currentState.y)>=std::abs(steering.currentState.x)?steering.currentState.y:0;
        return {steering.isActive?-steering.currentState.x:0,boosting.isActive&&boosting.currentState>.5f,resetting.isActive&&resetting.changedSinceLastSync&&resetting.currentState,jumping.isActive&&jumping.currentState,y,leaving.isActive&&leaving.currentState,mounting.isActive&&mounting.currentState,walk_forward,room_offset,restarting.isActive&&restarting.currentState};
    }
    void events() {
        XrEventDataBuffer event{XR_TYPE_EVENT_DATA_BUFFER};XrResult result;
        while((result=xrPollEvent(instance,&event))==XR_SUCCESS) {
            if(event.type==XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING)quit=true;
            if(event.type==XR_TYPE_EVENT_DATA_REFERENCE_SPACE_CHANGE_PENDING)reference_change=reinterpret_cast<const XrEventDataReferenceSpaceChangePending*>(&event)->changeTime;
            if(event.type==XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED) {
                const auto state=reinterpret_cast<XrEventDataSessionStateChanged*>(&event)->state;
                focused=state==XR_SESSION_STATE_FOCUSED;
                if(state==XR_SESSION_STATE_READY){XrSessionBeginInfo begin{XR_TYPE_SESSION_BEGIN_INFO};begin.primaryViewConfigurationType=XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;xr_check(xrBeginSession(session,&begin),"Begin VR session");running=true;}
                if(state==XR_SESSION_STATE_STOPPING){xr_check(xrEndSession(session),"End VR session");running=false;anchored=false;}
                if(state==XR_SESSION_STATE_EXITING||state==XR_SESSION_STATE_LOSS_PENDING)quit=true;
            }
            event={XR_TYPE_EVENT_DATA_BUFFER};
        }
        xr_check(result,"Poll OpenXR events");
    }
};
}
int run_openxr(Player& player,const XrPlatform& platform,double seconds) {
    player.start_on_foot();State state;state.create(platform,player.terrain().mesh());
    AudioScene audio(player.terrain().map_root());audio.mixer().paused(true);AudioDevice audio_device(audio.mixer());AudioService audio_service(audio);player.observe_ticks([&](const Player& p,const Rider& before){audio.tick(p,before);});
    using Clock=std::chrono::steady_clock;const auto started=Clock::now();auto sample_started=started;XrTime previous_time=0;
    unsigned sample_frames=0;double frame_wait=0,simulation=0,pose_time=0,image_wait_time=0,render_time=0,resource_wait=0,end_time=0,gpu_time=0,total_time=0;unsigned gpu_samples=0;
    const auto reset_sample=[&](auto now){sample_started=now;sample_frames=0;frame_wait=simulation=pose_time=image_wait_time=render_time=resource_wait=end_time=gpu_time=total_time=0;gpu_samples=0;};
    while(!state.quit) {
        if(platform.process_events&&!platform.process_events())break;
        if(seconds>0&&std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count()>=seconds)break;
        state.events();audio.mixer().paused(!state.running||!state.focused);if(state.quit)break;
        if(!state.running){previous_time=0;reset_sample(Clock::now());std::this_thread::sleep_for(std::chrono::milliseconds(10));continue;}
        const auto loop_start=Clock::now();const auto ms=[](auto a,auto b){return std::chrono::duration<double,std::milli>(b-a).count();};
        if(!sample_frames)sample_started=loop_start;
        XrFrameWaitInfo wait{XR_TYPE_FRAME_WAIT_INFO};XrFrameState frame{XR_TYPE_FRAME_STATE};xr_check(xrWaitFrame(state.session,&wait,&frame),"Wait for VR frame");const auto waited=Clock::now();
        XrFrameBeginInfo begin{XR_TYPE_FRAME_BEGIN_INFO};xr_check(xrBeginFrame(state.session,&begin),"Begin VR frame");
        const auto dt=previous_time?double(frame.predictedDisplayTime-previous_time)*1e-9:0;previous_time=frame.predictedDisplayTime;
        state.walking=player.on_foot();if(state.focused)player.advance(std::max(0.0,dt),state.input());else player.release_inputs();
        const auto boarding=player.on_foot()?1:0;if(boarding!=state.boarding_mode){state.boarding_mode=boarding;tracking_log(boarding?"Boarding: on foot; B to mount nearby board":"Boarding: mounted; B to dismount");}
        const auto& run=player.course_run().status();if(int(run.phase)!=state.run_phase||run.checkpoints!=state.run_checkpoints){state.run_phase=int(run.phase);state.run_checkpoints=run.checkpoints;tracking_log((std::string("Run: ")+run_name(run.mode)+" "+run_name(run.phase)+" "+run_clock(run.clock)+"; checkpoints "+std::to_string(run.checkpoints)).c_str());}
        const auto simulated=Clock::now();double this_image_wait=0,this_render=0,this_resource_wait=0,this_gpu=0;bool gpu_valid=true;
        std::array<XrCompositionLayerProjectionView,2> projections{{{XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW},{XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW}}};
        bool rendered=false;
        if(frame.shouldRender) {
            std::array<XrView,2> views{{{XR_TYPE_VIEW},{XR_TYPE_VIEW}}};XrViewState view_state{XR_TYPE_VIEW_STATE};std::uint32_t count=0;
            XrViewLocateInfo locate{XR_TYPE_VIEW_LOCATE_INFO};locate.viewConfigurationType=XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;locate.displayTime=frame.predictedDisplayTime;locate.space=state.space;
            xr_check(xrLocateViews(state.session,&locate,&view_state,2,&count,views.data()),"Locate stereo cameras");
            const auto valid=XR_VIEW_STATE_POSITION_VALID_BIT|XR_VIEW_STATE_ORIENTATION_VALID_BIT;
            if(count==2&&(view_state.viewStateFlags&valid)==valid) {
                const auto body=player.render_position();
                XrPosef head=views[0].pose;head.position.x=(views[0].pose.position.x+views[1].pose.position.x)*.5f;head.position.y=(views[0].pose.position.y+views[1].pose.position.y)*.5f;head.position.z=(views[0].pose.position.z+views[1].pose.position.z)*.5f;
                if(state.reference_change&&frame.predictedDisplayTime>=state.reference_change){state.anchored=false;state.reference_change=0;}
                if(!state.anchored||state.anchor_serial!=player.placement_serial()){state.origin={head.position.x,state.floor_space?0:head.position.y-1.65,head.position.z};const auto direction=quaternion_rotate(head.orientation,{0,0,-1});state.reference_yaw=std::atan2(-direction.x,-direction.z);state.anchor_serial=player.placement_serial();state.anchored=true;}
                const auto facing=player.camera_forward();const auto yaw=std::atan2(-facing.x,-facing.z)-state.reference_yaw;const XrQuaternionf body_rotation{0,float(std::sin(yaw*.5)),0,float(std::cos(yaw*.5))};
                const auto tracked=state.tracking(frame.predictedDisplayTime,head,body,body_rotation);state.walk_forward=normalized(project(tracked.forward,{0,1,0}),player.camera_forward());state.room_offset=finite(tracked.head)?project(tracked.head-body,{0,1,0}):Vec3{};const auto pose=avatar_pose(player,&tracked);const auto mode=pose.tracked_body?(pose.tracked_legs?2:1):0;if(mode!=state.pose_mode){state.pose_mode=mode;tracking_log(mode==2?"Avatar rendered pose: tracked full body and legs":mode==1?"Avatar rendered pose: tracked upper body, procedural legs":"Avatar rendered pose: procedural head/controller fallback");}const auto avatar_mesh=state.avatar.mesh(pose,true,true,tracked.head);
                for(unsigned i=0;i<2;++i) {
                    if(i==0)pose_time+=ms(simulated,Clock::now());const auto image_start=Clock::now();
                    auto& eye=state.eyes[i];std::uint32_t image=0;XrSwapchainImageAcquireInfo acquire{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};xr_check(xrAcquireSwapchainImage(eye.swapchain,&acquire,&image),"Acquire eye image");
                    XrSwapchainImageWaitInfo image_wait{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};image_wait.timeout=XR_INFINITE_DURATION;xr_check(xrWaitSwapchainImage(eye.swapchain,&image_wait),"Wait for eye image");
                    this_image_wait+=ms(image_start,Clock::now());const auto render_start=Clock::now();
                    const auto& camera=views[i];
                    const auto eye_position=body+quaternion_rotate(body_rotation,Vec3{camera.pose.position.x,camera.pose.position.y,camera.pose.position.z}-state.origin);
                    const auto forward=quaternion_rotate(body_rotation,quaternion_rotate(camera.pose.orientation,{0,0,-1}));
                    const auto up=quaternion_rotate(body_rotation,quaternion_rotate(camera.pose.orientation,{0,1,0}));
                    if(i==0)audio.listener({eye_position,forward,up});
                    const auto matrix=projection(std::tan(camera.fov.angleLeft),std::tan(camera.fov.angleRight),std::tan(camera.fov.angleDown),std::tan(camera.fov.angleUp))*view(eye_position,forward,up);
                    eye.renderer->render(image,matrix,board_transform(player.render_board_position(),player.render_forward(),player.render_up()),VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,{},{},eye_position,player.effects().sprites(),player.effects().wake(),player.effects().sheet(),avatar_mesh);
                    this_render+=ms(render_start,Clock::now());const auto& stats=eye.renderer->stats();this_resource_wait+=stats.wait_ms;this_gpu+=stats.gpu_ms;gpu_valid&=stats.gpu_ms>=0;
                    XrSwapchainImageReleaseInfo release{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};xr_check(xrReleaseSwapchainImage(eye.swapchain,&release),"Release eye image");
                    projections[i].pose=camera.pose;projections[i].fov=camera.fov;projections[i].subImage.swapchain=eye.swapchain;projections[i].subImage.imageRect.extent={std::int32_t(eye.width),std::int32_t(eye.height)};
                }
                rendered=true;
            }
        }
        XrCompositionLayerProjection layer{XR_TYPE_COMPOSITION_LAYER_PROJECTION};layer.space=state.space;layer.viewCount=2;layer.views=projections.data();
        const XrCompositionLayerBaseHeader* layer_pointer=reinterpret_cast<const XrCompositionLayerBaseHeader*>(&layer);
        XrFrameEndInfo end{XR_TYPE_FRAME_END_INFO};end.displayTime=frame.predictedDisplayTime;end.environmentBlendMode=XR_ENVIRONMENT_BLEND_MODE_OPAQUE;end.layerCount=rendered?1:0;end.layers=rendered?&layer_pointer:nullptr;
        const auto end_start=Clock::now();xr_check(xrEndFrame(state.session,&end),"Submit VR frame");
        const auto now=std::chrono::steady_clock::now();
        if(!rendered){reset_sample(now);continue;}
        if(rendered){++sample_frames;frame_wait+=ms(loop_start,waited);simulation+=ms(waited,simulated);image_wait_time+=this_image_wait;render_time+=this_render;resource_wait+=this_resource_wait;end_time+=ms(end_start,now);total_time+=ms(loop_start,now);if(gpu_valid){gpu_time+=this_gpu;++gpu_samples;}}
        if(rendered&&now-sample_started>=std::chrono::seconds(5)){
            const auto n=double(sample_frames),fps=n/std::chrono::duration<double>(now-sample_started).count(),hz=frame.predictedDisplayPeriod>0?1e9/double(frame.predictedDisplayPeriod):0.;
            char message[768];std::snprintf(message,sizeof(message),"XR frames: %.1f fps / %.1f Hz; focused %d; total %.2f ms; wait-frame %.2f; simulation %.2f; tracking/avatar %.2f; image-wait %.2f; render-submit %.2f; resource-wait %.2f; end-frame %.2f; GPU previous %.2f ms; eye %ux%u MSAA %u",fps,hz,int(state.focused),total_time/n,frame_wait/n,simulation/n,pose_time/n,image_wait_time/n,render_time/n,resource_wait/n,end_time/n,gpu_samples?gpu_time/gpu_samples:-1.,state.eyes[0].width,state.eyes[0].height,state.eyes[0].renderer->samples());tracking_log(message);
            reset_sample(now);
        }
    }
    player.observe_ticks({});return 0;
}
}
