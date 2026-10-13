#include "openxr_app.hpp"
#include <android/log.h>
#include <android_native_app_glue.h>
#include <filesystem>

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
}
extern "C" void android_main(android_app* app) {
    JNIEnv* environment=nullptr;
    if(app->activity->vm->AttachCurrentThread(&environment,nullptr)!=JNI_OK)return;
    try {
        while(!app->window&&!app->destroyRequested)process_events(app,100);
        if(!app->destroyRequested) {
            const auto root=std::filesystem::path(app->activity->externalDataPath?app->activity->externalDataPath:app->activity->internalDataPath)/"course";
            openslope::Player player(std::filesystem::exists(root/"Patches.json")?openslope::Terrain::load(root):openslope::Terrain::demo());
            openslope::XrPlatform platform{app->activity->vm,app->activity->clazz,[&]{return process_events(app);}};
            openslope::run_openxr(player,platform);
        }
    }catch(const std::exception& e){__android_log_print(ANDROID_LOG_ERROR,"OpenSlope","%s",e.what());}
    ANativeActivity_finish(app->activity);app->activity->vm->DetachCurrentThread();
}
