#include "../src/import/ssx/formats.hpp"
#include "openslope/collision.hpp"
#include "openslope/props.hpp"
#include "openslope/world_logic.hpp"
#include <algorithm>
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

std::string bytes(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

Json read(const std::filesystem::path& path) { return Json::parse(bytes(path)); }

void fixture(const std::filesystem::path& root) {
    std::filesystem::create_directories(root);
    write(root, "Import.json", {{"Game", "ssx-3"}});
    write(root, "Models.json",
          {{"Models",
            Json::array(
                {{{"ModelName", "bounds"},
                  {"ModelObjects",
                   Json::array({{{"ParentID", -1},
                                 {"MeshData", Json::array()},
                                 {"CollisionBounds", {{"Min", {-100, -100, -100}}, {"Max", {100, 100, 100}}}}}})}}})}});
    Json rows = Json::array();
    for (const auto* name : {"reset_plane", "challenge_reset_plane", "fence_proxy", "fenceCollision_start", "ordinary",
                             "authored_recovery", "tinted", "bad-colours"}) {
        rows.push_back({{"InstanceName", name},
                        {"ModelID", 0},
                        {"Location", {rows.size() * 2000, 0, 0}},
                        {"Scale", {1, 1, 1}},
                        {"Rotation", {0, 0, 0, 1}},
                        {"Visable", true},
                        {"PlayerCollision", true},
                        {"CollsionMode", 2},
                        {"EffectSlotIndex", -1},
                        {"AmbentLightColour", {128, 128, 128, 128}},
                        {"VertexLighting", "EGEQYQ=="}});
    }
    rows[0]["EffectSlotIndex"] = 1;
    rows[0]["PlayerBounce"] = false;
    rows[0]["U0"] = 0;
    rows[4]["PlayerCollision"] = false;
    rows[5]["EffectSlotIndex"] = 0;
    rows[6]["AmbentLightColour"] = {96, 120, 200, 128};
    rows[7]["VertexLighting"] = "not base64";
    write(root, "Instances.json", {{"Instances", rows}});
    write(
        root, "Effects.json",
        {{"kind", "openslope-effects"},
         {"version", 1},
         {"graphs",
          Json::array(
              {{{"id", "authored-reset"},
                {"nodes", Json::array({{{"id", "real-reset"}, {"mainType", 13}, {"payload", Json::object()}}})}},
               {{"id", "openslope-playtest:reset"},
                {"nodes",
                 Json::array({{{"id", "old-guessed-reset"}, {"mainType", 13}, {"payload", Json::object()}}})}}})},
         {"functions", Json::array()},
         {"objectProperties", Json::array()},
         {"instances", Json::array()},
         {"splines", Json::array()},
         {"slots",
          Json::array({{{"id", "authored"}, {"originalIndex", 7}, {"circumstances", {{"collision", "authored-reset"}}}},
                       {{"id", "openslope-playtest:reset:slot"},
                        {"originalIndex", 1},
                        {"circumstances", {{"collision", "openslope-playtest:reset"}}}}})}});
    write(root, "Lights.json",
          {{"Lights", Json::array({{{"Type", 1}, {"OuterConeCosine", .75}},
                                   {{"Type", 1}, {"OuterConeCosine", .5}, {"UnknownFloat2", .6}},
                                   {{"Type", 2},
                                    {"LightName", "Halo 1"},
                                    {"UnknownFloat1", 0},
                                    {"Position", {1, 2, 3}},
                                    {"LowestXYZ", {0, 0, 0}},
                                    {"HighestXYZ", {5, 5, 5}}},
                                   {{"Type", 2}, {"LightName", "Point light"}, {"UnknownFloat1", 23}}})}});
    write(root, "Audio.json", {{"untouched", true}});
    write(root, "PlaytestImport.json", {{"Schema", "openslope-playtest-import/v1"}});
    std::filesystem::create_directories(root / "PlaytestBackup-v1");
    write(root / "PlaytestBackup-v1", "original.json", {{"preserved", true}});
}

void production(const std::filesystem::path& root) {
    fixture(root);
    auto old_logic = WorldLogic::load(root);
    check(old_logic.reset_volumes().size() == 1 && old_logic.reset_volumes()[0] == 5,
          "Old imported boxes are inert at runtime; authored reset still exists");
    old_logic.contact(0, 10);
    check(old_logic.take_actions().empty(), "Repeated contacts with old inferred boxes cannot reset the rider");
    const auto old_instances = bytes(root / "Instances.json"), old_effects = bytes(root / "Effects.json"),
               old_report = bytes(root / "PlaytestImport.json");
    const auto report = Json::parse(polish_streamed_map(root));
    const auto rows = read(root / "Instances.json").at("Instances");
    check(report.at("ResetZonesAdded") == 0 && report.at("ResetZonesRetired") == 1 && report.at("HelpersHidden") == 4,
          "Retire only the earlier inferred zone");
    check(report.at("LightsPatched") == 2 && report.at("LightingTints") == 6,
          "Packed lighting and light repairs reported");
    check(!rows[0].at("Visable") && !rows[0].at("PlayerCollision") && rows[0].at("EffectSlotIndex") == -1,
          "Old reset helper has no active collision or graph binding");
    check(rows[5].at("EffectSlotIndex") == 0 && rows[5].at("PlayerCollision"),
          "Preserve authored reset binding and contact");
    check(!rows[1].at("PlayerCollision") && rows[1].at("EffectSlotIndex") == -1, "Challenge helpers remain inactive");
    check(rows[2].at("PlayerCollision") && !rows[3].at("PlayerCollision") && !rows[4].at("PlayerCollision"),
          "Permanent fence proxies remain solid; event endpoints and authored disabled props stay disabled");
    check(rows[0].at("AmbentLightColour") == Json{256., 128., 384., 128} &&
              rows[6].at("AmbentLightColour") == Json{96, 120, 200, 128} &&
              rows[7].at("AmbentLightColour") == Json{128, 128, 128, 128},
          "Average tint preserves custom and malformed optional lighting");
    const auto lights = read(root / "Lights.json").at("Lights");
    check(lights[0].at("UnknownFloat2") == .75 && lights[1].at("UnknownFloat2") == .6 &&
              lights[2].at("UnknownFloat1") == 1 && lights[2].at("LowestXYZ") == lights[2].at("Position") &&
              lights[3].at("UnknownFloat1") == 23,
          "Shared cone/halo repair preserves authored lights");
    auto world = CollisionWorld::load(root);
    auto logic = WorldLogic::load(root);
    world.instance_flags(logic.flags());
    check(logic.reset_volumes().size() == 1 && logic.reset_volumes()[0] == 5,
          "Only authored reset volume participates after repair");
    check(!world.volume(0, {-2, 0, 0}, {2, 0, 0}).has_value(), "A guessed box at spawn cannot trigger contact");
    const std::array<ProbeSphere, 1> start{ProbeSphere{{-2, 0, 0}, .1}}, end{ProbeSphere{{2, 0, 0}, .1}};
    check(world.sweep(start, end).empty(), "Retired box no longer dispatches rider contacts");
    for (unsigned i = 0; i < 120; ++i)
        logic.contact(0, 10);
    check(logic.take_actions().empty(), "Repeated passage through former box causes no reset loop");
    logic.contact(5, 10);
    const auto actions = logic.take_actions();
    check(actions.size() == 1 && actions[0].kind == WorldActionKind::Reset,
          "Freeride contact still executes authored reset action");
    check(bytes(root / "PlaytestBackup-v4/Instances.json") == old_instances &&
              bytes(root / "PlaytestBackup-v4/Effects.json") == old_effects &&
              bytes(root / "PlaytestBackup-v4/PlaytestImport.json") == old_report &&
              read(root / "PlaytestBackup-v1/original.json").at("preserved"),
          "Upgrade preserves exact v1 documents and the original v1 backup");
    check(read(root / "Audio.json").at("untouched"), "Other map assets remain unchanged");
    const auto repaired = bytes(root / "Instances.json"), effects = bytes(root / "Effects.json"),
               saved_report = bytes(root / "PlaytestImport.json");
    check(polish_streamed_map(root).starts_with("Playtest polish already current") &&
              bytes(root / "Instances.json") == repaired && bytes(root / "Effects.json") == effects &&
              bytes(root / "PlaytestImport.json") == saved_report,
          "Rerun performs no writes or duplicate graph allocation");
}

void cancellation(const std::filesystem::path& root) {
    // Eight placements, four staged documents, four publications and final commit.
    for (unsigned stop = 1; stop <= 17; ++stop) {
        fixture(root);
        std::map<std::string, std::string> original;
        for (const auto* name :
             {"Instances.json", "Effects.json", "Lights.json", "Models.json", "Import.json", "PlaytestImport.json"})
            original.emplace(name, bytes(root / name));
        unsigned calls = 0;
        bool failed = false;
        try {
            polish_streamed_map(root, [&] { return ++calls == stop; });
        } catch (const std::runtime_error&) {
            failed = true;
        }
        check(failed, "Cancellation aborts before commit");
        for (const auto& [name, value] : original)
            check(bytes(root / name) == value, "Cancellation restores original document bytes");
        check(!std::filesystem::exists(root / "PlaytestBackup-v4") &&
                  std::filesystem::exists(root / "PlaytestBackup-v1/original.json") &&
                  !std::filesystem::exists(root / ".openslope-playtest-staging"),
              "Cancellation leaves no partial publication");
    }
}

void boundaries(const std::filesystem::path& root) {
    for (const auto* name : {"mdl_er4_impassableleft_17", "MDL_WR1_IMPASSABLERIGHT_1009", "mdl_vh1_impassableleft"})
        check(import_detail::ontour_boundary_helper(name), "Recognize complete boundary helper families");
    for (const auto* name :
         {"fence_proxy", "impassableleft", "mdl_er4_impassableleft_sign", "mdl_er4_impassableleft_",
          "mdl_er4_impassableleft_17_extra", "mdl_er44_impassableleft_17", "mdl_er4_impassableleftover_17"})
        check(!import_detail::ontour_boundary_helper(name), "Do not classify ordinary or partial name matches");
    for (const auto* name :
         {"mdl_er4_trg_fw_archlights", "mdl_er4_trg_fw_archlights_4_1001", "MDL_ER4_TRG_FW_START_1000",
          "mdl_er4_trg_fw_finish_1000", "mdl_er4_trg_fw_finish_final_9999"})
        check(import_detail::ontour_course_helper(name), "Recognize complete observed effect trigger families");
    for (const auto* name :
         {"mdl_er4_trg_fw_archlights_", "mdl_er4_trg_fw_archlights_4_", "mdl_er4_trg_fw_archlights__4",
          "mdl_er4_trg_fw_finish_sign", "mdl_er4_emt_fw_archlights_1_1001", "mdl_er4_trg_fw_finish_finale_1000"})
        check(!import_detail::ontour_course_helper(name), "Keep art and incomplete trigger names unchanged");
    fixture(root);
    write(root, "Import.json", {{"Game", "ssx-on-tour"}});
    write(root, "Materials.json", {{"Materials", Json::array()}});
    auto instances = read(root / "Instances.json");
    instances["Instances"][0]["InstanceName"] = "mdl_er4_impassableleft_17";
    instances["Instances"][0]["EffectSlotIndex"] = 0;
    instances["Instances"][4]["ModelID"] = 1;
    instances["Instances"][4]["PlayerCollision"] = true;
    write(root, "Instances.json", instances);
    auto models = read(root / "Models.json");
    auto helper = models["Models"][0];
    helper["ModelName"] = "mdl_er4_impassableright_30";
    models["Models"].push_back(helper);
    write(root, "Models.json", models);
    auto effects = read(root / "Effects.json");
    effects["objectProperties"] = Json::array({{{"id", "legacy"}, {"references", {{"effectSlot", "authored"}}}}});
    effects["instances"] = Json::array({{{"id", "instance:0"}, {"property", "legacy"}}});
    write(root, "Effects.json", effects);
    write(root, "PlaytestImport.json", {{"Schema", "openslope-playtest-import/v3"}});
    std::filesystem::create_directories(root / "PlaytestBackup-v2");
    write(root / "PlaytestBackup-v2", "original.json", {{"preserved", true}});
    const auto original = bytes(root / "Instances.json");
    auto world = CollisionWorld::load(root);
    auto logic = WorldLogic::load(root);
    world.instance_flags(logic.flags());
    check((logic.flags()[0] & (WorldDraw | WorldCollide)) == WorldCollide &&
              (logic.flags()[4] & (WorldDraw | WorldCollide)) == WorldCollide,
          "Native read repair hides both helper families while retaining contact gates");
    const std::array<ProbeSphere, 1> start{ProbeSphere{{-2, 0, 0}, .1}}, end{ProbeSphere{{2, 0, 0}, .1}};
    const auto contacts = world.sweep(start, end);
    check(!contacts.empty() &&
              std::all_of(contacts.begin(), contacts.end(), [](const auto& hit) { return !hit.response; }),
          "A former wall reports contacts without physical rider response");
    check(world.volume(0, {-2, 0, 0}, {2, 0, 0}).has_value(), "A helper retains its existing contact volume");
    check(world.volume(2, {38, 0, 0}, {42, 0, 0}).has_value(), "Permanent fences still have collision geometry");
    logic.contact(0, 10);
    check(!logic.take_actions().empty(), "A common authored collision effect still dispatches on the helper");
    const auto props = Props::load(root);
    check(!props.instances[0].visible && !props.instances[4].visible && props.instances[2].visible,
          "Native renderer hides boundary art while retaining ordinary fence art");
    check(bytes(root / "Instances.json") == original, "Read repair never changes saved map data");
    const auto report = Json::parse(polish_streamed_map(root));
    check(report.at("Schema") == "openslope-playtest-import/v4" && report.at("CourseHelpersPrepared") == 2,
          "Targeted repair reports both helpers");
    check(bytes(root / "PlaytestBackup-v4/Instances.json") == original &&
              read(root / "PlaytestBackup-v2/original.json").at("preserved"),
          "v4 upgrade preserves earlier backups");
    const auto repaired = read(root / "Instances.json");
    check(repaired["Instances"][0]["PlayerCollision"] && !repaired["Instances"][0]["Visable"] &&
              !repaired["Instances"][0]["PlayerBounce"] && repaired["Instances"][0]["U0"] == 0 &&
              repaired["Instances"][2]["PlayerCollision"],
          "Persisted repair leaves fence collision intact");
    check(polish_streamed_map(root).starts_with("Playtest polish already current"), "Boundary repair is idempotent");
    write(root, "Import.json", {{"Game", "ssx-3"}});
    auto other = instances["Instances"];
    check(import_detail::repair_ontour_helper_instances(root, other) == 0 && other == instances["Instances"],
          "Other source games keep their own collision and visibility");
    std::filesystem::remove(root / "Import.json");
    effects["target"] = {{"game", "ssx-on-tour"}};
    write(root, "Effects.json", effects);
    check(import_detail::repair_ontour_helper_instances(root, other) == 2,
          "A renamed legacy reference can establish its source game through Effects metadata");
    effects["target"] = nullptr;
    write(root, "Effects.json", effects);
    check(!import_detail::ontour_course_root(root), "Missing optional game metadata leaves an unrelated map unchanged");

    Json triggers = Json::array();
    for (const auto* label :
         {"mdl_er4_trg_fw_archlights_4_1001", "mdl_er4_trg_fw_finish_1000", "mdl_er4_trg_fw_start_1000"})
        triggers.push_back({{"InstanceName", label},
                            {"Visable", true},
                            {"PlayerCollision", true},
                            {"PlayerBounce", true},
                            {"U0", 1e30},
                            {"EffectSlotIndex", 7},
                            {"CollsionMode", 1},
                            {"CollsionModelPaths", {"retained.obj"}}});
    triggers[2]["CollsionMode"] = 0;
    check(import_detail::prepare_ontour_helpers(triggers, Json::array()) == 3, "Prepare all trigger variants");
    check(triggers[0]["PlayerCollision"] && !triggers[0]["PlayerBounce"] && triggers[0]["U0"] == 0 &&
              triggers[0]["EffectSlotIndex"] == 7 && triggers[0]["CollsionModelPaths"][0] == "retained.obj",
          "Keep source contact shape and common effect binding without solid response");
    check(!triggers[2]["PlayerCollision"] && triggers[2]["CollsionMode"] == 0,
          "A helper without an existing collision shape stays dormant");
}
} // namespace

int main() {
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-playtest-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    try {
        production(root / "production");
        cancellation(root / "cancel");
        boundaries(root / "boundaries");
        std::filesystem::remove_all(root);
        std::cout << "PASS: " << checks << " playtest recovery, lighting, preservation and transaction checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::filesystem::remove_all(root);
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
