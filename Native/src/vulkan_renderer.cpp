#include "vulkan_renderer.hpp"
#include "terrain_vert.hpp"
#include "terrain_frag.hpp"
#include <cstring>
#include <cstddef>
#include <fstream>
#include <stdexcept>

namespace openslope {
namespace {
struct DrawPush {Matrix mvp;std::array<std::int32_t,4> options{};};
static_assert(sizeof(DrawPush)==80);
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
    VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};info.size=size;info.usage=usage;
    vk_check(vkCreateBuffer(context_.device,&info,nullptr,&buffer.buffer),"Create buffer");
    VkMemoryRequirements requirements;vkGetBufferMemoryRequirements(context_.device,buffer.buffer,&requirements);
    VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};allocation.allocationSize=requirements.size;
    allocation.memoryTypeIndex=memory_type(requirements.memoryTypeBits,VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT|VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    vk_check(vkAllocateMemory(context_.device,&allocation,nullptr,&buffer.memory),"Allocate buffer memory");
    vk_check(vkBindBufferMemory(context_.device,buffer.buffer,buffer.memory,0),"Bind buffer");
    if(data){void* mapped;vk_check(vkMapMemory(context_.device,buffer.memory,0,size,0,&mapped),"Map buffer");std::memcpy(mapped,data,std::size_t(size));vkUnmapMemory(context_.device,buffer.memory);}
    return buffer;
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
    VkCommandPoolCreateInfo pool{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};pool.queueFamilyIndex=context_.family;pool.flags=VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    vk_check(vkCreateCommandPool(context_.device,&pool,nullptr,&pool_),"Create command pool");
    VkCommandBufferAllocateInfo allocate{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};allocate.commandPool=pool_;allocate.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY;allocate.commandBufferCount=1;
    vk_check(vkAllocateCommandBuffers(context_.device,&allocate,&command_),"Allocate draw command");
    VkFenceCreateInfo fence{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};fence.flags=VK_FENCE_CREATE_SIGNALED_BIT;
    vk_check(vkCreateFence(context_.device,&fence,nullptr,&fence_),"Create render fence");
}
VulkanRenderer::~VulkanRenderer() {
    if(!context_.device)return;vkDeviceWaitIdle(context_.device);clear_targets();
    if(fence_)vkDestroyFence(context_.device,fence_,nullptr);if(pool_)vkDestroyCommandPool(context_.device,pool_,nullptr);
}
void VulkanRenderer::clear_targets() {
    if(targets_.empty()&&!pass_)return;vkDeviceWaitIdle(context_.device);
    for(auto& target:targets_) {
        if(target.framebuffer)vkDestroyFramebuffer(context_.device,target.framebuffer,nullptr);
        if(target.colour_view)vkDestroyImageView(context_.device,target.colour_view,nullptr);
        if(target.depth_view)vkDestroyImageView(context_.device,target.depth_view,nullptr);
        if(target.depth)vkDestroyImage(context_.device,target.depth,nullptr);
        if(target.depth_memory)vkFreeMemory(context_.device,target.depth_memory,nullptr);
    }
    targets_.clear();
    if(pipeline_)vkDestroyPipeline(context_.device,pipeline_,nullptr);if(layout_)vkDestroyPipelineLayout(context_.device,layout_,nullptr);
    if(pass_)vkDestroyRenderPass(context_.device,pass_,nullptr);pipeline_={};layout_={};pass_={};
}
void VulkanRenderer::targets(std::span<const VkImage> images,VkFormat format,std::uint32_t width,std::uint32_t height) {
    if(!scene_)throw std::runtime_error("Upload map assets before creating render targets");
    clear_targets();width_=width;height_=height;format_=format;
    VkAttachmentDescription colour{};colour.format=format;colour.samples=VK_SAMPLE_COUNT_1_BIT;colour.loadOp=VK_ATTACHMENT_LOAD_OP_CLEAR;colour.storeOp=VK_ATTACHMENT_STORE_OP_STORE;colour.initialLayout=VK_IMAGE_LAYOUT_UNDEFINED;colour.finalLayout=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    VkAttachmentDescription depth{};depth.format=VK_FORMAT_D32_SFLOAT;depth.samples=VK_SAMPLE_COUNT_1_BIT;depth.loadOp=VK_ATTACHMENT_LOAD_OP_CLEAR;depth.storeOp=VK_ATTACHMENT_STORE_OP_DONT_CARE;depth.initialLayout=VK_IMAGE_LAYOUT_UNDEFINED;depth.finalLayout=VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
    const std::array<VkAttachmentDescription,2> attachments{colour,depth};
    VkAttachmentReference colour_ref{0,VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL},depth_ref{1,VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
    VkSubpassDescription subpass{};subpass.pipelineBindPoint=VK_PIPELINE_BIND_POINT_GRAPHICS;subpass.colorAttachmentCount=1;subpass.pColorAttachments=&colour_ref;subpass.pDepthStencilAttachment=&depth_ref;
    VkSubpassDependency dependency{};dependency.srcSubpass=VK_SUBPASS_EXTERNAL;dependency.dstSubpass=0;
    dependency.srcStageMask=dependency.dstStageMask=VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT|VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT;
    dependency.dstAccessMask=VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT|VK_ACCESS_DEPTH_STENCIL_ATTACHMENT_WRITE_BIT;
    VkRenderPassCreateInfo pass{VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO};pass.attachmentCount=2;pass.pAttachments=attachments.data();pass.subpassCount=1;pass.pSubpasses=&subpass;pass.dependencyCount=1;pass.pDependencies=&dependency;
    vk_check(vkCreateRenderPass(context_.device,&pass,nullptr,&pass_),"Create terrain render pass");
    VkPushConstantRange push{draw_stages,0,sizeof(DrawPush)};
    VkPipelineLayoutCreateInfo layout{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};layout.pushConstantRangeCount=1;layout.pPushConstantRanges=&push;layout.setLayoutCount=1;layout.pSetLayouts=&scene_->descriptors_;
    vk_check(vkCreatePipelineLayout(context_.device,&layout,nullptr,&layout_),"Create pipeline layout");
    const auto shader=[&](const auto& words){VkShaderModuleCreateInfo info{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};info.codeSize=sizeof(words);info.pCode=words;VkShaderModule result;vk_check(vkCreateShaderModule(context_.device,&info,nullptr,&result),"Create shader");return result;};
    const auto vertex=shader(terrain_vert),fragment=shader(terrain_frag);
    std::array<VkPipelineShaderStageCreateInfo,2> stages{};
    stages[0]={VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};stages[0].stage=VK_SHADER_STAGE_VERTEX_BIT;stages[0].module=vertex;stages[0].pName="main";
    stages[1]={VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO};stages[1].stage=VK_SHADER_STAGE_FRAGMENT_BIT;stages[1].module=fragment;stages[1].pName="main";
    VkVertexInputBindingDescription binding{0,sizeof(Vertex),VK_VERTEX_INPUT_RATE_VERTEX};
    const std::array<VkVertexInputAttributeDescription,5> attributes{{{0,0,VK_FORMAT_R32G32B32_SFLOAT,offsetof(Vertex,x)},{1,0,VK_FORMAT_R32G32B32_SFLOAT,offsetof(Vertex,r)},{2,0,VK_FORMAT_R32G32_SFLOAT,offsetof(Vertex,s)},{3,0,VK_FORMAT_R32G32_SFLOAT,offsetof(Vertex,ls)},{4,0,VK_FORMAT_R32G32B32A32_SFLOAT,offsetof(Vertex,lx)}}};
    VkPipelineVertexInputStateCreateInfo input{VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};input.vertexBindingDescriptionCount=1;input.pVertexBindingDescriptions=&binding;input.vertexAttributeDescriptionCount=5;input.pVertexAttributeDescriptions=attributes.data();
    VkPipelineInputAssemblyStateCreateInfo assembly{VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO};assembly.topology=VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
    VkPipelineViewportStateCreateInfo viewport{VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO};viewport.viewportCount=1;viewport.scissorCount=1;
    VkPipelineRasterizationStateCreateInfo raster{VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO};raster.polygonMode=VK_POLYGON_MODE_FILL;raster.cullMode=VK_CULL_MODE_NONE;raster.lineWidth=1;
    VkPipelineMultisampleStateCreateInfo multisample{VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO};multisample.rasterizationSamples=VK_SAMPLE_COUNT_1_BIT;
    VkPipelineDepthStencilStateCreateInfo depth_state{VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO};depth_state.depthTestEnable=VK_TRUE;depth_state.depthWriteEnable=VK_TRUE;depth_state.depthCompareOp=VK_COMPARE_OP_LESS;
    VkPipelineColorBlendAttachmentState blend{};blend.colorWriteMask=15;
    VkPipelineColorBlendStateCreateInfo blend_state{VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO};blend_state.attachmentCount=1;blend_state.pAttachments=&blend;
    const std::array<VkDynamicState,2> dynamic_states{VK_DYNAMIC_STATE_VIEWPORT,VK_DYNAMIC_STATE_SCISSOR};
    VkPipelineDynamicStateCreateInfo dynamic{VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO};dynamic.dynamicStateCount=2;dynamic.pDynamicStates=dynamic_states.data();
    VkGraphicsPipelineCreateInfo pipeline{VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO};pipeline.stageCount=2;pipeline.pStages=stages.data();pipeline.pVertexInputState=&input;pipeline.pInputAssemblyState=&assembly;pipeline.pViewportState=&viewport;pipeline.pRasterizationState=&raster;pipeline.pMultisampleState=&multisample;pipeline.pDepthStencilState=&depth_state;pipeline.pColorBlendState=&blend_state;pipeline.pDynamicState=&dynamic;pipeline.layout=layout_;pipeline.renderPass=pass_;
    const auto pipeline_result=vkCreateGraphicsPipelines(context_.device,{},1,&pipeline,nullptr,&pipeline_);
    vkDestroyShaderModule(context_.device,vertex,nullptr);vkDestroyShaderModule(context_.device,fragment,nullptr);vk_check(pipeline_result,"Create terrain pipeline");
    for(auto image:images) {
        targets_.push_back({});auto& target=targets_.back();target.colour=image;
        VkImageViewCreateInfo view_info{VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO};view_info.image=image;view_info.viewType=VK_IMAGE_VIEW_TYPE_2D;view_info.format=format;view_info.subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
        vk_check(vkCreateImageView(context_.device,&view_info,nullptr,&target.colour_view),"Create colour view");
        VkImageCreateInfo depth_info{VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO};depth_info.imageType=VK_IMAGE_TYPE_2D;depth_info.format=VK_FORMAT_D32_SFLOAT;depth_info.extent={width,height,1};depth_info.mipLevels=1;depth_info.arrayLayers=1;depth_info.samples=VK_SAMPLE_COUNT_1_BIT;depth_info.tiling=VK_IMAGE_TILING_OPTIMAL;depth_info.usage=VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT;
        vk_check(vkCreateImage(context_.device,&depth_info,nullptr,&target.depth),"Create depth image");
        VkMemoryRequirements memory;vkGetImageMemoryRequirements(context_.device,target.depth,&memory);
        VkMemoryAllocateInfo allocation{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};allocation.allocationSize=memory.size;allocation.memoryTypeIndex=memory_type(memory.memoryTypeBits,VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
        vk_check(vkAllocateMemory(context_.device,&allocation,nullptr,&target.depth_memory),"Allocate depth memory");vk_check(vkBindImageMemory(context_.device,target.depth,target.depth_memory,0),"Bind depth memory");
        view_info.image=target.depth;view_info.format=VK_FORMAT_D32_SFLOAT;view_info.subresourceRange.aspectMask=VK_IMAGE_ASPECT_DEPTH_BIT;
        vk_check(vkCreateImageView(context_.device,&view_info,nullptr,&target.depth_view),"Create depth view");
        const std::array<VkImageView,2> views{target.colour_view,target.depth_view};
        VkFramebufferCreateInfo framebuffer{VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO};framebuffer.renderPass=pass_;framebuffer.attachmentCount=2;framebuffer.pAttachments=views.data();framebuffer.width=width;framebuffer.height=height;framebuffer.layers=1;
        vk_check(vkCreateFramebuffer(context_.device,&framebuffer,nullptr,&target.framebuffer),"Create framebuffer");
    }
}
void VulkanRenderer::render(unsigned image,const Matrix& camera,const Matrix& board,VkImageLayout final_layout,VkSemaphore wait,VkSemaphore signal) {
    vk_check(vkWaitForFences(context_.device,1,&fence_,VK_TRUE,UINT64_MAX),"Wait for previous frame");vk_check(vkResetFences(context_.device,1,&fence_),"Reset render fence");vk_check(vkResetCommandBuffer(command_,0),"Reset draw command");
    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};begin.flags=VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vk_check(vkBeginCommandBuffer(command_,&begin),"Begin draw command");
    std::array<VkClearValue,2> clear{};clear[0].color={{.065f,.11f,.18f,1}};clear[1].depthStencil={1,0};
    VkRenderPassBeginInfo pass{VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO};pass.renderPass=pass_;pass.framebuffer=targets_.at(image).framebuffer;pass.renderArea.extent={width_,height_};pass.clearValueCount=2;pass.pClearValues=clear.data();
    vkCmdBeginRenderPass(command_,&pass,VK_SUBPASS_CONTENTS_INLINE);vkCmdBindPipeline(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,pipeline_);
    const VkViewport viewport{0,0,float(width_),float(height_),0,1};const VkRect2D scissor{{0,0},{width_,height_}};
    vkCmdSetViewport(command_,0,1,&viewport);vkCmdSetScissor(command_,0,1,&scissor);
    const VkDeviceSize offset=0;vkCmdBindVertexBuffers(command_,0,1,&scene_->vertices_.buffer,&offset);vkCmdBindIndexBuffer(command_,scene_->indices_.buffer,0,VK_INDEX_TYPE_UINT32);
    DrawPush push{camera,{0,format_==VK_FORMAT_R8G8B8A8_SRGB||format_==VK_FORMAT_B8G8R8A8_SRGB?1:0,0,0}};
    for(const auto& draw:scene_->draws_){
        push.options[0]=draw.mode;vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,0,1,&draw.set,0,nullptr);
        vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDrawIndexed(command_,draw.count,1,draw.first,0,0);
    }
    push.mvp=camera*board;push.options[0]=0;vkCmdBindDescriptorSets(command_,VK_PIPELINE_BIND_POINT_GRAPHICS,layout_,0,1,&scene_->board_set_,0,nullptr);vkCmdPushConstants(command_,layout_,draw_stages,0,sizeof(push),&push);vkCmdDrawIndexed(command_,6,1,scene_->board_first_,0,0);vkCmdEndRenderPass(command_);
    if(final_layout!=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL) {
        VkImageMemoryBarrier barrier{VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER};barrier.srcAccessMask=VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;barrier.dstAccessMask=final_layout==VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL?VK_ACCESS_TRANSFER_READ_BIT:0;
        barrier.oldLayout=VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;barrier.newLayout=final_layout;barrier.srcQueueFamilyIndex=barrier.dstQueueFamilyIndex=VK_QUEUE_FAMILY_IGNORED;barrier.image=targets_[image].colour;barrier.subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1};
        vkCmdPipelineBarrier(command_,VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,final_layout==VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL?VK_PIPELINE_STAGE_TRANSFER_BIT:VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,0,0,nullptr,0,nullptr,1,&barrier);
    }
    vk_check(vkEndCommandBuffer(command_),"End draw command");
    const VkPipelineStageFlags stage=VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};submit.commandBufferCount=1;submit.pCommandBuffers=&command_;
    if(wait){submit.waitSemaphoreCount=1;submit.pWaitSemaphores=&wait;submit.pWaitDstStageMask=&stage;}if(signal){submit.signalSemaphoreCount=1;submit.pSignalSemaphores=&signal;}
    vk_check(vkQueueSubmit(context_.queue,1,&submit,fence_),"Submit terrain frame");
    // Keep ownership simple for the first prototype: no image is released to XR
    // or reused by another eye before its draw has completed.
    vk_check(vkWaitForFences(context_.device,1,&fence_,VK_TRUE,UINT64_MAX),"Finish terrain frame");
}
void VulkanRenderer::capture(unsigned image,const std::filesystem::path& output) {
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
