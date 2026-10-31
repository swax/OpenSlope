#include "import/course_metadata.hpp"
#include "openslope/animation.hpp"
#include "openslope/appearance.hpp"
#include "openslope/audio_scene.hpp"
#include "openslope/avatar_preferences.hpp"
#include "openslope/collision.hpp"
#include "openslope/course_names.hpp"
#include "openslope/import.hpp"
#include "openslope/particles.hpp"
#include "openslope/paths.hpp"
#include "openslope/props.hpp"
#include "openslope/rails.hpp"
#include "openslope/ride_ui.hpp"
#include "openslope/world.hpp"
#include "openxr_app.hpp"
#include <algorithm>
#include <android/log.h>
#include <android_native_app_glue.h>
#include <cerrno>
#include <filesystem>
#include <list>
#include <mutex>
#include <nlohmann/json.hpp>
#include <sys/stat.h>
#include <unistd.h>

namespace {
bool process_events(android_app* app, int timeout = 0) {
    int events;
    android_poll_source* source = nullptr;
    while (ALooper_pollOnce(timeout, nullptr, &events, reinterpret_cast<void**>(&source)) >= 0) {
        if (source)
            source->process(app, source);
        if (app->destroyRequested)
            return false;
        timeout = 0;
    }
    return !app->destroyRequested;
}

std::string string_value(JNIEnv* env, jstring value) {
    if (!value)
        throw std::runtime_error("Missing Android document argument");
    const auto* chars = env->GetStringChars(value, nullptr);
    if (!chars)
        throw std::runtime_error("Cannot read Android string");
    const auto length = env->GetStringLength(value);
    std::string result;
    for (jsize i = 0; i < length; ++i) {
        std::uint32_t c = chars[i];
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < length) {
            const auto low = chars[++i];
            if (low < 0xdc00 || low > 0xdfff) {
                env->ReleaseStringChars(value, chars);
                throw std::runtime_error("Invalid Unicode document name");
            }
            c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        }
        if (c < 0x80)
            result.push_back(static_cast<char>(c));
        else if (c < 0x800) {
            result.push_back(static_cast<char>(0xc0 | (c >> 6)));
            result.push_back(static_cast<char>(0x80 | (c & 63)));
        } else if (c < 0x10000) {
            result.push_back(static_cast<char>(0xe0 | (c >> 12)));
            result.push_back(static_cast<char>(0x80 | ((c >> 6) & 63)));
            result.push_back(static_cast<char>(0x80 | (c & 63)));
        } else {
            result.push_back(static_cast<char>(0xf0 | (c >> 18)));
            result.push_back(static_cast<char>(0x80 | ((c >> 12) & 63)));
            result.push_back(static_cast<char>(0x80 | ((c >> 6) & 63)));
            result.push_back(static_cast<char>(0x80 | (c & 63)));
        }
    }
    env->ReleaseStringChars(value, chars);
    return result;
}

void java_error(JNIEnv* env, const std::exception& error) {
    if (env->ExceptionCheck())
        return;
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
}

openslope::DiscInput descriptor_input(jint descriptor, jlong length) {
    if (descriptor < 0 || length < 17 * 2048)
        throw std::runtime_error("The ISO descriptor is invalid");
    return {static_cast<std::uint64_t>(length), [descriptor](std::uint64_t offset, std::span<std::uint8_t> data) {
                std::size_t done = 0;
                while (done < data.size()) {
                    const auto count =
                        pread(descriptor, data.data() + done, data.size() - done, static_cast<off_t>(offset + done));
                    if (count < 0 && errno == EINTR)
                        continue;
                    if (count <= 0)
                        throw std::runtime_error("Cannot read ISO. Select a seekable file on local headset storage.");
                    done += static_cast<std::size_t>(count);
                }
            }};
}

struct ImportDiscEntry {
    std::string key;
    std::shared_ptr<openslope::ImportSession> session;
};

std::mutex import_disc_mutex;
std::list<ImportDiscEntry> import_discs;

