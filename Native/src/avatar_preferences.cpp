#include "openslope/avatar_preferences.hpp"
#include "openslope/audio_preferences.hpp"
#include "openslope/ride_ui.hpp"
#include <cctype>
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <random>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

namespace openslope {
std::filesystem::path AvatarPreferences::default_path() {
    const auto audio = AudioPreferences::default_path();
    return audio.empty() ? std::filesystem::path{} : audio.parent_path() / "avatar-preferences.json";
}

AvatarPreferences AvatarPreferences::load(const std::filesystem::path& file, std::string_view fallback) {
    AvatarPreferences result;
    result.selected = fallback;
    try {
        if (file.empty() || !std::filesystem::exists(file))
            return result;
        if (std::filesystem::file_size(file) > 4096)
            throw std::runtime_error("Avatar preferences exceed bounds");
        const auto json = nlohmann::json::parse(std::ifstream(file));
        if (json.value("schema", "") != "openslope-avatar-preferences/v1")
            throw std::runtime_error("Unknown avatar preferences");
        const auto id = json.at("avatar").get<std::string>();
        if (!id.empty() && id.size() <= 255)
            result.selected = id;
    } catch (const std::exception& error) {
        std::cerr << "Avatar preferences ignored: " << error.what() << '\n';
    }
    if (result.selected == "builtin:space-marine")
        result.selected = "builtin:alpine-exo";
    return result;
}

std::string AvatarPreferences::random_rider() {
    std::vector<std::string> pool;
    for (const auto& option : builtin_avatars())
        if (option.id != "builtin:stick-figure")
            pool.push_back(option.id);
    std::mt19937 random(std::random_device{}());
    return pool.at(std::uniform_int_distribution<std::size_t>(0, pool.size() - 1)(random));
}

bool AvatarPreferences::save(const std::filesystem::path& file) const {
    if (file.empty())
        return false;
    auto temporary = file;
    temporary += ".tmp-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    try {
        if (!file.parent_path().empty())
            std::filesystem::create_directories(file.parent_path());
        {
            std::ofstream out(temporary, std::ios::binary);
            out << nlohmann::json{{"schema", "openslope-avatar-preferences/v1"}, {"avatar", selected}}.dump(2) << '\n';
            out.flush();
            if (!out)
                throw std::runtime_error("Cannot write avatar preferences");
        }
#ifdef _WIN32
        if (!MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("Cannot replace avatar preferences");
#else
        std::filesystem::rename(temporary, file);
#endif
        return true;
    } catch (const std::exception& error) {
        std::error_code ignored;
        std::filesystem::remove(temporary, ignored);
        std::cerr << "Avatar preferences not saved: " << error.what() << '\n';
        return false;
    }
}

void AvatarPreferences::present(RideUi& ui, const std::filesystem::path& file) const {
    const auto builtins = builtin_avatars();
    ui.avatar_choices.assign(builtins.begin(), builtins.end());
    ui.avatar_selection = selected;
    if (file.empty())
        return;
    try {
        const auto root = file.parent_path() / "characters";
        if (!std::filesystem::is_directory(root))
            return;
        std::vector<AvatarOption> custom;
        for (const auto& entry : std::filesystem::directory_iterator(root)) {
            auto extension = entry.path().extension().string();
            std::transform(extension.begin(), extension.end(), extension.begin(),
                           [](unsigned char c) { return char(std::tolower(c)); });
            if (!entry.is_regular_file() || extension != ".glb" || entry.file_size() > 32 * 1024 * 1024)
                continue;
            const auto name = entry.path().filename().string();
            if (name.size() > 240 || custom.size() >= 128)
                continue;
            custom.push_back({name, entry.path().stem().string(), entry.path()});
        }
        std::sort(custom.begin(), custom.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
        ui.avatar_choices.insert(ui.avatar_choices.end(), custom.begin(), custom.end());
    } catch (const std::exception&) {
        ui.notice = "AVATAR LIBRARY COULD NOT BE READ";
    }
}

bool AvatarPreferences::apply(Avatar& avatar, const RideUi& ui) const {
    try {
        const auto option = std::find_if(ui.avatar_choices.begin(), ui.avatar_choices.end(),
                                         [&](const auto& value) { return value.id == selected; });
        if (option == ui.avatar_choices.end())
            throw std::runtime_error("Selected avatar is missing");
        if (option->file.empty())
            avatar = Avatar::builtin(option->id);
        else {
            const auto size = std::filesystem::file_size(option->file);
            if (size > 32 * 1024 * 1024)
                throw std::runtime_error("Avatar file exceeds bounds");
            std::vector<unsigned char> bytes(static_cast<std::size_t>(size));
            std::ifstream input(option->file, std::ios::binary);
            input.read(reinterpret_cast<char*>(bytes.data()), std::streamsize(bytes.size()));
            if (!input)
                throw std::runtime_error("Cannot read avatar file");
            avatar = Avatar(bytes);
        }
        return true;
    } catch (const std::exception& error) {
        std::cerr << "Avatar could not load: " << error.what() << '\n';
        return false;
    }
}

bool AvatarPreferences::handle(const UiResult& result, RideUi& ui, Avatar& avatar) {
    switch (result.action) {
    case UiAction::Avatars:
        ui.avatar_options = !ui.avatar_options;
        ui.avatar_page = 0;
        ui.controls = ui.library = ui.audio_options = ui.graphics_options = ui.rider_options = false;
        ui.notice.clear();
        return false;
    case UiAction::PreviousAvatarPage:
        if (ui.avatar_page)
            --ui.avatar_page;
        return false;
    case UiAction::NextAvatarPage:
        if ((ui.avatar_page + 1) * 5 < ui.avatar_choices.size())
            ++ui.avatar_page;
        return false;
    case UiAction::SelectAvatar: {
        if (result.value == selected) {
            ui.notice.clear();
            return true; // Explicitly choosing the platform default also remembers it.
        }
        AvatarPreferences next;
        next.selected = result.value;
        if (!next.apply(avatar, ui)) {
            ui.notice = "AVATAR UNAVAILABLE - CHOOSE ANOTHER";
            return false;
        }
        selected = next.selected;
        ui.avatar_selection = selected;
        ui.notice.clear();
        return true;
    }
    default: return false;
    }
}
} // namespace openslope
