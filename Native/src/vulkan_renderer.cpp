#include "vulkan_renderer.hpp"
#include "terrain_vert.hpp"
#include "terrain_frag.hpp"
#include <cstring>
#include <cstddef>
#include <chrono>
#include <map>
#include <algorithm>
#include <fstream>
#include <stdexcept>

namespace openslope {
namespace {
struct DrawPush {Matrix mvp;std::array<std::int32_t,4> options{};std::array<float,4> fog_colour_start{},eye_end{},presentation{1,0,0,0};};
static_assert(sizeof(DrawPush)==128);
constexpr auto draw_stages=VK_SHADER_STAGE_VERTEX_BIT|VK_SHADER_STAGE_FRAGMENT_BIT;
}
void vk_check(VkResult result,const char* operation) {
    if(result!=VK_SUCCESS) throw std::runtime_error(std::string(operation)+": Vulkan result "+std::to_string(result));
}
VulkanContext::~VulkanContext() {
    if(device){vkDeviceWaitIdle(device);vkDestroyDevice(device,nullptr);}
    if(instance) vkDestroyInstance(instance,nullptr);
}
void VulkanContext::create(bool window) {
    vk_check(volkInitialize(),"Load Vulkan driver");
    VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};app.pApplicationName="OpenSlope Native";app.apiVersion=VK_API_VERSION_1_1;
    std::vector<const char*> extensions;
#ifdef _WIN32
    if(window) extensions={VK_KHR_SURFACE_EXTENSION_NAME,VK_KHR_WIN32_SURFACE_EXTENSION_NAME};
#else
    if(window) throw std::runtime_error("Desktop window preview is currently Windows-only; use OpenXR or capture mode");
#endif
    VkInstanceCreateInfo info{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};info.pApplicationInfo=&app;
    info.enabledExtensionCount=std::uint32_t(extensions.size());info.ppEnabledExtensionNames=extensions.data();
    vk_check(vkCreateInstance(&info,nullptr,&instance),"Create Vulkan instance");volkLoadInstance(instance);
    std::uint32_t count=0;vk_check(vkEnumeratePhysicalDevices(instance,&count,nullptr),"Enumerate GPUs");
    std::vector<VkPhysicalDevice> devices(count);vk_check(vkEnumeratePhysicalDevices(instance,&count,devices.data()),"Enumerate GPUs");
    int best=-1;
    for(auto candidate:devices) {
        VkPhysicalDeviceProperties props;vkGetPhysicalDeviceProperties(candidate,&props);
        std::uint32_t families=0;vkGetPhysicalDeviceQueueFamilyProperties(candidate,&families,nullptr);
        std::vector<VkQueueFamilyProperties> queues(families);vkGetPhysicalDeviceQueueFamilyProperties(candidate,&families,queues.data());
        for(std::uint32_t i=0;i<families;++i) if(queues[i].queueFlags&VK_QUEUE_GRAPHICS_BIT) {
            const int score=props.deviceType==VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU?2:1;
            if(score>best){physical=candidate;family=i;best=score;}break;
        }
    }
    if(!physical) throw std::runtime_error("No graphics-capable Vulkan device");
    const float priority=1;
    VkDeviceQueueCreateInfo queue_info{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};queue_info.queueFamilyIndex=family;queue_info.queueCount=1;queue_info.pQueuePriorities=&priority;
    VkDeviceCreateInfo device_info{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};device_info.queueCreateInfoCount=1;device_info.pQueueCreateInfos=&queue_info;
    const char* swapchain=VK_KHR_SWAPCHAIN_EXTENSION_NAME;
    if(window){device_info.enabledExtensionCount=1;device_info.ppEnabledExtensionNames=&swapchain;}
    vk_check(vkCreateDevice(physical,&device_info,nullptr,&device),"Create Vulkan device");volkLoadDevice(device);vkGetDeviceQueue(device,family,0,&queue);
}
std::uint32_t VulkanRenderer::memory_type(std::uint32_t bits,VkMemoryPropertyFlags flags) const {
    VkPhysicalDeviceMemoryProperties properties;vkGetPhysicalDeviceMemoryProperties(context_.physical,&properties);
    for(std::uint32_t i=0;i<properties.memoryTypeCount;++i) if((bits&(1u<<i))&&(properties.memoryTypes[i].propertyFlags&flags)==flags) return i;
    throw std::runtime_error("No suitable Vulkan memory type");
}
VulkanRenderer::Buffer VulkanRenderer::create_buffer(VkDeviceSize size,VkBufferUsageFlags usage,const void* data) {
    Buffer buffer;
    try {
    VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};info.size=size;info.usage=usage;
    vk_check(vkCreateBuffer(context_.device,&info,nullptr,&buffer.buffer),"Create buffer");
    VkMemoryRequirements requirements;vkGetBufferMemoryRequirements(context_.device,buffer.buffer,&requirements);
    VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};allocation.allocationSize=requirements.size;
    allocation.memoryTypeIndex=memory_type(requirements.memoryTypeBits,VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT|VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    vk_check(vkAllocateMemory(context_.device,&allocation,nullptr,&buffer.memory),"Allocate buffer memory");
    vk_check(vkBindBufferMemory(context_.device,buffer.buffer,buffer.memory,0),"Bind buffer");
    if(data){void* mapped;vk_check(vkMapMemory(context_.device,buffer.memory,0,size,0,&mapped),"Map buffer");std::memcpy(mapped,data,std::size_t(size));vkUnmapMemory(context_.device,buffer.memory);}
    return buffer;
    }catch(...){destroy_buffer(buffer);throw;}
}
void VulkanRenderer::destroy_buffer(Buffer& b) {
    if(b.buffer)vkDestroyBuffer(context_.device,b.buffer,nullptr);if(b.memory)vkFreeMemory(context_.device,b.memory,nullptr);b={};
}
void VulkanRenderer::upload(const Mesh& source) {
    auto scene=std::make_shared<VulkanScene>(context_);scene->upload(source);use_scene(std::move(scene));
}
void VulkanRenderer::use_scene(std::shared_ptr<VulkanScene> scene) {
    if(!scene||&scene->context_!=&context_)throw std::runtime_error("Renderer requires a scene on its Vulkan device");
    if(scene_)throw std::runtime_error("Renderer already has a scene");
    scene_=std::move(scene);
    // Eye-local placements allow both views to remain queued on the same GPU.
    poses_=create_buffer(scene_->pose_capacity_*sizeof(PropPose),VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,nullptr);
    const VkDescriptorSetLayoutBinding binding{0,VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,1,VK_SHADER_STAGE_VERTEX_BIT,nullptr};VkDescriptorSetLayoutCreateInfo pose_layout{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};pose_layout.bindingCount=1;pose_layout.pBindings=&binding;vk_check(vkCreateDescriptorSetLayout(context_.device,&pose_layout,nullptr,&pose_layout_),"Create eye placement layout");
    const VkDescriptorPoolSize size{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,1};VkDescriptorPoolCreateInfo pose_pool{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};pose_pool.maxSets=1;pose_pool.poolSizeCount=1;pose_pool.pPoolSizes=&size;vk_check(vkCreateDescriptorPool(context_.device,&pose_pool,nullptr,&pose_pool_),"Create eye placement pool");
    VkDescriptorSetAllocateInfo pose_allocate{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};pose_allocate.descriptorPool=pose_pool_;pose_allocate.descriptorSetCount=1;pose_allocate.pSetLayouts=&pose_layout_;vk_check(vkAllocateDescriptorSets(context_.device,&pose_allocate,&pose_set_),"Allocate eye placements");
    const VkDescriptorBufferInfo data{poses_.buffer,0,scene_->pose_capacity_*sizeof(PropPose)};VkWriteDescriptorSet write{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};write.dstSet=pose_set_;write.dstBinding=0;write.descriptorCount=1;write.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;write.pBufferInfo=&data;vkUpdateDescriptorSets(context_.device,1,&write,0,nullptr);
    VkCommandPoolCreateInfo pool{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};pool.queueFamilyIndex=context_.family;pool.flags=VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    vk_check(vkCreateCommandPool(context_.device,&pool,nullptr,&pool_),"Create command pool");
    VkCommandBufferAllocateInfo allocate{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};allocate.commandPool=pool_;allocate.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY;allocate.commandBufferCount=1;
    vk_check(vkAllocateCommandBuffers(context_.device,&allocate,&command_),"Allocate draw command");
    VkFenceCreateInfo fence{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};fence.flags=VK_FENCE_CREATE_SIGNALED_BIT;
    vk_check(vkCreateFence(context_.device,&fence,nullptr,&fence_),"Create render fence");
    std::uint32_t families=0;vkGetPhysicalDeviceQueueFamilyProperties(context_.physical,&families,nullptr);std::vector<VkQueueFamilyProperties> properties(families);vkGetPhysicalDeviceQueueFamilyProperties(context_.physical,&families,properties.data());timestamp_bits_=properties.at(context_.family).timestampValidBits;
    if(timestamp_bits_){VkPhysicalDeviceProperties device;vkGetPhysicalDeviceProperties(context_.physical,&device);timestamp_period_=device.limits.timestampPeriod;VkQueryPoolCreateInfo query{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};query.queryType=VK_QUERY_TYPE_TIMESTAMP;query.queryCount=2;vk_check(vkCreateQueryPool(context_.device,&query,nullptr,&timing_),"Create frame timestamp queries");}
}
VulkanRenderer::~VulkanRenderer() {
    if(!context_.device)return;vkDeviceWaitIdle(context_.device);clear_targets();
    if(fence_)vkDestroyFence(context_.device,fence_,nullptr);if(pool_)vkDestroyCommandPool(context_.device,pool_,nullptr);
    if(timing_)vkDestroyQueryPool(context_.device,timing_,nullptr);
    if(pose_pool_)vkDestroyDescriptorPool(context_.device,pose_pool_,nullptr);if(pose_layout_)vkDestroyDescriptorSetLayout(context_.device,pose_layout_,nullptr);destroy_buffer(poses_);
    destroy_buffer(visible_indices_);
    destroy_buffer(sprite_vertices_);
    destroy_buffer(wake_vertices_);
    destroy_buffer(avatar_vertices_);
    destroy_buffer(sheet_vertices_);
}
void VulkanRenderer::clear_targets() {
    if(targets_.empty()&&!pass_)return;vkDeviceWaitIdle(context_.device);
    for(auto& target:targets_) {
        if(target.framebuffer)vkDestroyFramebuffer(context_.device,target.framebuffer,nullptr);
        if(target.colour_view)vkDestroyImageView(context_.device,target.colour_view,nullptr);
        if(target.depth_view)vkDestroyImageView(context_.device,target.depth_view,nullptr);
        if(target.depth)vkDestroyImage(context_.device,target.depth,nullptr);
        if(target.depth_memory)vkFreeMemory(context_.device,target.depth_memory,nullptr);
        if(target.multisample_view)vkDestroyImageView(context_.device,target.multisample_view,nullptr);
        if(target.multisample)vkDestroyImage(context_.device,target.multisample,nullptr);
        if(target.multisample_memory)vkFreeMemory(context_.device,target.multisample_memory,nullptr);
    }
    targets_.clear();
    if(pipeline_)vkDestroyPipeline(context_.device,pipeline_,nullptr);if(blend_pipeline_)vkDestroyPipeline(context_.device,blend_pipeline_,nullptr);if(layout_)vkDestroyPipelineLayout(context_.device,layout_,nullptr);
    if(sprite_pipeline_)vkDestroyPipeline(context_.device,sprite_pipeline_,nullptr);sprite_pipeline_={};
    if(wake_pipeline_)vkDestroyPipeline(context_.device,wake_pipeline_,nullptr);wake_pipeline_={};
    if(sky_pipeline_)vkDestroyPipeline(context_.device,sky_pipeline_,nullptr);sky_pipeline_={};
    if(pass_)vkDestroyRenderPass(context_.device,pass_,nullptr);pipeline_={};blend_pipeline_={};layout_={};pass_={};
}
void VulkanRenderer::targets(std::span<const VkImage> images,VkFormat format,std::uint32_t width,std::uint32_t height,unsigned requested_samples) {
    if(!scene_)throw std::runtime_error("Upload map assets before creating render targets");
    if(requested_samples!=1&&requested_samples!=2&&requested_samples!=4&&requested_samples!=8)throw std::runtime_error("MSAA must be 1, 2, 4 or 8");
    clear_targets();width_=width;height_=height;format_=format;
    VkPhysicalDeviceProperties properties;vkGetPhysicalDeviceProperties(context_.physical,&properties);
    VkImageFormatProperties colour_support{},depth_support{};
    vk_check(vkGetPhysicalDeviceImageFormatProperties(context_.physical,format,VK_IMAGE_TYPE_2D,VK_IMAGE_TILING_OPTIMAL,VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT,0,&colour_support),"Query colour sample counts");
    vk_check(vkGetPhysicalDeviceImageFormatProperties(context_.physical,VK_FORMAT_D32_SFLOAT,VK_IMAGE_TYPE_2D,VK_IMAGE_TILING_OPTIMAL,VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT,0,&depth_support),"Query depth sample counts");
    if(images.empty()||!width||!height||width>std::min(colour_support.maxExtent.width,depth_support.maxExtent.width)||height>std::min(colour_support.maxExtent.height,depth_support.maxExtent.height))throw std::runtime_error("Invalid render target dimensions/count");
    const auto supported=properties.limits.framebufferColorSampleCounts&properties.limits.framebufferDepthSampleCounts&colour_support.sampleCounts&depth_support.sampleCounts;
    samples_=VK_SAMPLE_COUNT_1_BIT;for(const auto count:{8u,4u,2u,1u})if(count<=requested_samples&&(supported&count)){samples_=static_cast<VkSampleCountFlagBits>(count);break;}
    VkAttachmentDescription colour{};colour.format=format;colour.samples=VK_SAMPLE_COUNT_1_BIT;colour.loadOp=VK_ATTACHMENT_LOAD_OP_CLEAR;colour.storeOp=VK_ATTACHMENT_STORE_OP_STORE;colour.initialLayout=VK_IMAGE_LAYOUT_UNDEFINED;colour.finalLayout=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    VkAttachmentDescription depth{};depth.format=VK_FORMAT_D32_SFLOAT;depth.samples=VK_SAMPLE_COUNT_1_BIT;depth.loadOp=VK_ATTACHMENT_LOAD_OP_CLEAR;depth.storeOp=VK_ATTACHMENT_STORE_OP_DONT_CARE;depth.initialLayout=VK_IMAGE_LAYOUT_UNDEFINED;depth.finalLayout=VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
    auto resolve=colour;resolve.loadOp=VK_ATTACHMENT_LOAD_OP_DONT_CARE;colour.samples=depth.samples=samples_;if(samples_!=VK_SAMPLE_COUNT_1_BIT)colour.storeOp=VK_ATTACHMENT_STORE_OP_DONT_CARE;
    const std::array<VkAttachmentDescription,3> attachments{colour,depth,resolve};
    VkAttachmentReference colour_ref{0,VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL},depth_ref{1,VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
    VkSubpassDescription subpass{};subpass.pipelineBindPoint=VK_PIPELINE_BIND_POINT_GRAPHICS;subpass.colorAttachmentCount=1;subpass.pColorAttachments=&colour_ref;subpass.pDepthStencilAttachment=&depth_ref;
    const VkAttachmentReference resolve_ref{2,VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};if(samples_!=VK_SAMPLE_COUNT_1_BIT)subpass.pResolveAttachments=&resolve_ref;
    VkSubpassDependency dependency{};dependency.srcSubpass=VK_SUBPASS_EXTERNAL;dependency.dstSubpass=0;
    dependency.srcStageMask=dependency.dstStageMask=VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT|VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT|VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT;
    dependency.dstAccessMask=VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT|VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
    VkRenderPassCreateInfo pass{VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO};pass.attachmentCount=samples_==VK_SAMPLE_COUNT_1_BIT?2:3;pass.pAttachments=attachments.data();pass.subpassCount=1;pass.pSubpasses=&subpass;pass.dependencyCount=1;pass.pDependencies=&dependency;
    vk_check(vkCreateRenderPass(context_.device,&pass,nullptr,&pass_),"Create terrain render pass");
    VkPushConstantRange push{draw_stages,0,sizeof(DrawPush)};
    const std::array<VkDescriptorSetLayout,2> sets{scene_->descriptors_,pose_layout_};VkPipelineLayoutCreateInfo layout{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};layout.pushConstantRangeCount=1;layout.pPushConstantRanges=&push;layout.setLayoutCount=2;layout.pSetLayouts=sets.data();
    vk_check(vkCreatePipelineLayout(context_.device,&layout,nullptr,&layout_),"Create pipeline layout");
    const auto shader=[&](const auto& words){VkShaderModuleCreateInfo info{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};info.codeSize=sizeof(words);info.pCode=words;VkShaderModule result;vk_check(vkCreateShaderModule(context_.device,&info,nullptr,&result),"Create shader");return result;};
    const auto vertex=shader(terrain_vert),fragment=shader(terrain_frag);
    std::array<VkPipelineShaderStageCreateInfo,2> stages{};
    stages[0]={VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};stages[0].stage=VK_SHADER_STAGE_VERTEX_BIT;stages[0].module=vertex;stages[0].pName="main";
    stages[1]={VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};stages[1].stage=VK_SHADER_STAGE_FRAGMENT_BIT;stages[1].module=fragment;stages[1].pName="main";
    VkVertexInputBindingDescription binding{0,sizeof(Vertex),VK_VERTEX_INPUT_RATE_VERTEX};
    const std::array<VkVertexInputAttributeDescription,6> attributes{{{0,0,VK_FORMAT_R32G32B32_SFLOAT,offsetof(Vertex,x)},{1,0,VK_FORMAT_R32G32B32_SFLOAT,offsetof(Vertex,r)},{2,0,VK_FORMAT_R32G32_SFLOAT,offsetof(Vertex,s)},{3,0,VK_FORMAT_R32G32_SFLOAT,offsetof(Vertex,ls)},{4,0,VK_FORMAT_R32G32B32A32_SFLOAT,offsetof(Vertex,lx)},{5,0,VK_FORMAT_R32G32B32_SFLOAT,offsetof(Vertex,nx)}}};
    VkPipelineVertexInputStateCreateInfo input{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};input.vertexBindingDescriptionCount=1;input.pVertexBindingDescriptions=&binding;input.vertexAttributeDescriptionCount=6;input.pVertexAttributeDescriptions=attributes.data();
    VkPipelineInputAssemblyStateCreateInfo assembly{VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};assembly.topology=VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    VkPipelineViewportStateCreateInfo viewport{VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};viewport.viewportCount=1;viewport.scissorCount=1;
    VkPipelineRasterizationStateCreateInfo raster{VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};raster.polygonMode=VK_POLYGON_MODE_FILL;raster.cullMode=VK_CULL_MODE_NONE;raster.lineWidth=1;
    VkPipelineMultisampleStateCreateInfo multisample{VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};multisample.rasterizationSamples=samples_;
    VkPipelineDepthStencilStateCreateInfo depth_state{VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO};depth_state.depthTestEnable=VK_TRUE;depth_state.depthWriteEnable=VK_TRUE;depth_state.depthCompareOp=VK_COMPARE_OP_LESS_OR_EQUAL;
    VkPipelineColorBlendAttachmentState blend{};blend.colorWriteMask=15;
    VkPipelineColorBlendStateCreateInfo blend_state{VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};blend_state.attachmentCount=1;blend_state.pAttachments=&blend;
    const std::array<VkDynamicState,2> dynamic_states{VK_DYNAMIC_STATE_VIEWPORT,VK_DYNAMIC_STATE_SCISSOR};
    VkPipelineDynamicStateCreateInfo dynamic{VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO};dynamic.dynamicStateCount=2;dynamic.pDynamicStates=dynamic_states.data();
    VkGraphicsPipelineCreateInfo pipeline{VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO};pipeline.stageCount=2;pipeline.pStages=stages.data();pipeline.pVertexInputState=&input;pipeline.pInputAssemblyState=&assembly;pipeline.pViewportState=&viewport;pipeline.pRasterizationState=&raster;pipeline.pMultisampleState=&multisample;pipeline.pDepthStencilState=&depth_state;pipeline.pColorBlendState=&blend_state;pipeline.pDynamicState=&dynamic;pipeline.layout=layout_;pipeline.renderPass=pass_;
    const auto pipeline_result=vkCreateGraphicsPipelines(context_.device,{},1,&pipeline,nullptr,&pipeline_);
    VkResult blend_result=pipeline_result;
    if(pipeline_result==VK_SUCCESS){blend.blendEnable=VK_TRUE;blend.srcColorBlendFactor=VK_BLEND_FACTOR_SRC_ALPHA;blend.dstColorBlendFactor=VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;blend.colorBlendOp=VK_BLEND_OP_ADD;blend.srcAlphaBlendFactor=VK_BLEND_FACTOR_ONE;blend.dstAlphaBlendFactor=VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;blend.alphaBlendOp=VK_BLEND_OP_ADD;blend_result=vkCreateGraphicsPipelines(context_.device,{},1,&pipeline,nullptr,&blend_pipeline_);}
    VkResult sprite_result=blend_result;if(blend_result==VK_SUCCESS){blend.dstColorBlendFactor=VK_BLEND_FACTOR_ONE;blend.dstAlphaBlendFactor=VK_BLEND_FACTOR_ONE;depth_state.depthWriteEnable=VK_FALSE;sprite_result=vkCreateGraphicsPipelines(context_.device,{},1,&pipeline,nullptr,&sprite_pipeline_);}
    VkResult wake_result=sprite_result;if(sprite_result==VK_SUCCESS){blend.dstColorBlendFactor=VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;blend.dstAlphaBlendFactor=VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;wake_result=vkCreateGraphicsPipelines(context_.device,{},1,&pipeline,nullptr,&wake_pipeline_);}
    VkResult sky_result=wake_result;if(wake_result==VK_SUCCESS){blend.blendEnable=VK_FALSE;sky_result=vkCreateGraphicsPipelines(context_.device,{},1,&pipeline,nullptr,&sky_pipeline_);}
    vkDestroyShaderModule(context_.device,vertex,nullptr);vkDestroyShaderModule(context_.device,fragment,nullptr);vk_check(pipeline_result,"Create terrain pipeline");vk_check(blend_result,"Create prop blend pipeline");vk_check(sprite_result,"Create additive sprite pipeline");vk_check(sky_result,"Create sky panorama pipeline");
    vk_check(wake_result,"Create alpha wake pipeline");
    for(auto image:images) {
        targets_.push_back({});auto& target=targets_.back();target.colour=image;
        VkImageViewCreateInfo view_info{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};view_info.image=image;view_info.viewType=VK_IMAGE_VIEW_TYPE_2D;view_info.format=format;view_info.subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
        vk_check(vkCreateImageView(context_.device,&view_info,nullptr,&target.colour_view),"Create colour view");
        VkImageCreateInfo depth_info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};depth_info.imageType=VK_IMAGE_TYPE_2D;depth_info.format=VK_FORMAT_D32_SFLOAT;depth_info.extent={width,height,1};depth_info.mipLevels=1;depth_info.arrayLayers=1;depth_info.samples=samples_;depth_info.tiling=VK_IMAGE_TILING_OPTIMAL;depth_info.usage=VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT;
        vk_check(vkCreateImage(context_.device,&depth_info,nullptr,&target.depth),"Create depth image");
        VkMemoryRequirements memory;vkGetImageMemoryRequirements(context_.device,target.depth,&memory);
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};allocation.allocationSize=memory.size;allocation.memoryTypeIndex=memory_type(memory.memoryTypeBits,VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
        vk_check(vkAllocateMemory(context_.device,&allocation,nullptr,&target.depth_memory),"Allocate depth memory");vk_check(vkBindImageMemory(context_.device,target.depth,target.depth_memory,0),"Bind depth memory");
        view_info.image=target.depth;view_info.format=VK_FORMAT_D32_SFLOAT;view_info.subresourceRange.aspectMask=VK_IMAGE_ASPECT_DEPTH_BIT;
        vk_check(vkCreateImageView(context_.device,&view_info,nullptr,&target.depth_view),"Create depth view");
        if(samples_!=VK_SAMPLE_COUNT_1_BIT){
            auto info=depth_info;info.format=format;info.usage=VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
            vk_check(vkCreateImage(context_.device,&info,nullptr,&target.multisample),"Create multisample colour");vkGetImageMemoryRequirements(context_.device,target.multisample,&memory);allocation.allocationSize=memory.size;allocation.memoryTypeIndex=memory_type(memory.memoryTypeBits,VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
            vk_check(vkAllocateMemory(context_.device,&allocation,nullptr,&target.multisample_memory),"Allocate multisample colour");vk_check(vkBindImageMemory(context_.device,target.multisample,target.multisample_memory,0),"Bind multisample colour");view_info.image=target.multisample;view_info.format=format;view_info.subresourceRange.aspectMask=VK_IMAGE_ASPECT_COLOR_BIT;vk_check(vkCreateImageView(context_.device,&view_info,nullptr,&target.multisample_view),"Create multisample colour view");
        }
        const std::array<VkImageView,3> views{samples_==VK_SAMPLE_COUNT_1_BIT?target.colour_view:target.multisample_view,target.depth_view,target.colour_view};
        VkFramebufferCreateInfo framebuffer{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};framebuffer.renderPass=pass_;framebuffer.attachmentCount=pass.attachmentCount;framebuffer.pAttachments=views.data();framebuffer.width=width;framebuffer.height=height;framebuffer.layers=1;
        vk_check(vkCreateFramebuffer(context_.device,&framebuffer,nullptr,&target.framebuffer),"Create framebuffer");
    }
}
void VulkanRenderer::render(unsigned image,const Matrix& camera,const Matrix& board,VkImageLayout final_layout,VkSemaphore wait,VkSemaphore signal,Vec3 eye,std::span<const Sprite> sprites,std::span<const WakeVertex> wake,std::span<const SprayVertex> sheet,std::span<const Vertex> avatar,float fade,std::span<const std::uint8_t> instance_flags) {
    if(!instance_flags.empty()&&(!scene_||instance_flags.size()!=scene_->props_.instances.size()))throw std::invalid_argument("World instance flags disagree with rendered props");
    if(!std::isfinite(fade)||fade<0||fade>1)throw std::invalid_argument("Invalid scene fade");const auto visibility=1-fade;
    const auto started=std::chrono::steady_clock::now();finish();const auto previous_gpu=stats_.gpu_ms;stats_={};if(deferred_)stats_.gpu_ms=previous_gpu;stats_.wait_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
    vk_check(vkResetFences(context_.device,1,&fence_),"Reset render fence");vk_check(vkResetCommandBuffer(command_,0),"Reset draw command");
    const auto cull_start=std::chrono::steady_clock::now();terrain_draws_.clear();packed_indices_.clear();
    stats_.terrain_patches=unsigned(scene_->terrain_ranges_.size());stats_.terrain_total_indices=scene_->terrain_total_indices_;
    bool compact=false;stats_.visible_terrain=stats_.terrain_patches;
    if(terrain_culling_&&!scene_->terrain_ranges_.empty()){
        scene_->terrain_visibility_.query(Frustum(camera.values),visible_ranges_,stats_.visibility_tests);stats_.visible_terrain=unsigned(visible_ranges_.size());
        std::uint64_t retained=0;for(const auto id:visible_ranges_)retained+=scene_->terrain_ranges_[id].count;
        // A dense view gains little from copying almost the full index stream.
        // Keep the original submission unless at least a quarter is removed.
        compact=retained<=scene_->terrain_total_indices_*3/4;
    }
    stats_.terrain_compacted=compact;
    if(compact){
        for(const auto id:visible_ranges_){const auto& range=scene_->terrain_ranges_[id];
            if(terrain_draws_.empty()||terrain_draws_.back().material!=range.batch)terrain_draws_.push_back({std::uint32_t(packed_indices_.size()),0,range.batch});
            terrain_draws_.back().count+=range.count;packed_indices_.insert(packed_indices_.end(),scene_->terrain_indices_.begin()+range.first,scene_->terrain_indices_.begin()+range.first+range.count);
        }
        if(packed_indices_.size()>index_capacity_){destroy_buffer(visible_indices_);index_capacity_=std::min(scene_->terrain_indices_.size(),std::max(packed_indices_.size(),index_capacity_*2));visible_indices_=create_buffer(index_capacity_*sizeof(std::uint32_t),VK_BUFFER_USAGE_INDEX_BUFFER_BIT,nullptr);}
        if(!packed_indices_.empty()){void* mapped;vk_check(vkMapMemory(context_.device,visible_indices_.memory,0,packed_indices_.size()*sizeof(std::uint32_t),0,&mapped),"Map visible terrain indices");std::memcpy(mapped,packed_indices_.data(),packed_indices_.size()*sizeof(std::uint32_t));vkUnmapMemory(context_.device,visible_indices_.memory);}
        stats_.terrain_indices=packed_indices_.size();
    }else{stats_.terrain_indices=stats_.terrain_total_indices;for(std::size_t i=0;i<scene_->draws_.size();++i){const auto& draw=scene_->draws_[i];terrain_draws_.push_back({draw.first,draw.count,i});}}
    stats_.terrain_draws=unsigned(terrain_draws_.size());stats_.cull_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-cull_start).count();
    auto& sprite_mesh=sprite_mesh_;sprite_mesh.clear();
    if(scene_->effect_set_&&!sprites.empty()){
        if(sprites.size()>1024)throw std::runtime_error("Sprite submission exceeds its fixed pool limit");sprite_mesh.reserve(sprites.size()*6);
        for(const auto& sprite:sprites){if(!finite(sprite.position)||!std::isfinite(sprite.radius)||!std::isfinite(sprite.alpha)||!std::isfinite(sprite.rotation)||sprite.radius<0||sprite.radius>100||sprite.alpha<0||sprite.alpha>1)throw std::runtime_error("Invalid sprite submission");if(sprite.alpha<=0||sprite.radius<=0)continue;
            for(const auto uv:std::array<std::array<float,2>,6>{{{0,0},{1,0},{1,1},{0,0},{1,1},{0,1}}}){Vertex v{float(sprite.position.x),float(sprite.position.y),float(sprite.position.z),1,1,1};v.s=uv[0];v.t=uv[1];v.ls=sprite.radius;v.lt=sprite.rotation;v.lx=sprite.alpha;sprite_mesh.push_back(v);}++stats_.sprites;
        }
        if(sprite_mesh.size()>sprite_capacity_){destroy_buffer(sprite_vertices_);sprite_capacity_=std::min(std::size_t(6144),std::max(sprite_mesh.size(),sprite_capacity_*2));sprite_vertices_=create_buffer(sprite_capacity_*sizeof(Vertex),VK_BUFFER_USAGE_VERTEX_BUFFER_BIT,nullptr);}
        if(!sprite_mesh.empty()){void* mapped;vk_check(vkMapMemory(context_.device,sprite_vertices_.memory,0,sprite_mesh.size()*sizeof(Vertex),0,&mapped),"Map billboard vertices");std::memcpy(mapped,sprite_mesh.data(),sprite_mesh.size()*sizeof(Vertex));vkUnmapMemory(context_.device,sprite_vertices_.memory);}
    }
    wake_mesh_.clear();
    if(scene_->wake_set_&&!wake.empty()){
        if(wake.size()>594||wake.size()%6)throw std::runtime_error("Wake submission exceeds its section limit");wake_mesh_.reserve(wake.size());
        for(const auto& point:wake){if(!finite(point.position)||!finite(point.normal)||!std::isfinite(point.across)||!std::isfinite(point.along)||!std::isfinite(point.alpha)||point.alpha<0||point.alpha>1)throw std::runtime_error("Invalid wake submission");Vertex v{float(point.position.x),float(point.position.y),float(point.position.z),1,1,1};v.s=point.across;v.t=point.along;v.ls=point.alpha;v.nx=float(point.normal.x);v.ny=float(point.normal.y);v.nz=float(point.normal.z);wake_mesh_.push_back(v);}
        if(wake_mesh_.size()>wake_capacity_){destroy_buffer(wake_vertices_);wake_capacity_=std::min(std::size_t(594),std::max(wake_mesh_.size(),wake_capacity_*2));wake_vertices_=create_buffer(wake_capacity_*sizeof(Vertex),VK_BUFFER_USAGE_VERTEX_BUFFER_BIT,nullptr);}
        void* mapped;vk_check(vkMapMemory(context_.device,wake_vertices_.memory,0,wake_mesh_.size()*sizeof(Vertex),0,&mapped),"Map wake vertices");std::memcpy(mapped,wake_mesh_.data(),wake_mesh_.size()*sizeof(Vertex));vkUnmapMemory(context_.device,wake_vertices_.memory);stats_.wake_segments=unsigned(wake.size()/6);
    }
    if(avatar.size()>60000||avatar.size()%3)throw std::runtime_error("Avatar submission exceeds bounds");
    for(const auto& v:avatar)if(!finite({v.x,v.y,v.z})||!std::isfinite(v.r)||!std::isfinite(v.g)||!std::isfinite(v.b))throw std::runtime_error("Invalid avatar vertex");
    if(!avatar.empty()){
        if(avatar.size()>avatar_capacity_){destroy_buffer(avatar_vertices_);avatar_capacity_=std::min(std::size_t(60000),std::max(avatar.size(),avatar_capacity_*2));avatar_vertices_=create_buffer(avatar_capacity_*sizeof(Vertex),VK_BUFFER_USAGE_VERTEX_BUFFER_BIT,nullptr);}
        void* mapped;vk_check(vkMapMemory(context_.device,avatar_vertices_.memory,0,avatar.size()*sizeof(Vertex),0,&mapped),"Map avatar vertices");std::memcpy(mapped,avatar.data(),avatar.size()*sizeof(Vertex));vkUnmapMemory(context_.device,avatar_vertices_.memory);
    }
    stats_.avatar_triangles=unsigned(avatar.size()/3);
    sheet_mesh_.clear();
    if(scene_->sheet_set_&&!sheet.empty()){
        if(sheet.size()>2286||sheet.size()%18)throw std::runtime_error("Spray sheet submission exceeds its column limit");sheet_mesh_.reserve(sheet.size());
        for(const auto& point:sheet){if(!finite(point.position)||!std::isfinite(point.u)||!std::isfinite(point.v)||!std::isfinite(point.alpha)||point.alpha<0||point.alpha>1)throw std::runtime_error("Invalid spray sheet submission");Vertex v{float(point.position.x),float(point.position.y),float(point.position.z),1,1,1};v.s=point.u;v.t=point.v;v.ls=point.alpha;sheet_mesh_.push_back(v);}
        if(sheet_mesh_.size()>sheet_capacity_){destroy_buffer(sheet_vertices_);sheet_capacity_=std::min(std::size_t(2286),std::max(sheet_mesh_.size(),sheet_capacity_*2));sheet_vertices_=create_buffer(sheet_capacity_*sizeof(Vertex),VK_BUFFER_USAGE_VERTEX_BUFFER_BIT,nullptr);}
        void* mapped;vk_check(vkMapMemory(context_.device,sheet_vertices_.memory,0,sheet_mesh_.size()*sizeof(Vertex),0,&mapped),"Map spray sheet vertices");std::memcpy(mapped,sheet_mesh_.data(),sheet_mesh_.size()*sizeof(Vertex));vkUnmapMemory(context_.device,sheet_vertices_.memory);stats_.sheet_segments=unsigned(sheet.size()/18);
    }
    struct VisibleDraw {std::size_t part;std::uint32_t first,count;};std::vector<VisibleDraw> prop_draws;std::vector<PropPose> poses;
    std::map<std::pair<bool,std::size_t>,std::vector<std::size_t>> groups;
    struct Translucent {std::size_t part,instance;int depth;};std::vector<Translucent> transparent;
    for(std::size_t i=0;i<scene_->props_.instances.size();++i){const auto& instance=scene_->props_.instances[i];const auto& model=scene_->props_.models[instance.model];const auto visible=instance_flags.empty()?instance.visible:(instance_flags[i]&1)!=0;if(!visible||model.parts.empty()||!prop_visible(instance.bounds,camera.values,eye))continue;++stats_.visible_props;
        for(const auto part:model.parts){if(scene_->prop_draws_[part].alpha==2){const auto& m=instance.pose.matrix;const auto depth=camera.values[3]*m[12]+camera.values[7]*m[13]+camera.values[11]*m[14]+camera.values[15];transparent.push_back({part,i,int(std::clamp(depth*1023/400,0.f,1023.f))});}else groups[{(scene_->props_.parts[part].flags&(1u<<17))!=0,part}].push_back(i);}
    }
    for(const auto& [key,instances]:groups){const auto first=std::uint32_t(poses.size());for(const auto i:instances)poses.push_back(scene_->props_.instances[i].pose);prop_draws.push_back({key.second,first,std::uint32_t(instances.size())});}
    std::stable_sort(transparent.begin(),transparent.end(),[](const auto& a,const auto& b){return a.depth>b.depth;});
    for(const auto& draw:transparent){prop_draws.push_back({draw.part,std::uint32_t(poses.size()),1});poses.push_back(scene_->props_.instances[draw.instance].pose);}
    if(!poses.empty()){if(poses.size()>scene_->pose_capacity_)throw std::runtime_error("Visible instance buffer exceeds capacity");void* mapped;vk_check(vkMapMemory(context_.device,poses_.memory,0,poses.size()*sizeof(PropPose),0,&mapped),"Map visible placements");std::memcpy(mapped,poses.data(),poses.size()*sizeof(PropPose));vkUnmapMemory(context_.device,poses_.memory);}stats_.prop_draws=unsigned(prop_draws.size());
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};begin.flags=VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vk_check(vkBeginCommandBuffer(command_,&begin),"Begin draw command");
    if(timing_){vkCmdResetQueryPool(command_,timing_,0,2);vkCmdWriteTimestamp(command_,VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,timing_,0);}
    const bool srgb=format_==VK_FORMAT_R8G8B8A8_SRGB||format_==VK_FORMAT_B8G8R8A8_SRGB;
    std::array<VkClearValue,2> clear{};for(unsigned c=0;c<3;++c){const auto v=scene_->world_.sky_colour[c]*visibility;clear[0].color.float32[c]=srgb?(v<=.04045f?v/12.92f:std::pow((v+.055f)/1.055f,2.4f)):v;}clear[0].color.float32[3]=1;clear[1].depthStencil={1,0};
    VkRenderPassBeginInfo pass{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};pass.renderPass=pass_;pass.framebuffer=targets_.at(image).framebuffer;pass.renderArea.extent={width_,height_};pass.clearValueCount=2;pass.pClearValues=clear.data();
    vkCmdBeginRenderPass(command_,&pass,VK_SUBPASS_CONTENTS_INLINE);vkCmdBindPipeline(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,pipeline_);
    vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,1,1,&pose_set_,0,nullptr);
    const VkViewport viewport{0,0,float(width_),float(height_),0,1};const VkRect2D scissor{{0,0},{width_,height_}};
    vkCmdSetViewport(command_,0,1,&viewport);vkCmdSetScissor(command_,0,1,&scissor);
    const VkDeviceSize offset=0;vkCmdBindVertexBuffers(command_,0,1,&scene_->vertices_.buffer,&offset);vkCmdBindIndexBuffer(command_,scene_->indices_.buffer,0,VK_INDEX_TYPE_UINT32);
    DrawPush push{camera,{0,srgb?1:0,0,0},{scene_->world_.fog_colour[0],scene_->world_.fog_colour[1],scene_->world_.fog_colour[2],scene_->world_.fog_start},{float(eye.x),float(eye.y),float(eye.z),scene_->world_.fog_end}};
    push.presentation[0]=visibility;
    if(!scene_->sky_draws_.empty()){
        // [Trailmap: 400-backdrop] Cancel each eye's translation independently.
        auto centre=Matrix::identity();centre.values[12]=float(eye.x);centre.values[13]=float(eye.y);centre.values[14]=float(eye.z);push.mvp=camera*centre;push.options[0]=7;vkCmdBindPipeline(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,sky_pipeline_);
        for(const auto& draw:scene_->sky_draws_){vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,0,1,&draw.set,0,nullptr);vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDrawIndexed(command_,draw.count,1,draw.first,0,0);}push.mvp=camera;vkCmdBindPipeline(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,pipeline_);
    }
    if(compact&&!packed_indices_.empty())vkCmdBindIndexBuffer(command_,visible_indices_.buffer,0,VK_INDEX_TYPE_UINT32);
    for(const auto& visible:terrain_draws_){const auto& draw=scene_->draws_[visible.material];
        push.options[0]=draw.mode;vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,0,1,&draw.set,0,nullptr);
        vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDrawIndexed(command_,visible.count,1,visible.first,0,0);
    }
    vkCmdBindIndexBuffer(command_,scene_->indices_.buffer,0,VK_INDEX_TYPE_UINT32);
    const auto world_eye=push.eye_end;const auto relative=eye-Vec3{board.values[12],board.values[13],board.values[14]};for(unsigned c=0;c<3;++c)push.eye_end[c]=float(dot(relative,{board.values[c*4],board.values[c*4+1],board.values[c*4+2]}));
    push.mvp=camera*board;push.options[0]=0;vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,0,1,&scene_->board_set_,0,nullptr);vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDrawIndexed(command_,6,1,scene_->board_first_,0,0);
    push.eye_end=world_eye;push.mvp=camera;push.options[0]=0;
    if(!avatar.empty()){vkCmdBindVertexBuffers(command_,0,1,&avatar_vertices_.buffer,&offset);vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDraw(command_,std::uint32_t(avatar.size()),1,0,0);vkCmdBindVertexBuffers(command_,0,1,&scene_->vertices_.buffer,&offset);}
    push.options[0]=3;bool blending=false;
    for(const auto& visible:prop_draws){const auto& draw=scene_->prop_draws_[visible.part];if(draw.alpha==2&&!blending){vkCmdBindPipeline(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,blend_pipeline_);blending=true;}push.options[2]=draw.alpha;vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,0,1,&draw.set,0,nullptr);vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDrawIndexed(command_,draw.count,visible.count,draw.first,0,visible.first);}
    if(!wake_mesh_.empty()){
        vkCmdBindPipeline(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,wake_pipeline_);vkCmdBindVertexBuffers(command_,0,1,&wake_vertices_.buffer,&offset);push.mvp=camera;push.options[0]=5;push.options[2]=0;vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,0,1,&scene_->wake_set_,0,nullptr);
        for(int layer=0;layer<2;++layer){push.options[3]=layer;vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDraw(command_,std::uint32_t(wake_mesh_.size()),1,0,0);++stats_.wake_draws;}push.options[3]=0;
    }
    if(!sprite_mesh.empty()){vkCmdBindPipeline(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,sprite_pipeline_);vkCmdBindVertexBuffers(command_,0,1,&sprite_vertices_.buffer,&offset);push.mvp=camera;push.options[0]=4;push.options[2]=0;vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,0,1,&scene_->effect_set_,0,nullptr);vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDraw(command_,std::uint32_t(sprite_mesh.size()),1,0,0);}
    if(!sheet_mesh_.empty()){vkCmdBindPipeline(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,sprite_pipeline_);vkCmdBindVertexBuffers(command_,0,1,&sheet_vertices_.buffer,&offset);push.mvp=camera;push.options[0]=6;push.options[2]=0;vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,0,1,&scene_->sheet_set_,0,nullptr);vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDraw(command_,std::uint32_t(sheet_mesh_.size()),1,0,0);++stats_.sheet_draws;}
    vkCmdEndRenderPass(command_);
    if(final_layout!=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL) {
        VkImageMemoryBarrier barrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};barrier.srcAccessMask=VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;barrier.dstAccessMask=final_layout==VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL?VK_ACCESS_TRANSFER_READ_BIT:0;
        barrier.oldLayout=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;barrier.newLayout=final_layout;barrier.srcQueueFamilyIndex=barrier.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED;barrier.image=targets_[image].colour;barrier.subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
        vkCmdPipelineBarrier(command_,VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,final_layout==VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL?VK_PIPELINE_STAGE_TRANSFER_BIT:VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,0,0,nullptr,0,nullptr,1,&barrier);
    }
    if(timing_)vkCmdWriteTimestamp(command_,VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,timing_,1);
    vk_check(vkEndCommandBuffer(command_),"End draw command");
    const VkPipelineStageFlags stage=VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};submit.commandBufferCount=1;submit.pCommandBuffers=&command_;
    if(wait){submit.waitSemaphoreCount=1;submit.pWaitSemaphores=&wait;submit.pWaitDstStageMask=&stage;}if(signal){submit.signalSemaphoreCount=1;submit.pSignalSemaphores=&signal;}
    vk_check(vkQueueSubmit(context_.queue,1,&submit,fence_),"Submit terrain frame");
    pending_=true;if(!deferred_){const auto waited=std::chrono::steady_clock::now();finish();stats_.wait_ms+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-waited).count();}
    stats_.cpu_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();
}
void VulkanRenderer::finish(){
    if(!pending_)return;vk_check(vkWaitForFences(context_.device,1,&fence_,VK_TRUE,UINT64_MAX),"Wait for renderer resources");
    if(timing_){std::array<std::uint64_t,2> ticks{};vk_check(vkGetQueryPoolResults(context_.device,timing_,0,2,sizeof(ticks),ticks.data(),sizeof(std::uint64_t),VK_QUERY_RESULT_64_BIT),"Read completed GPU timestamps");const auto mask=timestamp_bits_>=64?UINT64_MAX:(std::uint64_t(1)<<timestamp_bits_)-1;stats_.gpu_ms=double((ticks[1]-ticks[0])&mask)*timestamp_period_/1e6;}pending_=false;
}
void VulkanRenderer::capture(unsigned image,const std::filesystem::path& output) {
    finish();
    auto buffer=create_buffer(VkDeviceSize(width_)*height_*4,VK_BUFFER_USAGE_TRANSFER_DST_BIT,nullptr);
    vk_check(vkResetCommandBuffer(command_,0),"Reset capture command");VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};vk_check(vkBeginCommandBuffer(command_,&begin),"Begin capture");
    VkBufferImageCopy copy{};copy.imageSubresource={VK_IMAGE_ASPECT_COLOR_BIT,0,0,1};copy.imageExtent={width_,height_,1};
    vkCmdCopyImageToBuffer(command_,targets_.at(image).colour,VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,buffer.buffer,1,&copy);vk_check(vkEndCommandBuffer(command_),"End capture");
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};submit.commandBufferCount=1;submit.pCommandBuffers=&command_;vk_check(vkQueueSubmit(context_.queue,1,&submit,{}),"Submit capture");vk_check(vkQueueWaitIdle(context_.queue),"Finish capture");
    void* mapped;vk_check(vkMapMemory(context_.device,buffer.memory,0,VK_WHOLE_SIZE,0,&mapped),"Read capture");
    std::ofstream file(output,std::ios::binary);if(!file)throw std::runtime_error("Cannot write capture");file<<"P6\n"<<width_<<' '<<height_<<"\n255\n";
    const auto* pixels=static_cast<const unsigned char*>(mapped);
    for(std::size_t i=0;i<std::size_t(width_)*height_;++i)file.write(reinterpret_cast<const char*>(pixels+i*4),3);
    vkUnmapMemory(context_.device,buffer.memory);destroy_buffer(buffer);
}
}