std::shared_ptr<openslope::ImportSession> descriptor_session(JNIEnv* env, jobject activity, jint descriptor,
                                                             jlong length) {
    const auto activity_type = env->GetObjectClass(activity);
    const auto files_method = env->GetMethodID(activity_type, "getFilesDir", "()Ljava/io/File;");
    const auto directory = env->CallObjectMethod(activity, files_method);
    const auto file_type = env->GetObjectClass(directory);
    const auto path_method = env->GetMethodID(file_type, "getAbsolutePath", "()Ljava/lang/String;");
    const auto text = static_cast<jstring>(env->CallObjectMethod(directory, path_method));
    const auto cache = std::filesystem::path(string_value(env, text)) / "import-cache" / "music-v1";
    env->DeleteLocalRef(text);
    env->DeleteLocalRef(file_type);
    env->DeleteLocalRef(directory);
    env->DeleteLocalRef(activity_type);
    struct stat info{};
    if (fstat(descriptor, &info))
        throw std::runtime_error("Cannot inspect ISO descriptor");
    const auto key = std::to_string(info.st_dev) + ":" + std::to_string(info.st_ino) + ":" +
                     std::to_string(info.st_size) + ":" + std::to_string(info.st_mtim.tv_sec) + ":" +
                     std::to_string(info.st_mtim.tv_nsec) + ":" + std::to_string(length) + ":" + cache.string();
    std::lock_guard lock(import_disc_mutex);
    if (info.st_ino) {
        const auto found =
            std::find_if(import_discs.begin(), import_discs.end(), [&](const auto& entry) { return entry.key == key; });
        if (found != import_discs.end()) {
            const auto result = found->session;
            import_discs.splice(import_discs.begin(), import_discs, found);
            return result;
        }
    }
    const auto duplicate = dup(descriptor);
    if (duplicate < 0)
        throw std::runtime_error("Cannot retain ISO descriptor");
    const auto owner = std::shared_ptr<int>(new int(duplicate), [](int* fd) {
        close(*fd);
        delete fd;
    });
    auto source = descriptor_input(duplicate, length);
    const auto read = source.read_at;
    source.read_at = [read, owner](std::uint64_t offset, std::span<std::uint8_t> bytes) { read(offset, bytes); };
    auto result = std::make_shared<openslope::ImportSession>(source, cache);
    if (info.st_ino) {
        import_discs.push_front({key, result});
        while (import_discs.size() > 2)
            import_discs.pop_back();
    }
    return result;
}

struct Callbacks {
    JNIEnv* env;
    jobject activity;
    jmethodID cancelled, progress;

    Callbacks(JNIEnv* e, jobject a) : env(e), activity(a) {
        const auto type = env->GetObjectClass(activity);
        cancelled = env->GetMethodID(type, "isImportCancelled", "()Z");
        progress = env->GetMethodID(type, "onImportProgress", "(Ljava/lang/String;)V");
        env->DeleteLocalRef(type);
        if (!cancelled || !progress)
            throw std::runtime_error("Import host callbacks are missing");
    }

    bool stop() const { return env->ExceptionCheck() || env->CallBooleanMethod(activity, cancelled); }

    void notify(const std::string& text) const {
        const auto value = env->NewStringUTF(text.c_str());
        env->CallVoidMethod(activity, progress, value);
        env->DeleteLocalRef(value);
    }
};
} // namespace

extern "C" JNIEXPORT jstring JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeAvatars(JNIEnv* env,
                                                                                                    jobject,
                                                                                                    jstring file) {
    try {
        const auto path = std::filesystem::path(string_value(env, file));
        auto preferences = openslope::AvatarPreferences::load(path);
        openslope::RideUi ui;
        preferences.present(ui, path);
        if (std::none_of(ui.avatar_choices.begin(), ui.avatar_choices.end(),
                         [&](const auto& option) { return option.id == preferences.selected; }))
            preferences.selected = "builtin:stick-figure";
        nlohmann::json options = nlohmann::json::array();
        for (const auto& option : ui.avatar_choices)
            options.push_back({{"id", option.id}, {"label", option.label}});
        const auto result = nlohmann::json{{"selected", preferences.selected}, {"options", options}}.dump(
            -1, ' ', false, nlohmann::json::error_handler_t::replace);
        return env->NewStringUTF(result.c_str());
    } catch (const std::exception& error) {
        java_error(env, error);
        return nullptr;
    }
}

