#include "import/ssx/formats.hpp"
#include <nlohmann/json.hpp>

namespace openslope::import_detail {
using Json = nlohmann::json;

// Recovered data and application playback policy are deliberately separate.
// These graphs are inspectable even when no source behavior is bound.
// [Trailmap: 551-port]
std::string streamed_motion_graph(Json& effects, unsigned index, const Json& model, bool recovered) {
    const auto id = "streamed-motion:" + std::to_string(index);
    for (const auto& graph : effects.at("graphs"))
        if (graph.at("id") == id)
            return id;
    Json provenance = {{"adapter", "model-animation"},
                       {"clip", recovered ? "decoded" : "authored-fallback"},
                       {"playback", "adapted-loop"},
                       {"model", index},
                       {"sourceGame", effects.value("target", Json::object()).value("game", "unknown")}};
    Json node = {{"id", id + ":0"},
                 {"mainType", 0},
                 {"semanticType", "property.anim-object"},
                 {"references", Json::object()},
                 {"extensions", {{"sourceEffect", provenance}}},
                 {"payload",
                  {{"type0",
                    {{"SubType", 256},
                     {"type0Sub256",
                      {{"U0", 1}, {"U1", -1}, {"U2", -1}, {"U3", 30}, {"U4", 0}, {"U5", 1}, {"U6", 0}, {"U7", 3}}}}}}}};
    effects["graphs"].push_back({{"id", id},
                                 {"name", model.value("ModelName", "Model " + std::to_string(index)) + " motion"},
                                 {"nodes", Json::array({node})},
                                 {"extensions", {{"sourceEffect", provenance}}}});
    return id;
}

void streamed_model_effects(const Json& models, Json& effects, const ImportCancel& cancel) {
    unsigned clips = 0, objects = 0;
    for (std::size_t index = 0; index < models.size(); ++index) {
        check_cancel(cancel);
        if (models[index].value("AnimTime", 0.) <= 0)
            continue; // A recovered zero-length pose has no playback clock.
        unsigned animated = 0;
        for (const auto& object : models[index].at("ModelObjects"))
            if (object.value("IncludeAnimation", false) && object.contains("Animation") &&
                object.at("Animation").value("AnimationAction", 0u))
                ++animated;
        if (!animated)
            continue;
        streamed_motion_graph(effects, unsigned(index), models[index], true);
        ++clips;
        objects += animated;
    }
    effects["extensions"]["streamedModelMotion"] = {
        {"Models", clips}, {"Objects", objects}, {"UnboundByDefault", true}, {"Playback", "AdaptedLoop"}};
}

// Compose common graph attachments without mutating a shared source slot or
// dropping its other circumstances. Further source adapters use the same path.
int streamed_effect_binding(Json& effects, int base, const std::string& id, const Json& attachments) {
    auto& slots = effects.at("slots");
    if (slots.size() >= 4096 || base < -1 || (base >= 0 && std::size_t(base) >= slots.size()))
        throw std::runtime_error("Invalid streamed effect slot");
    Json slot = base < 0 ? Json{{"circumstances",
                                 {{"persistent", nullptr},
                                  {"collision", nullptr},
                                  {"slot3", nullptr},
                                  {"slot4", nullptr},
                                  {"trigger", nullptr},
                                  {"slot6", nullptr},
                                  {"slot7", nullptr}}}}
                         : slots.at(base);
    const auto graph = [&](const std::string& graph_id) -> Json {
        for (const auto& row : effects.at("graphs"))
            if (row.at("id") == graph_id)
                return row;
        throw std::runtime_error("Missing streamed effect graph");
    };
    for (const auto& [circumstance, addition] : attachments.items()) {
        const auto added = graph(addition.get<std::string>());
        auto& current = slot.at("circumstances").at(circumstance);
        if (current.is_null() || current == addition) {
            current = addition;
            continue;
        }
        const auto previous = graph(current.get<std::string>());
        const auto combined_id = id + ":" + circumstance;
        Json nodes = previous.at("nodes");
        for (const auto& node : added.at("nodes"))
            nodes.push_back(node);
        for (std::size_t i = 0; i < nodes.size(); ++i)
            nodes[i]["id"] = combined_id + ":" + std::to_string(i);
        effects["graphs"].push_back(
            {{"id", combined_id},
             {"name", previous.value("name", "Imported effects") + " + " + added.value("name", "adapted effects")},
             {"nodes", std::move(nodes)}});
        current = combined_id;
    }
    const auto result = int(slots.size());
    slot["id"] = id + ":slot";
    slot["originalIndex"] = result;
    slots.push_back(std::move(slot));
    return result;
}
} // namespace openslope::import_detail
