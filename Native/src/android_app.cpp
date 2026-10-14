#include "openxr_app.hpp"
#include "openslope/import.hpp"
#include "openslope/appearance.hpp"
#include "openslope/props.hpp"
#include "openslope/world.hpp"
#include "openslope/animation.hpp"
#include "openslope/rails.hpp"
#include "openslope/paths.hpp"
#include "openslope/collision.hpp"
#include "openslope/audio_scene.hpp"
#include <android/log.h>
#include <android_native_app_glue.h>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <cerrno>
#include <unistd.h>

namespace {
bool process_events(android_app* app,int timeout=0) {
    int events;android_poll_source* source=nullptr;
    while(ALooper_pollOnce(timeout,nullptr,&events,reinterpret_cast<void**>(&source))>=0) {
        if(source)source->process(app,source);
        if(app->destroyRequested)return false;
        timeout=0;
    }
    return !app->destroyRequested;
}
std::string string_value(JNIEnv* env,jstring value) {
    if(!value)throw std::runtime_error("Missing Android document argument");
    const auto* chars=env->GetStringChars(value,nullptr);if(!chars)throw std::runtime_error("Cannot read Android string");
    const auto length=env->GetStringLength(value);std::string result;
    for(jsize i=0;i<length;++i){std::uint32_t c=chars[i];if(c>=0xd800&&c<=0xdbff&&i+1<length){const auto low=chars[++i];if(low<0xdc00||low>0xdfff){env->ReleaseStringChars(value,chars);throw std::runtime_error("Invalid Unicode document name");}c=0x10000+((c-0xd800)<<10)+(low-0xdc00);}
        if(c<0x80)result.push_back(static_cast<char>(c));else if(c<0x800){result.push_back(static_cast<char>(0xc0|(c>>6)));result.push_back(static_cast<char>(0x80|(c&63)));}else if(c<0x10000){result.push_back(static_cast<char>(0xe0|(c>>12)));result.push_back(static_cast<char>(0x80|((c>>6)&63)));result.push_back(static_cast<char>(0x80|(c&63)));}else{result.push_back(static_cast<char>(0xf0|(c>>18)));result.push_back(static_cast<char>(0x80|((c>>12)&63)));result.push_back(static_cast<char>(0x80|((c>>6)&63)));result.push_back(static_cast<char>(0x80|(c&63)));}}
    env->ReleaseStringChars(value,chars);return result;
}
void java_error(JNIEnv* env,const std::exception& error){if(env->ExceptionCheck())return;env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),error.what());}
openslope::DiscInput descriptor_input(jint descriptor,jlong length) {
    if(descriptor<0||length<17*2048)throw std::runtime_error("The ISO descriptor is invalid");
    return {static_cast<std::uint64_t>(length),[descriptor](std::uint64_t offset,std::span<std::uint8_t> data){
        std::size_t done=0;while(done<data.size()){
            const auto count=pread(descriptor,data.data()+done,data.size()-done,static_cast<off_t>(offset+done));
            if(count<0&&errno==EINTR)continue;if(count<=0)throw std::runtime_error("Cannot read ISO. Select a seekable file on local headset storage.");done+=static_cast<std::size_t>(count);
        }
    }};
}
struct Callbacks {
    JNIEnv* env;jobject activity;jmethodID cancelled,progress;
    Callbacks(JNIEnv* e,jobject a):env(e),activity(a){const auto type=env->GetObjectClass(activity);cancelled=env->GetMethodID(type,"isImportCancelled","()Z");progress=env->GetMethodID(type,"onImportProgress","(Ljava/lang/String;)V");env->DeleteLocalRef(type);if(!cancelled||!progress)throw std::runtime_error("Import host callbacks are missing");}
    bool stop() const {return env->ExceptionCheck()||env->CallBooleanMethod(activity,cancelled);}
    void notify(const std::string& text) const {const auto value=env->NewStringUTF(text.c_str());env->CallVoidMethod(activity,progress,value);env->DeleteLocalRef(value);}
};
}
extern "C" JNIEXPORT jstring JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeCourses(JNIEnv* env,jobject activity,jint descriptor,jlong length) {
    try {Callbacks callbacks(env,activity);nlohmann::json names=nlohmann::json::array();for(const auto& course:openslope::disc_courses(descriptor_input(descriptor,length),[&]{return callbacks.stop();}))names.push_back(course.name);return env->NewStringUTF(names.dump().c_str());}
    catch(const std::exception& e){java_error(env,e);return nullptr;}
}
extern "C" JNIEXPORT void JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeExtract(JNIEnv* env,jobject activity,jint descriptor,jlong length,jstring course,jstring output) {
    try {Callbacks callbacks(env,activity);openslope::extract_course(descriptor_input(descriptor,length),string_value(env,course),string_value(env,output),[&](const auto& message){callbacks.notify(message);},[&]{return callbacks.stop();});}
    catch(const std::exception& e){java_error(env,e);}
}
extern "C" JNIEXPORT void JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeValidate(JNIEnv* env,jobject,jstring path) {
    try {const auto root=std::filesystem::path(string_value(env,path));if(std::filesystem::file_size(root/"Patches.json")>64*1024*1024)throw std::runtime_error("Map terrain exceeds the loading limit");static_cast<void>(openslope::Appearance::load(openslope::Terrain::load(root)));static_cast<void>(openslope::Props::load(root));static_cast<void>(openslope::World::load(root));static_cast<void>(openslope::PoseAnimation::get_up(root));static_cast<void>(openslope::Rails::load(root));static_cast<void>(openslope::CoursePaths::load(root));static_cast<void>(openslope::CourseRun::load(root,openslope::RunMode::Showoff));static_cast<void>(openslope::CollisionWorld::load(root));static_cast<void>(openslope::AudioScene(root));}
    catch(const std::exception& e){java_error(env,e);}
}
extern "C" JNIEXPORT jstring JNICALL Java_org_openslope_nativeplayer_MapLibrary_nativeAssetFiles(JNIEnv* env,jclass,jstring path) {
    try {const auto root=std::filesystem::path(string_value(env,path));auto files=openslope::referenced_images(openslope::Terrain::load(root));for(const auto& file:openslope::prop_files(root))if(file.starts_with("Meshes/"))files.push_back(file);for(const auto& file:openslope::skybox_files(root))if(file.starts_with("Skybox/Meshes/"))files.push_back(file);for(const auto& file:openslope::collision_files(root))files.push_back(file);const nlohmann::json names=files;return env->NewStringUTF(names.dump(-1,' ',true).c_str());}
    catch(const std::exception& e){java_error(env,e);return nullptr;}
}
extern "C" void android_main(android_app* app) {
    JNIEnv* environment=nullptr;
    if(app->activity->vm->AttachCurrentThread(&environment,nullptr)!=JNI_OK)return;
    try {
        while(!app->window&&!app->destroyRequested)process_events(app,100);
        if(!app->destroyRequested) {
            const auto type=environment->GetObjectClass(app->activity->clazz);
            const auto getter=environment->GetMethodID(type,"getMapPath","()Ljava/lang/String;");
            if(!getter)throw std::runtime_error("Course selection host is missing");
            const auto path=static_cast<jstring>(environment->CallObjectMethod(app->activity->clazz,getter));
            const auto mode_getter=environment->GetMethodID(type,"getRunMode","()Ljava/lang/String;");if(!mode_getter)throw std::runtime_error("Run mode host is missing");const auto mode_value=static_cast<jstring>(environment->CallObjectMethod(app->activity->clazz,mode_getter));const auto mode=openslope::run_mode(string_value(environment,mode_value));environment->DeleteLocalRef(mode_value);
            const auto root=std::filesystem::path(string_value(environment,path));environment->DeleteLocalRef(path);environment->DeleteLocalRef(type);
            openslope::Player player(openslope::Terrain::load(root));
            player.configure_run(mode);
            __android_log_print(ANDROID_LOG_INFO,"OpenSlopeNative","Run mode configured: %s; initial clock %s",openslope::run_name(mode),openslope::run_clock(player.course_run().status().clock).c_str());
            openslope::XrPlatform platform{app->activity->vm,app->activity->clazz,[&]{return process_events(app);}};
            openslope::run_openxr(player,platform);
        }
    }catch(const std::exception& e){__android_log_print(ANDROID_LOG_ERROR,"OpenSlope","%s",e.what());const auto type=environment->GetObjectClass(app->activity->clazz);const auto report=environment->GetMethodID(type,"reportError","(Ljava/lang/String;)V");if(report){const auto message=environment->NewStringUTF(e.what());environment->CallVoidMethod(app->activity->clazz,report,message);environment->DeleteLocalRef(message);}environment->DeleteLocalRef(type);}
    ANativeActivity_finish(app->activity);app->activity->vm->DetachCurrentThread();
}