extern "C" JNIEXPORT void JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeChooseAvatar(JNIEnv* env,
                                                                                                      jobject,
                                                                                                      jstring file,
                                                                                                      jstring id) {
    try {
        const auto path = std::filesystem::path(string_value(env, file));
        openslope::AvatarPreferences preferences;
        preferences.selected = string_value(env, id);
        openslope::RideUi ui;
        preferences.present(ui, path);
        openslope::Avatar avatar;
        if (!preferences.apply(avatar, ui))
            throw std::runtime_error("This avatar could not load. Choose a Slopesmith character GLB.");
        if (!preferences.save(path))
            throw std::runtime_error("The avatar selection could not be saved.");
    } catch (const std::exception& error) {
        java_error(env, error);
    }
}

extern "C" JNIEXPORT void JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeValidateAvatar(JNIEnv* env,
                                                                                                        jobject,
                                                                                                        jstring file) {
    try {
        openslope::AvatarPreferences preferences;
        const auto path = std::filesystem::path(string_value(env, file));
        preferences.selected = "import.glb";
        openslope::RideUi ui;
        ui.avatar_choices.push_back({preferences.selected, "Import", path});
        openslope::Avatar avatar;
        if (!preferences.apply(avatar, ui))
            throw std::runtime_error("This GLB does not use the Slopesmith character contract.");
    } catch (const std::exception& error) {
        java_error(env, error);
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_org_openslope_nativeplayer_LauncherActivity_nativeCourseDisplayName(JNIEnv* env, jclass, jstring name) {
    try {
        const auto id = string_value(env, name);
        const auto label = openslope::course_display_name(id);
        // Preserve the original UTF-16 for custom names, including supplementary characters.
        return label == id ? name : env->NewStringUTF(label.c_str());
    } catch (const std::exception& e) {
        java_error(env, e);
        return nullptr;
    }
}

extern "C" JNIEXPORT jstring JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeMapGame(
    JNIEnv* env, jclass, jstring name, jstring origin, jstring imported, jboolean authored) {
    try {
        const auto game = openslope::map_game_from_metadata(string_value(env, name), string_value(env, origin),
                                                            string_value(env, imported), authored);
        return env->NewStringUTF(game.c_str());
    } catch (const std::exception& error) {
        java_error(env, error);
        return nullptr;
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_org_openslope_nativeplayer_LauncherActivity_nativeGameDisplayName(JNIEnv* env, jclass, jstring game) {
    try {
        const auto label = openslope::game_display_name(string_value(env, game));
        return env->NewStringUTF(label.c_str());
    } catch (const std::exception& error) {
        java_error(env, error);
        return nullptr;
    }
}

extern "C" JNIEXPORT jstring JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeCourses(JNIEnv* env,
                                                                                                    jobject activity,
                                                                                                    jint descriptor,
                                                                                                    jlong length) {
    try {
        Callbacks callbacks(env, activity);
        nlohmann::json names = nlohmann::json::array();
        for (const auto& course :
             descriptor_session(env, activity, descriptor, length)->courses([&] { return callbacks.stop(); })) {
            auto row = openslope::import_detail::course_metadata(course);
            row["DisplayName"] = course.display_name;
            row["Game"] = openslope::course_game(course.name);
            names.push_back(row);
        }
        return env->NewStringUTF(names.dump(-1, ' ', true).c_str());
    } catch (const std::exception& e) {
        java_error(env, e);
        return nullptr;
    }
}

extern "C" JNIEXPORT void JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeExtract(
    JNIEnv* env, jobject activity, jint descriptor, jlong length, jstring course, jstring output) {
    try {
        Callbacks callbacks(env, activity);
        descriptor_session(env, activity, descriptor, length)
            ->extract(
                string_value(env, course), string_value(env, output),
                [&](const auto& message) { callbacks.notify(message); }, [&] { return callbacks.stop(); });
    } catch (const std::exception& e) {
        java_error(env, e);
    }
}

extern "C" JNIEXPORT void JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeCloseImportSessions(JNIEnv*,
                                                                                                             jobject) {
    std::lock_guard lock(import_disc_mutex);
    import_discs.clear();
}

extern "C" JNIEXPORT void JNICALL Java_org_openslope_nativeplayer_LauncherActivity_nativeValidate(JNIEnv* env, jobject,
                                                                                                  jstring path) {
    try {
        const auto root = std::filesystem::path(string_value(env, path));
        if (std::filesystem::file_size(root / "Patches.json") > 64 * 1024 * 1024)
            throw std::runtime_error("Map terrain exceeds the loading limit");
        static_cast<void>(openslope::Appearance::load(openslope::Terrain::load(root)));
        static_cast<void>(openslope::Props::load(root));
        static_cast<void>(openslope::World::load(root));
        static_cast<void>(openslope::PoseAnimation::get_up(root));
        static_cast<void>(openslope::Rails::load(root));
        static_cast<void>(openslope::CoursePaths::load(root));
        static_cast<void>(openslope::CourseRun::load(root, openslope::RunMode::Showoff));
        static_cast<void>(openslope::CollisionWorld::load(root));
        static_cast<void>(openslope::WorldLogic::load(root));
        static_cast<void>(openslope::AudioScene(root));
    } catch (const std::exception& e) {
        java_error(env, e);
    }
}

extern "C" JNIEXPORT jstring JNICALL Java_org_openslope_nativeplayer_MapLibrary_nativeAssetFiles(JNIEnv* env, jclass,
                                                                                                 jstring path) {
    try {
        const auto root = std::filesystem::path(string_value(env, path));
        auto files = openslope::referenced_images(openslope::Terrain::load(root));
        for (const auto& name : openslope::particle_textures(root, true))
            if (!name.empty())
                files.push_back("Textures/" + name);
        for (const auto& file : openslope::prop_files(root))
            if (file.starts_with("Meshes/"))
                files.push_back(file);
        for (const auto& file : openslope::skybox_files(root))
            if (file.starts_with("Skybox/Meshes/"))
                files.push_back(file);
        for (const auto& file : openslope::collision_files(root))
            files.push_back(file);
        std::sort(files.begin(), files.end());
        files.erase(std::unique(files.begin(), files.end()), files.end());
        const nlohmann::json names = files;
        return env->NewStringUTF(names.dump(-1, ' ', true).c_str());
    } catch (const std::exception& e) {
        java_error(env, e);
        return nullptr;
    }
}

extern "C" void android_main(android_app* app) {
    JNIEnv* environment = nullptr;
    if (app->activity->vm->AttachCurrentThread(&environment, nullptr) != JNI_OK)
        return;
    try {
        while (!app->window && !app->destroyRequested)
            process_events(app, 100);
        if (!app->destroyRequested) {
            const auto type = environment->GetObjectClass(app->activity->clazz);
            const auto getter = environment->GetMethodID(type, "getMapPath", "()Ljava/lang/String;");
            if (!getter)
                throw std::runtime_error("Course selection host is missing");
            const auto path = static_cast<jstring>(environment->CallObjectMethod(app->activity->clazz, getter));
            const auto mode_getter = environment->GetMethodID(type, "getRunMode", "()Ljava/lang/String;");
            if (!mode_getter)
                throw std::runtime_error("Run mode host is missing");
            const auto mode_value =
                static_cast<jstring>(environment->CallObjectMethod(app->activity->clazz, mode_getter));
            const auto mode = openslope::run_mode(string_value(environment, mode_value));
            environment->DeleteLocalRef(mode_value);
            const auto scale_getter = environment->GetMethodID(type, "getRenderScale", "()D"),
                       samples_getter = environment->GetMethodID(type, "getMsaa", "()I"),
                       refresh_getter = environment->GetMethodID(type, "getTargetRefreshRate", "()D");
            if (!scale_getter || !samples_getter || !refresh_getter)
                throw std::runtime_error("VR quality host is missing");
            const auto scale = environment->CallDoubleMethod(app->activity->clazz, scale_getter);
            const auto samples = environment->CallIntMethod(app->activity->clazz, samples_getter);
            const auto refresh = environment->CallDoubleMethod(app->activity->clazz, refresh_getter);
            const auto root = std::filesystem::path(string_value(environment, path));
            environment->DeleteLocalRef(path);
            environment->DeleteLocalRef(type);
            openslope::Player player(openslope::Terrain::load(root));
            player.configure_run(mode);
            __android_log_print(ANDROID_LOG_INFO, "OpenSlopeNative", "Run mode configured: %s; initial clock %s",
                                openslope::run_name(mode),
                                openslope::run_clock(player.course_run().status().clock).c_str());
            openslope::XrPlatform platform{app->activity->vm, app->activity->clazz,
                                           [&] { return process_events(app); }};
            platform.render_scale = scale;
            platform.target_refresh_rate = refresh;
            platform.msaa = unsigned(samples);
            platform.audio_preferences =
                std::filesystem::path(app->activity->internalDataPath) / "audio-preferences.json";
            const auto game_type = environment->GetObjectClass(app->activity->clazz);
            const auto name_getter = environment->GetMethodID(game_type, "getMapName", "()Ljava/lang/String;");
            if (!name_getter)
                throw std::runtime_error("Course identity host is missing");
            const auto map_name =
                static_cast<jstring>(environment->CallObjectMethod(app->activity->clazz, name_getter));
            platform.course_id = string_value(environment, map_name);
            environment->DeleteLocalRef(map_name);
            platform.is_resumed = [&] { return app->activityState == APP_CMD_RESUME && app->window; };
            const auto exit_getter = environment->GetMethodID(game_type, "getExitRequest", "()I");
            const auto destination_setter = environment->GetMethodID(game_type, "setReturnToMaps", "(Z)V");
            if (!exit_getter || !destination_setter)
                throw std::runtime_error("VR lifecycle host is missing");
            platform.exit_request = [&] {
                const auto request = environment->CallIntMethod(app->activity->clazz, exit_getter);
                return request == 2   ? openslope::XrExitDestination::Maps
                       : request == 1 ? openslope::XrExitDestination::App
                                      : openslope::XrExitDestination::System;
            };
            platform.on_exit = [&](openslope::XrExitDestination destination) {
                environment->CallVoidMethod(app->activity->clazz, destination_setter,
                                            destination == openslope::XrExitDestination::Maps ? JNI_TRUE : JNI_FALSE);
            };
            openslope::run_openxr(player, platform);
            environment->DeleteLocalRef(game_type);
            __android_log_print(ANDROID_LOG_INFO, "OpenSlopeNative", "VR native resources released");
        }
    } catch (const std::exception& e) {
        __android_log_print(ANDROID_LOG_ERROR, "OpenSlope", "%s", e.what());
        const auto type = environment->GetObjectClass(app->activity->clazz);
        const auto report = environment->GetMethodID(type, "reportError", "(Ljava/lang/String;)V");
        if (report) {
            const auto message = environment->NewStringUTF(e.what());
            environment->CallVoidMethod(app->activity->clazz, report, message);
            environment->DeleteLocalRef(message);
        }
        environment->DeleteLocalRef(type);
    }
    ANativeActivity_finish(app->activity);
    // Android waits for input/window teardown acknowledgements before Destroy.
    // Keep the glue event thread alive until that final command arrives.
    while (!app->destroyRequested)
        process_events(app, 100);
    app->activity->vm->DetachCurrentThread();
}
