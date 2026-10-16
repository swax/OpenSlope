#include "openslope/world_logic.hpp"
#include "import_internal.hpp"
#include "openslope/collision.hpp"
#include "openslope/fence.hpp"
#include "openslope/material_animation.hpp"
#include "openslope/mesh_throw.hpp"
#include "openslope/props.hpp"
#include "openslope/rigid_prop.hpp"
#include "openslope/texture_playback.hpp"
#include "prop_internal.hpp"
#include <bit>
#include <deque>
#include <fstream>
#include <map>
#include <nlohmann/json.hpp>
#include <random>
#include <set>
#include <stdexcept>

namespace openslope {
namespace {
using Json = nlohmann::json;
constexpr auto none = std::size_t(-1);

Json read(const std::filesystem::path& root, const char* name) {
    const auto base = std::filesystem::weakly_canonical(root), path = std::filesystem::weakly_canonical(root / name),
               relative = path.lexically_relative(base);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == ".." ||
        std::filesystem::file_size(path) > 64 * 1024 * 1024)
        throw std::runtime_error("Invalid world logic asset");
    std::ifstream file(path);
    return Json::parse(file);
}

std::string id(const char* prefix, std::size_t index) { return std::string(prefix) + std::to_string(index); }

void restore_throw_direction(Json& payload, const Json& words, bool legacy_words);

Json legacy(const Json& source) {
    Json doc = {{"graphs", Json::array()},    {"functions", Json::array()},        {"slots", Json::array()},
                {"instances", Json::array()}, {"objectProperties", Json::array()}, {"splines", Json::array()}};
    for (const auto& [key, target] : {std::pair{"EffectHeaders", "graphs"}, std::pair{"Functions", "functions"}})
        if (source.contains(key))
            for (std::size_t i = 0; i < source.at(key).size(); ++i) {
                const auto& row = source.at(key)[i];
                Json nodes = Json::array();
                for (const auto& raw : row.at("Effects")) {
                    auto payload = raw;
                    payload.erase("MainType");
                    Json refs = Json::object();
                    const auto main = raw.at("MainType").get<int>();
                    if (main == 7 && raw.contains("Instance")) {
                        refs["instance"] = id("instance:", raw.at("Instance").at("InstanceIndex"));
                        refs["effectGraph"] = id("graph:", raw.at("Instance").at("EffectIndex"));
                    }
                    if (main == 21 || main == 26)
                        refs["function"] = id("function:", raw.at("FunctionRunIndex"));
                    if (main == 24)
                        refs["instance"] = id("instance:", raw.at("TeleportInstanceIndex"));
                    if (main == 2 && raw.contains("type2") && raw.at("type2").value("SubType", 0) == 1)
                        refs["spline"] = id("spline:", raw.at("type2").at("SplineAnimation").at("SplineIndex"));
                    if (main == 25)
                        refs["spline"] = id("spline:", raw.at("Spline").at("SplineIndex"));
                    if (main == 0)
                        restore_throw_direction(payload, Json::array(), true);
                    nodes.push_back({{"mainType", main}, {"payload", payload}, {"references", refs}});
                }
                doc[target].push_back(
                    {{"id", id(std::string(target) == "graphs" ? "graph:" : "function:", i)},
                     {"name", row.value(std::string(target) == "graphs" ? "EffectName" : "FunctionName", "")},
                     {"nodes", nodes}});
            }
    const std::array<const char*, 7> columns{
        "PersistantEffectSlot", "CollisionEffectSlot", "Slot3", "Slot4", "EffectTriggerSlot", "Slot6", "Slot7"},
        names{"persistent", "collision", "slot3", "slot4", "trigger", "slot6", "slot7"};
    if (source.contains("EffectSlots"))
        for (std::size_t i = 0; i < source.at("EffectSlots").size(); ++i) {
            Json circumstances;
            for (unsigned c = 0; c < 7; ++c) {
                const auto index = source.at("EffectSlots")[i].value(columns[c], -1);
                circumstances[names[c]] = index < 0 ? Json(nullptr) : Json(id("graph:", std::size_t(index)));
            }
            doc["slots"].push_back({{"id", id("slot:", i)}, {"originalIndex", i}, {"circumstances", circumstances}});
        }
    return doc;
}

double number(const Json& value, const char* key, double fallback = 0) {
    const auto v = value.value(key, fallback);
    if (!std::isfinite(v) || std::abs(v) > 1e9)
        throw std::runtime_error("Invalid world node number");
    return v;
}

void restore_throw_direction(Json& payload, const Json& words, bool legacy_words) {
    if (!payload.contains("type0") || payload.at("type0").value("SubType", -1) != 20)
        return;
    auto& fields = payload["type0"]["type0Sub20"];
    for (unsigned i = 3; i <= 5; ++i) {
        auto& value = fields["U" + std::to_string(i)];
        if (!value.is_number_integer())
            continue;
        // Older saved documents exposed these three float words as integers.
        // Prefer the preserved packet; explicit authored numeric directions stay numeric.
        if (words.size() >= 13)
            value = std::bit_cast<float>(words[i + 3].get<std::uint32_t>());
        else if (legacy_words || std::abs(value.get<double>()) > 1e6)
            value = std::bit_cast<float>(value.get<std::int32_t>());
        if (!value.is_number() || !std::isfinite(value.get<double>()))
            throw std::runtime_error("Invalid saved mesh throw direction");
    }
}
} // namespace

struct WorldLogic::Data {
    struct Node {
        int main = 0;
        Json payload, refs;
        std::optional<ParticleLaw> emitter{};
    };

    struct Chain {
        std::string name;
        std::vector<Node> nodes;
    };

    struct Slot {
        std::array<std::size_t, 7> chains{none, none, none, none, none, none, none};
    };

    struct Host {
        std::size_t slot = none;
        Vec3 position;
        bool showoff = false;
        std::size_t model = none;
        bool mode_hidden = false, kill_movers = false;
        Transform inverse = identity_transform();
        Vec3 impact{};
        std::optional<ParticleContact> contact{};
    };

    struct Property {
        struct Roller {
            double mass = 0;
            Vec3 launch;
        };

        int kind = -1, mode = 0;
        double time = 0;
        std::optional<PropPlayback> animation{};
        std::optional<PropChecklist> checklist{};
        std::optional<FragileProp> fragile{};
        std::optional<MeshThrow> pieces{};
        std::optional<Roller> roller{};
        std::unique_ptr<RigidProp> body{};
        std::optional<ScrollPlayback> scroll{};
        std::optional<FlagPlayback> flag{};
        std::optional<FencePlayback> fence{};
        std::unique_ptr<TexturePlayback> flip{};
        std::unique_ptr<ScriptedBoost> force{};
        std::optional<std::array<unsigned, 2>> crowd{};
        bool paused = false;
        double debounce = 0;
        bool end_requested = false;
    };

    struct Thread {
        std::size_t chain = none, instance = none, pc = 0;
        double wait = 0;
        bool rider = false, human = false, collision = false, setup = false;
        std::vector<std::pair<std::size_t, std::size_t>> ancestry;
        Vec3 impact{};
        std::optional<ParticleContact> contact{};
        std::size_t interaction = none;
        std::uint64_t actor = 0;
    };

    std::vector<Chain> chains;
    std::map<std::uint64_t, double> rider_speeds;
    std::vector<Slot> slots;
    std::vector<Host> hosts;
    std::vector<Property> properties;
    std::vector<std::uint8_t> initial, flags;
    std::vector<bool> busy;

    struct Mover {
        std::size_t path = 0, draw = 0;
        RoutePlayback playback;
        std::vector<double> samples{};
        double direction = 1;
    };

    std::vector<RailSpline> paths;
    std::map<std::size_t, std::shared_ptr<PropRoute>> route_math;
    std::map<std::size_t, Mover> movers;
    std::vector<PropRouteMotion> route_draws;
    std::vector<bool> host_active;
    std::vector<std::set<std::size_t>> model_materials;
    std::vector<std::vector<std::size_t>> draw_materials;
    CrowdPlayback crowd_clock;
    std::vector<std::vector<std::size_t>> fragile_targets;
    std::set<std::size_t> frame_owners;
    bool fragile_possible = false;
    std::set<std::size_t> force_hosts, collected_pads;
    std::map<std::size_t, std::set<std::uint64_t>> force_wait_exit;
    std::set<std::size_t> body_hosts;
    std::vector<bool> pad_instances;
    std::vector<std::size_t> flag_models;
    std::vector<PropTextureFrame> texture_states;
    std::map<std::size_t, PropTextureFrame> material_states;
    std::vector<unsigned> material_counts;
    bool materials_dirty = false;
    PropClips clips;
    std::map<std::size_t, std::vector<Vec3>> throw_centres;
    std::vector<PropMotion> motions;
    std::vector<std::size_t> motion_ids;
    std::vector<double> cooldowns;
    double clock = 0;
    std::vector<double> reset_due;
    std::map<std::size_t, double> interaction_due, rail_reset_due;
    std::map<std::size_t, bool> mode_rails;
    std::vector<bool> reward_marks;
    std::set<std::size_t> collected_rewards;
    std::vector<std::size_t> faceted_models, reset_volumes;

    struct Region {
        std::vector<std::size_t> hosts;
        bool active = false;
        unsigned absent = 0;
    };

    std::map<std::array<int, 3>, Region> regions;
    std::map<std::string, std::size_t> graphs, functions, slot_ids, instance_ids, spline_ids, entries;
    std::deque<Thread> ready, waiting;
    std::vector<WorldAction> actions;
    WorldParticles particles;
    std::set<std::size_t> particle_hosts;
    std::size_t unknown = 0;
    unsigned budget = 4096;
    RunMode mode = RunMode::Freeride;
    std::mt19937 random{0x4f534c50};

    std::size_t ref(const Json& refs, const char* key, const std::map<std::string, std::size_t>& table) const {
        if (!refs.contains(key) || refs.at(key).is_null())
            return none;
        const auto found = table.find(refs.at(key).get<std::string>());
        return found == table.end() ? none : found->second;
    }

    void enqueue(std::size_t chain, std::size_t instance, bool rider, bool human, bool collision = false,
                 std::vector<std::pair<std::size_t, std::size_t>> ancestry = {}, bool setup = false, Vec3 impact = {},
                 std::optional<ParticleContact> contact = {}, std::size_t interaction = none, std::uint64_t actor = 0) {
        if (chain >= chains.size() || ready.size() + waiting.size() >= 1024 || ancestry.size() >= 32 ||
            std::find(ancestry.begin(), ancestry.end(), std::pair{chain, instance}) != ancestry.end())
            return;
        ancestry.push_back({chain, instance});
        ready.push_back({chain, instance, 0, 0, rider, human, collision, setup, std::move(ancestry), impact, contact,
                         interaction, actor});
        if (collision)
            busy.at(instance) = true;
    }

    void restore(std::size_t host) {
        flags[host] = hosts[host].showoff && mode != RunMode::Showoff ? 0 : initial[host];
    }

    void erase_motion(std::size_t host) {
        const auto index = motion_ids[host];
        if (index == none)
            return;
        if (index + 1 < motions.size()) {
            motions[index] = std::move(motions.back());
            motion_ids[motions[index].instance] = index;
        }
        motions.pop_back();
        motion_ids[host] = none;
    }

    void update_motion(std::size_t host, bool snap = false) {
        const auto& property = properties[host];
        if (!property.animation && !property.pieces && !property.body && !property.fence)
            return;
        auto current = property.body     ? std::vector<Transform>(clips.objects(hosts[host].model),
                                                                  multiply(hosts[host].inverse, property.body->pose()))
                       : property.pieces ? property.pieces->pose()
                       : property.fence
                           ? std::vector<Transform>(clips.objects(hosts[host].model), identity_transform())
                           : clips.delta(hosts[host].model, property.animation->frame(), property.animation->basis());
        if (property.fence) {
            const auto& source = hosts[host];
            const auto offset = transform_point(source.inverse, source.position + property.fence->offset()) -
                                transform_point(source.inverse, source.position);
            for (auto& matrix : current) {
                matrix[12] = offset.x;
                matrix[13] = offset.y;
                matrix[14] = offset.z;
            }
        }
        const auto index = motion_ids[host];
        if (index == none) {
            motion_ids[host] = motions.size();
            motions.push_back({host, current, std::move(current), property.fence.has_value()});
        } else {
            motions[index].current = std::move(current);
            if (snap)
                motions[index].previous = motions[index].current;
        }
    }

    void refresh_frames() {
        if (!materials_dirty)
            return;
        auto states = material_states;
        for (const auto owner : frame_owners)
            for (const auto target : fragile_targets[owner]) {
                auto& state = states[target];
                state.instance = target;
                state.frame = 1;
                state.materials.clear();
                state.crowd = false;
            }
        texture_states.clear();
        for (auto& [host, state] : states) {
            static_cast<void>(host);
            texture_states.push_back(std::move(state));
        }
        materials_dirty = false;
    }

    void clear_frame(std::size_t host) {
        if (frame_owners.erase(host))
            materials_dirty = true;
    }

    void crack_frame(std::size_t host) {
        frame_owners.insert(host);
        materials_dirty = true;
    }

    void update_material(std::size_t host) {
        auto& state = material_states[host];
        state = {};
        state.instance = host;
        if (properties[host].flag)
            state.wave = properties[host].flag->wave();
        if (properties[host].scroll)
            state.uv = properties[host].scroll->offset();
        if (properties[host].flip)
            state.materials = properties[host].flip->frames();
        if (properties[host].crowd && hosts[host].model < draw_materials.size()) {
            state.crowd = true;
            const auto grid = *properties[host].crowd;
            const auto& materials = draw_materials[hosts[host].model];
            for (std::size_t i = 0; i < std::min(materials.size(), std::size_t(grid[0] * grid[1])); ++i)
                state.materials.push_back({materials[i], crowd_clock.frames()[i]});
        }
        materials_dirty = true;
    }

    void remember_fragile_target(std::size_t host, std::size_t owner, std::set<std::size_t>& selected) const {
        if (host >= hosts.size() || owner >= hosts.size())
            return;
        const auto source = hosts[host].model, target = hosts[owner].model;
        if (source >= model_materials.size() || target >= model_materials.size())
            return;
        for (const auto material : model_materials[source])
            if (model_materials[target].contains(material)) {
                selected.insert(owner);
                break;
            }
    }

    void find_fragile_targets(std::size_t host) {
        std::set<std::size_t> selected{host};
        const auto slot = hosts[host].slot;
        if (slot >= slots.size()) {
            fragile_targets[host] = {host};
            return;
        }
        std::vector<std::pair<std::size_t, std::size_t>> pending{{slots[slot].chains[4], host}};
        std::set<std::pair<std::size_t, std::size_t>> visited;
        while (!pending.empty()) {
            const auto [chain, owner] = pending.back();
            pending.pop_back();
            if (chain >= chains.size() || owner >= hosts.size() || !visited.insert({chain, owner}).second)
                continue;
            if (visited.size() > 200000)
                throw std::runtime_error("Fragile material graph exceeds limit");
            for (const auto& node : chains[chain].nodes) {
                if (node.main == 21 || node.main == 26)
                    pending.push_back({ref(node.refs, "function", functions), owner});
                else if (node.main == 7) {
                    const auto target = ref(node.refs, "instance", instance_ids),
                               graph = ref(node.refs, "effectGraph", graphs);
                    if (graph < chains.size())
                        pending.push_back({graph, target});
                    else if (node.payload.contains("Instance") && node.payload.at("Instance").value("Effect", -1) == 0)
                        remember_fragile_target(host, target, selected);
                } else if (node.main == 0 && node.payload.at("type0").value("SubType", -1) == 5 &&
                           node.payload.at("type0").value("DeadNodeMode", 0) >= 2)
                    remember_fragile_target(host, owner, selected);
            }
        }
        fragile_targets[host] = {selected.begin(), selected.end()};
    }

    void trigger(std::size_t host) {
        const auto slot = hosts[host].slot;
        if (slot < slots.size()) {
            const auto interaction = arm_interaction(host, slots[slot].chains[4]) ? host : none;
            enqueue(slots[slot].chains[4], host, false, false, false, {}, false, hosts[host].impact,
                    hosts[host].contact, interaction);
        }
    }

    bool fragile_graph(std::size_t chain, std::size_t host, std::set<std::size_t>& visited) const {
        if (chain >= chains.size() || !visited.insert(chain).second)
            return false;
        for (const auto& node : chains[chain].nodes) {
            if (node.main == 0 && node.payload.at("type0").value("SubType", -1) == 14)
                return true;
            if ((node.main == 21 || node.main == 26) &&
                fragile_graph(ref(node.refs, "function", functions), host, visited))
                return true;
            if (node.main == 7 && ref(node.refs, "instance", instance_ids) == host &&
                fragile_graph(ref(node.refs, "effectGraph", graphs), host, visited))
                return true;
        }
        return false;
    }

    bool pad_graph(std::size_t chain, std::size_t host, std::set<std::size_t>& visited, int kind = 0) const {
        if (chain >= chains.size() || !visited.insert(chain).second)
            return false;
        for (const auto& node : chains[chain].nodes) {
            if (kind ? node.main == kind : node.main == 17 || node.main == 18)
                return true;
            if ((node.main == 21 || node.main == 26) &&
                pad_graph(ref(node.refs, "function", functions), host, visited, kind))
                return true;
            if (node.main == 7 && ref(node.refs, "instance", instance_ids) == host &&
                pad_graph(ref(node.refs, "effectGraph", graphs), host, visited, kind))
                return true;
        }
        return false;
    }

    bool permanent(std::size_t host) const {
        const auto slot = hosts[host].slot;
        return properties[host].kind == 5 && properties[host].mode == 4 && slot < slots.size() &&
               slots[slot].chains[2] != none;
    }

    void reward(std::size_t host) {
        if (host >= hosts.size())
            return;
        reward_marks[host] = true;
        if (properties[host].kind == 5 && properties[host].mode >= 2)
            collected_rewards.insert(host);
    }

    bool arm_interaction(std::size_t root, std::size_t entry) {
        if (root >= hosts.size() || entry >= chains.size())
            return false;
        std::set<std::pair<std::size_t, std::size_t>> visited;
        std::vector<std::pair<std::size_t, std::size_t>> pending{{entry, root}};
        std::set<std::size_t> members{root}, rails;
        bool temporary = false;
        while (!pending.empty()) {
            const auto [chain, host] = pending.back();
            pending.pop_back();
            if (chain >= chains.size() || host >= hosts.size() || hosts[host].mode_hidden ||
                !visited.insert({chain, host}).second)
                continue;
            if (visited.size() > 200000)
                throw std::runtime_error("Interaction reset graph exceeds limit");
            members.insert(host);
            for (const auto& node : chains[chain].nodes) {
                if (node.main == 21 || node.main == 26)
                    pending.push_back({ref(node.refs, "function", functions), host});
                else if (node.main == 7) {
                    const auto target = ref(node.refs, "instance", instance_ids),
                               graph = ref(node.refs, "effectGraph", graphs);
                    if (target >= hosts.size() || hosts[target].mode_hidden)
                        continue;
                    members.insert(target);
                    if (graph < chains.size())
                        pending.push_back({graph, target});
                    else if (node.payload.contains("Instance") && node.payload.at("Instance").value("Effect", -1) == 0)
                        temporary = true;
                } else if (node.main == 0) {
                    const auto& fields = node.payload.at("type0");
                    const auto sub = fields.value("SubType", -1), operation = fields.value("DeadNodeMode", 0);
                    const auto slot = hosts[host].slot;
                    const bool latched_kill =
                        sub == 5 && operation == 4 && slot < slots.size() && slots[slot].chains[2] != none;
                    temporary |= sub == 0 || sub == 20 || (sub == 5 && operation >= 2 && !latched_kill);
                } else if (node.main == 25) {
                    const auto rail = ref(node.refs, "spline", spline_ids);
                    if (rail != none)
                        rails.insert(rail);
                }
            }
        }
        if (!temporary)
            return false;
        // Application reset policy, separate from each authored property's lifetime.
        const auto deadline = clock + 30.;
        interaction_due[root] = deadline;
        for (const auto host : members)
            reset_due[host] = deadline;
        for (const auto rail : rails)
            rail_reset_due[rail] = deadline;
        return true;
    }

    void reset_interactions() {
        std::set<std::size_t> expired, restored;
        for (auto i = interaction_due.begin(); i != interaction_due.end();)
            if (i->second <= clock + 1e-9) {
                expired.insert(i->first);
                i = interaction_due.erase(i);
            } else
                ++i;
        for (std::size_t host = 0; host < reset_due.size(); ++host) {
            if (reset_due[host] < 0 || reset_due[host] > clock + 1e-9)
                continue;
            reset_due[host] = -1;
            if (hosts[host].mode_hidden || (hosts[host].showoff && mode != RunMode::Showoff) ||
                collected_pads.contains(host) || collected_rewards.contains(host) || permanent(host))
                continue;
            restored.insert(host);
            reward_marks[host] = false;
            particles.kill(host);
            particle_hosts.erase(host);
            erase_route(host);
            hosts[host].kill_movers = false;
            hosts[host].impact = {};
            hosts[host].contact.reset();
            destroy(host);
            busy[host] = false;
            cooldowns[host] = 0;
        }
        const auto discard = [&](const Thread& thread) {
            const bool remove =
                !thread.setup && (expired.contains(thread.interaction) || restored.contains(thread.instance));
            if (remove && thread.collision && thread.instance < busy.size())
                busy[thread.instance] = false;
            return remove;
        };
        std::erase_if(ready, discard);
        std::erase_if(waiting, discard);
        for (const auto host : restored) {
            const auto slot = hosts[host].slot;
            if (host_active[host] && slot < slots.size())
                enqueue(slots[slot].chains[0], host, false, false);
        }
        for (auto i = rail_reset_due.begin(); i != rail_reset_due.end();)
            if (i->second <= clock + 1e-9) {
                const auto rail = i->first;
                const bool enabled = mode_rails.contains(rail) ? mode_rails.at(rail)
                                     : rail < paths.size()     ? paths[rail].enabled
                                                               : true;
                if (actions.size() < 4096)
                    actions.push_back({WorldActionKind::RailToggle, double(enabled), rail, {}, false});
                i = rail_reset_due.erase(i);
            } else
                ++i;
    }

    void destroy(std::size_t host, bool restore_flags = true) {
        body_hosts.erase(host);
        if (properties[host].force && properties[host].force->occupied())
            for (const auto id : properties[host].force->occupants())
                force_wait_exit[host].insert(id);
        force_hosts.erase(host);
        if (material_states.erase(host))
            materials_dirty = true;
        clear_frame(host);
        erase_motion(host);
        properties[host] = {};
        if (restore_flags)
            restore(host);
    }

    void finish(std::size_t host) {
        auto& property = properties[host];
        if (property.end_requested)
            return;
        property.end_requested = true;
        const auto slot = hosts[host].slot;
        const auto end = slot < slots.size() ? slots[slot].chains[3] : none;
        if (end != none)
            enqueue(end, host, false, false);
        else
            destroy(host);
    }

    void install_force(std::size_t host, const Json& payload, int kind) {
        if (hosts[host].mode_hidden)
            return;
        BoostLaw law;
        law.kind = kind;
        const auto direction = [&](const Json& fields, const char* x, const char* y, const char* z) {
            return Vec3{number(fields, x), number(fields, z), -number(fields, y)};
        };
        if (kind == 7) {
            const auto& f = payload.at("Boost");
            law.mode = f.value("Mode", 1);
            law.seconds = number(f, "U1");
            law.rate = number(f, "U2");
            law.target = number(f, "BoostAmount");
            const auto& d = f.at("BoostDir");
            law.direction = {d[0].get<double>(), d[2].get<double>(), -d[1].get<double>()};
        } else {
            const auto& f = payload.at("type0Sub" + std::to_string(kind));
            if (kind == 24) {
                law.mode = f.value("U0", 1);
                law.seconds = number(f, "U1");
                law.rate = number(f, "U2");
                law.target = number(f, "U3");
                law.direction = direction(f, "U4", "U5", "U6");
                for (unsigned i = 0; i < 3; ++i) {
                    const auto at = 7 + i * 3;
                    law.stage_direction[i] =
                        direction(f, ("U" + std::to_string(at)).c_str(), ("U" + std::to_string(at + 1)).c_str(),
                                  ("U" + std::to_string(at + 2)).c_str());
                    law.stage_speed[i] = number(f, ("U" + std::to_string(16 + i)).c_str());
                }
            } else {
                law.rate = number(f, "U0");
                law.target = number(f, "U1");
                law.direction = direction(f, "U2", "U3", "U4");
                if (kind == 18) {
                    law.height = number(f, "U5") / 100;
                    law.tolerance = number(f, "U6") / 100;
                }
            }
        }
        if (properties[host].force && properties[host].force->law() == law) {
            properties[host].force->activate();
            return;
        }
        destroy(host);
        auto& property = properties[host];
        property.kind = kind;
        property.force = std::make_unique<ScriptedBoost>(law);
        property.force->activate();
        force_hosts.insert(host);
    }

    std::vector<std::size_t> find_models(int subtype) {
        std::vector<std::pair<std::size_t, std::size_t>> pending;
        for (std::size_t host = 0; host < hosts.size(); ++host)
            if (hosts[host].slot < slots.size())
                for (const auto chain : slots[hosts[host].slot].chains)
                    pending.push_back({chain, host});
        for (const auto& [name, chain] : functions) {
            static_cast<void>(name);
            pending.push_back({chain, none});
        }
        std::set<std::pair<std::size_t, std::size_t>> visited;
        std::set<std::size_t> models;
        while (!pending.empty()) {
            const auto [chain, host] = pending.back();
            pending.pop_back();
            if (chain >= chains.size() || !visited.insert({chain, host}).second)
                continue;
            if (visited.size() > 500000)
                throw std::runtime_error("Flag model graph exceeds limit");
            for (const auto& node : chains[chain].nodes) {
                if (node.main == 0 && node.payload.at("type0").value("SubType", -1) == subtype && host < hosts.size() &&
                    hosts[host].model < model_materials.size())
                    models.insert(hosts[host].model);
                else if (node.main == 21 || node.main == 26)
                    pending.push_back({ref(node.refs, "function", functions), host});
                else if (node.main == 7)
                    pending.push_back(
                        {ref(node.refs, "effectGraph", graphs), ref(node.refs, "instance", instance_ids)});
            }
        }
        return {models.begin(), models.end()};
    }

    void throw_mesh(std::size_t host, const Json& payload, Vec3 impact) {
        const auto model = hosts[host].model;
        if (hosts[host].mode_hidden || !throw_centres.contains(model))
            return;
        const auto& fields = payload.at("type0Sub20");
        MeshThrowLaw law;
        law.step = number(fields, "U1", .05);
        law.duration = number(fields, "U2", 2);
        law.direction = {number(fields, "U3"), number(fields, "U5"), -number(fields, "U4")};
        law.speed = {number(fields, "U6") / 100, number(fields, "U8") / 100, number(fields, "U7") / 100};
        law.multiplier = number(fields, "U9", 1);
        const auto& inverse = hosts[host].inverse;
        const auto local_vector = [&](Vec3 v) {
            return transform_point(inverse, hosts[host].position + v) - transform_point(inverse, hosts[host].position);
        };
        law.gravity = local_vector({0, -9.81, 0});
        MeshThrow pieces(law, throw_centres.at(model), local_vector(impact), random());
        destroy(host, false);
        properties[host].kind = 20;
        properties[host].pieces = std::move(pieces);
        flags[host] = WorldDraw;
        update_motion(host, true);
    }

    void install_flag(std::size_t host, const Json& payload) {
        if (hosts[host].mode_hidden)
            return;
        const auto& f = payload.at("type0Sub13");
        FlagLaw law{f.value("U0", 0u) != 0, number(f, "U1"), number(f, "U2"), number(f, "U3")};
        destroy(host);
        auto& property = properties[host];
        property.kind = 13;
        property.flag.emplace(law, std::generate_canonical<double, 32>(random));
        flags[host] |= WorldDraw;
        update_material(host);
    }

    void install_fence(std::size_t host, const Json& payload, Vec3 impact) {
        if (hosts[host].mode_hidden || hosts[host].model >= clips.models())
            return;
        FencePlayback reaction(number(payload.at("Fence"), "FlexAmmount"), impact);
        destroy(host, false);
        properties[host].kind = 12;
        properties[host].fence = std::move(reaction);
        update_motion(host, true);
    }

    void install_crowd(std::size_t host, const Json& payload) {
        if (hosts[host].mode_hidden)
            return;
        const auto& fields = payload.at("CrowdEffect");
        const bool native = fields.contains("U2");
        const auto rows = fields.at(native ? "U1" : "U0").get<unsigned>(),
                   columns = fields.at(native ? "U2" : "U1").get<unsigned>();
        if (!rows || !columns || rows > 16 || columns > 16 || rows * columns > 16)
            throw std::runtime_error("Crowd grid exceeds sixteen cells");
        destroy(host);
        properties[host].kind = 17;
        properties[host].crowd = std::array<unsigned, 2>{rows, columns};
        flags[host] |= WorldDraw;
        update_material(host);
    }

    void install_material(std::size_t host, const Json& payload, int kind) {
        if (hosts[host].mode_hidden)
            return;
        destroy(host);
        auto& property = properties[host];
        property.kind = kind;
        if (kind == 10) {
            const auto& fields = payload.at("UVScroll");
            ScrollLaw law;
            law.mode = fields.value("U0", 0);
            law.u = number(fields, "U1");
            law.v = number(fields, "U2");
            law.active = number(fields, "U3", 1);
            law.pause = number(fields, "U4");
            law.lifetime = number(fields, "U5");
            property.scroll.emplace(law);
        } else {
            const auto& fields = payload.at("TextureFlip");
            FlipLaw law;
            law.start = std::bit_cast<std::int32_t>(fields.value("U0", std::uint32_t(0)));
            law.direction = fields.value("Direction", 0);
            law.speed = number(fields, "Speed");
            law.length = number(fields, "Length");
            law.dwell = fields.value("U4", 0) != 0;
            std::vector<FlipMaterial> materials;
            if (hosts[host].model < model_materials.size())
                for (const auto material : model_materials[hosts[host].model])
                    if (material < material_counts.size())
                        materials.push_back({material, material_counts[material]});
            property.flip = std::make_unique<TexturePlayback>(law, materials, random());
        }
        flags[host] |= WorldDraw;
        update_material(host);
    }

    void animate(std::size_t host, const Json& payload, int kind) {
        if (hosts[host].mode_hidden || clips.frames(hosts[host].model) <= 0)
            return;
        const auto& fields = payload.at("type0Sub" + std::to_string(kind));
        PropPlayLaw law;
        law.kind = kind;
        law.loop = fields.value("U0", 0);
        law.start = fields.value("U1", -1.);
        if (kind == 257 && std::abs(law.start) > 1e6)
            law.start = std::bit_cast<float>(fields.at("U1").get<std::int32_t>());
        else
            law.start = number(fields, "U1", -1);
        law.end = number(fields, "U2", -1);
        law.rate = number(fields, "U3", 30);
        law.random_rate = number(fields, "U4");
        law.debounce = number(fields, "U5");
        law.random_start = fields.value("U6", 0) != 0;
        law.reverse = fields.value("U7", 3) == 4;
        if (kind == 258) {
            law.combo_start = number(fields, "U8", -1);
            law.combo_last = number(fields, "U9", -1);
            law.combo_rate = number(fields, "U10", 30);
            law.combo_end = fields.value("U11", 0);
        }
        destroy(host);
        auto& property = properties[host];
        property = {};
        property.kind = kind;
        property.debounce = std::max(0., law.debounce);
        property.animation.emplace(law, clips.frames(hosts[host].model), std::generate_canonical<double, 32>(random));
        if (!property.animation->valid()) {
            destroy(host);
            return;
        }
        restore(host);
        flags[host] |= WorldDraw;
        update_motion(host, true);
    }

    void erase_route(std::size_t host) {
        const auto found = movers.find(host);
        if (found == movers.end())
            return;
        const auto index = found->second.draw;
        if (index + 1 < route_draws.size()) {
            route_draws[index] = std::move(route_draws.back());
            movers.at(route_draws[index].instance).draw = index;
        }
        route_draws.pop_back();
        movers.erase(found);
    }

    void route_pose_update(std::size_t host, bool snap = false) {
        auto& mover = movers.at(host);
        auto& draw = route_draws[mover.draw];
        draw.previous = draw.current;
        draw.current.clear();
        const auto& route = *route_math.at(mover.path);
        const auto distances = mover.playback.distances();
        const auto direction = mover.playback.direction();
        for (const auto distance : distances)
            draw.current.push_back(
                multiply(hosts[host].inverse, route_pose(route.sample(distance), mover.playback.law().orientation,
                                                         mover.playback.law().yaw, direction)));
        if (snap || mover.samples.size() != distances.size())
            draw.previous = draw.current;
        else
            for (std::size_t i = 0; i < distances.size(); ++i)
                if (direction != mover.direction || (distances[i] - mover.samples[i]) * direction < -1e-8)
                    draw.previous[i] = draw.current[i];
        mover.samples = distances;
        mover.direction = direction;
    }

    void route_install(std::size_t host, const Node& node) {
        const auto path = ref(node.refs, "spline", spline_ids);
        if (hosts[host].mode_hidden || path >= paths.size() || paths[path].curves.empty())
            return;
        auto& route = route_math[path];
        if (!route)
            route = std::make_shared<PropRoute>(paths[path].curves);
        const auto& fields = node.payload.at("type2").at("SplineAnimation");
        RouteLaw law;
        law.end_mode = fields.value("U1", 1);
        law.orientation = fields.value("U2", 0);
        law.copies = fields.value("InstanceCount", 1u);
        law.speed = number(fields, "AnimationSpeed");
        law.yaw = number(fields, "U5");
        law.line = fields.value("U6", 0) != 0;
        law.colour = {float(number(fields, "R")), float(number(fields, "G")), float(number(fields, "B")),
                      float(number(fields, "U7"))};
        RoutePlayback player(law, route->length());
        if (player.retired())
            return;
        erase_route(host);
        hosts[host].kill_movers = false;
        const auto draw_index = route_draws.size();
        movers.emplace(host, Mover{path, draw_index, std::move(player)});
        route_draws.push_back({host, {}, {}, {}});
        auto& draw = route_draws.back();
        if (law.line)
            for (const auto& curve : route->curves()) {
                RouteLine line;
                line.colour = law.colour;
                for (unsigned i = 0; i < line.points.size(); ++i)
                    line.points[i] = curve.point(i / 10.);
                draw.lines.push_back(line);
            }
        route_pose_update(host, true);
    }

    void control(std::size_t host, const Json& fields) {
        if (host >= properties.size() || properties[host].kind < 0)
            return;
        const auto command = fields.value("U0", 0);
        if (command == 7 || command == 8) {
            hosts[host].kill_movers = command == 8;
            return;
        }
        if (properties[host].checklist) {
            properties[host].checklist->control(unsigned(command), number(fields, "U1"));
            return;
        }
        if (properties[host].scroll) {
            properties[host].scroll->control(unsigned(command), number(fields, "U1"));
            update_material(host);
            return;
        }
        if (properties[host].flip) {
            properties[host].flip->control(unsigned(command), number(fields, "U1"));
            update_material(host);
            return;
        }
        if (!properties[host].animation)
            return;
        const auto value = number(fields, "U1");
        auto& player = *properties[host].animation;
        if (command == 1)
            player.hold(std::max(0., value));
        else if (command == 2 && properties[host].kind == 257)
            player.grant(std::max(0., value));
        else if (command == 3 && properties[host].kind == 258)
            player.trigger_combo();
        else if (command == 4)
            player.seek(std::clamp(value, 0., clips.frames(hosts[host].model)));
        update_motion(host, command == 4);
    }

    void observe_regions(std::span<const Vec3> observers) {
        if (observers.empty())
            return;
        for (const auto position : observers)
            if (!finite(position))
                throw std::invalid_argument("Invalid world observer");
        std::vector<bool> nearby_hosts(hosts.size());
        for (auto& [key, region] : regions) {
            bool nearby = false;
            const Vec3 minimum{key[0] * 100., key[1] * 100., key[2] * 100.}, maximum = minimum + Vec3{100, 100, 100};
            for (const auto position : observers) {
                const auto closest =
                    Vec3{std::clamp(position.x, minimum.x, maximum.x), std::clamp(position.y, minimum.y, maximum.y),
                         std::clamp(position.z, minimum.z, maximum.z)};
                if (length(closest - position) <= 300) {
                    nearby = true;
                    break;
                }
            }
            if (nearby) {
                region.absent = 0;
                region.active = true;
            } else if (region.active && ++region.absent >= 2)
                region.active = false;
            if (region.active)
                for (const auto host : region.hosts)
                    nearby_hosts[host] = true;
        }
        for (std::size_t host = 0; host < hosts.size(); ++host) {
            if (nearby_hosts[host] == host_active[host])
                continue;
            host_active[host] = nearby_hosts[host];
            const auto& property = properties[host];
            const auto slot = hosts[host].slot;
            if (nearby_hosts[host]) {
                if ((hosts[host].showoff && mode != RunMode::Showoff) || hosts[host].mode_hidden ||
                    (property.kind == 5 && property.mode >= 2 && property.mode <= 3))
                    continue;
                if ((property.kind == 2 && property.time < 0) ||
                    ((property.kind >= 0 || particle_hosts.contains(host)) && slot < slots.size() &&
                     slots[slot].chains[2] != none))
                    continue;
                if (slot < slots.size())
                    enqueue(slots[slot].chains[0], host, false, false);
            } else {
                if ((property.kind == 2 && property.time < 0) ||
                    (property.kind == 5 && property.mode >= 2 && property.mode <= 3))
                    continue;
                const auto latch = slot < slots.size() ? slots[slot].chains[2] : none;
                if (latch != none)
                    enqueue(latch, host, false, false);
                else {
                    particles.kill(host);
                    particle_hosts.erase(host);
                    destroy(host);
                }
            }
        }
    }

    void route_regions() {
        std::set<std::pair<std::size_t, std::size_t>> visited;
        std::vector<std::pair<std::size_t, std::size_t>> pending;
        for (std::size_t host = 0; host < hosts.size(); ++host)
            if (hosts[host].slot < slots.size())
                pending.push_back({slots[hosts[host].slot].chains[0], host});
        for (const auto& [name, chain] : entries) {
            static_cast<void>(name);
            pending.push_back({chain, none});
        }
        while (!pending.empty()) {
            const auto [chain, host] = pending.back();
            pending.pop_back();
            if (chain >= chains.size() || !visited.insert({chain, host}).second)
                continue;
            if (visited.size() > 200000)
                throw std::runtime_error("Mover region graph exceeds limit");
            for (const auto& node : chains[chain].nodes) {
                if (node.main == 21 || node.main == 26)
                    pending.push_back({ref(node.refs, "function", functions), host});
                else if (node.main == 7)
                    pending.push_back(
                        {ref(node.refs, "effectGraph", graphs), ref(node.refs, "instance", instance_ids)});
                else if (host < hosts.size() && node.main == 2 && node.payload.at("type2").value("SubType", 0) == 1) {
                    const auto path = ref(node.refs, "spline", spline_ids);
                    if (path >= paths.size())
                        continue;
                    std::set<std::array<int, 3>> cells;
                    for (const auto& curve : paths[path].curves) {
                        double estimate = 0;
                        for (unsigned i = 0; i < 3; ++i)
                            estimate += length(curve.point((i + 1) / 3.) - curve.point(i / 3.));
                        const auto samples = unsigned(std::clamp(std::ceil(estimate / 50.), 64., 4096.));
                        for (unsigned i = 0; i <= samples; ++i) {
                            const auto point = curve.point(double(i) / samples);
                            cells.insert({int(std::floor(point.x / 100)), int(std::floor(point.y / 100)),
                                          int(std::floor(point.z / 100))});
                        }
                    }
                    if (cells.size() > 200000)
                        throw std::runtime_error("Mover region path exceeds limit");
                    for (const auto& cell : cells)
                        regions[cell].hosts.push_back(host);
                }
            }
        }
        for (auto& [cell, region] : regions) {
            static_cast<void>(cell);
            std::sort(region.hosts.begin(), region.hosts.end());
            region.hosts.erase(std::unique(region.hosts.begin(), region.hosts.end()), region.hosts.end());
        }
    }

    void action(WorldActionKind kind, const Thread& thread, double value = 0, std::size_t target = 0) {
        if (actions.size() >= 4096)
            return;
        actions.push_back({kind, value, target,
                           thread.instance < hosts.size() ? hosts[thread.instance].position : Vec3{}, thread.rider,
                           thread.actor});
    }

    bool gate(const Node& node, const Thread& thread, double speed) {
        if (thread.rider)
            if (const auto found = rider_speeds.find(thread.actor); found != rider_speeds.end())
                speed = found->second;
        const auto& p = node.payload.at("type5");
        const auto test = p.value("U0", 0);
        if (test == 2)
            return thread.rider && thread.human;
        if (test == 3)
            return thread.instance >= properties.size() || properties[thread.instance].kind < 0;
        // The interchange preserves these two words at their authored bit types.
        const auto selector = std::bit_cast<std::uint32_t>(float(number(p, "U1")));
        const auto threshold = std::bit_cast<float>(p.value("U2", std::uint32_t(0)));
        if (!std::isfinite(threshold))
            throw std::runtime_error("Invalid world gate threshold");
        if (test == 0) {
            if (!thread.rider)
                return true;
            return selector == 0 ? speed * 100 <= threshold : selector == 1 ? speed * 3.6 >= threshold : true;
        }
        if (test == 1) {
            const auto roll = std::generate_canonical<double, 32>(random);
            return selector == 0 ? roll < threshold : selector == 1 ? roll >= threshold : true;
        }
        return true;
    }

    void drain(double speed) {
        while (!ready.empty() && budget) {
            auto thread = std::move(ready.front());
            ready.pop_front();
            const auto& chain = chains.at(thread.chain);
            bool hold = false;
            while (thread.pc < chain.nodes.size() && budget) {
                --budget;
                const auto& node = chain.nodes[thread.pc++];
                const auto& p = node.payload;
                const auto host = thread.instance;
                if (node.main == 4) {
                    thread.wait = std::max(0., number(p, "WaitTime"));
                    if (thread.wait > 0) {
                        hold = true;
                        break;
                    }
                } else if (node.main == 5) {
                    if (!gate(node, thread, speed))
                        break;
                } else if (node.main == 21 || node.main == 26)
                    enqueue(ref(node.refs, "function", functions), host, node.main == 21 && thread.rider, thread.human,
                            false, thread.ancestry, thread.setup, thread.impact, thread.contact, thread.interaction,
                            thread.actor);
                else if (node.main == 7) {
                    const auto target = ref(node.refs, "instance", instance_ids),
                               graph = ref(node.refs, "effectGraph", graphs);
                    if (target >= hosts.size() || (hosts[target].showoff && mode != RunMode::Showoff) ||
                        (hosts[target].mode_hidden && !thread.setup))
                        continue;
                    if (graph < chains.size())
                        enqueue(graph, target, thread.rider, thread.human, false, thread.ancestry, thread.setup,
                                thread.impact, thread.contact, thread.interaction, thread.actor);
                    else if (p.contains("Instance") && p.at("Instance").contains("Effect")) {
                        if (p.at("Instance").at("Effect").get<int>() == 0) {
                            destroy(target);
                            flags[target] = 0;
                            properties[target].kind = 5;
                            properties[target].mode = 2;
                            if (reward_marks[target])
                                collected_rewards.insert(target);
                            if (thread.setup)
                                hosts[target].mode_hidden = true;
                        } else {
                            destroy(target);
                            flags[target] |= WorldDraw;
                        }
                    }
                } else if (node.main == 2 && host < hosts.size() && p.at("type2").value("SubType", 0) == 1)
                    route_install(host, node);
                else if (node.emitter && host < hosts.size()) {
                    if (hosts[host].mode_hidden)
                        continue;
                    hosts[host].kill_movers = false;
                    auto matrix = inverse_transform(hosts[host].inverse);
                    if (properties[host].body)
                        matrix = properties[host].body->pose();
                    if (const auto mover = movers.find(host); mover != movers.end()) {
                        const auto& copies = route_draws[mover->second.draw].current;
                        if (!copies.empty())
                            matrix = multiply(inverse_transform(hosts[host].inverse), copies.front());
                    }
                    const bool collision = p.at("type2").value("SubType", 0) == 2;
                    particles.spawn(host, *node.emitter, matrix,
                                    collision
                                        ? thread.contact.value_or(ParticleContact{hosts[host].position, {0, 1, 0}})
                                        : std::optional<ParticleContact>{});
                    particle_hosts.insert(host);
                } else if ((node.main == 3 || node.main == 9) && host < hosts.size())
                    control(host, p.at(node.main == 3 ? "type3" : "type9"));
                else if (node.main == 0 && host < hosts.size()) {
                    const auto& property = p.at("type0");
                    const auto sub = property.at("SubType").get<int>();
                    if (sub == 0) {
                        const auto& fields = property.at("type0Sub0");
                        const auto mass = number(fields, "U0");
                        if (mass <= 0)
                            throw std::runtime_error("Roller mass must be positive");
                        const Vec3 launch{number(fields, "U3"), number(fields, "U5"), -number(fields, "U4")};
                        destroy(host, false);
                        properties[host].kind = 0;
                        properties[host].roller = Property::Roller{mass, launch};
                        body_hosts.insert(host);
                        flags[host] = WorldDraw | WorldCollide | WorldDynamic;
                    } else if (sub == 2) {
                        destroy(host);
                        properties[host].kind = 2;
                        properties[host].time = number(property, "Debounce");
                    } else if (sub == 6) {
                        destroy(host);
                        properties[host].kind = 6;
                        properties[host].checklist.emplace(property.at("Counter").at("Count").get<std::uint32_t>());
                    } else if (sub == 14) {
                        const auto& fields = property.at("type0Sub14");
                        destroy(host);
                        properties[host].kind = 14;
                        properties[host].fragile.emplace(number(fields, "U1"), number(fields, "U0", -1));
                        crack_frame(host);
                    } else if (sub == 20)
                        throw_mesh(host, property, thread.impact);
                    else if (sub == 7 || sub == 15 || sub == 18 || sub == 24)
                        install_force(host, property, sub);
                    else if (sub == 10 || sub == 11)
                        install_material(host, property, sub);
                    else if (sub == 17)
                        install_crowd(host, property);
                    else if (sub == 13)
                        install_flag(host, property);
                    else if (sub == 12)
                        install_fence(host, property, thread.impact);
                    else if (sub == 256 || sub == 257 || sub == 258)
                        animate(host, property, sub);
                    else if (sub == 5) {
                        const auto operation = property.value("DeadNodeMode", 0);
                        if (operation == 1) {
                            properties[host].paused = true;
                            if (properties[host].animation)
                                properties[host].animation->paused(true);
                        } else {
                            destroy(host, operation == 0);
                            if (operation >= 2) {
                                if (thread.rider && pad_instances[host])
                                    collected_pads.insert(host);
                                if (reward_marks[host])
                                    collected_rewards.insert(host);
                                if (operation == 3) {
                                    hosts[host].kill_movers = true;
                                    particles.kill(host);
                                    particle_hosts.erase(host);
                                }
                                properties[host].kind = 5;
                                properties[host].mode = operation;
                                flags[host] = 0;
                                if (thread.setup)
                                    hosts[host].mode_hidden = true;
                            }
                        }
                    } else
                        ++unknown;
                } else if (node.main == 17 || node.main == 18) {
                    if (thread.rider) {
                        reward(host);
                        action(node.main == 17 ? WorldActionKind::SpeedBoost : WorldActionKind::TrickBoost, thread,
                               std::max(0., number(p, node.main == 17 ? "type17" : "type18")));
                        if (thread.human)
                            action(WorldActionKind::MainSound, thread, node.main == 17 ? 115 : 114);
                    }
                } else if (node.main == 13) {
                    if (thread.rider)
                        action(WorldActionKind::Reset, thread, 0, host);
                } else if (node.main == 14 && thread.rider) {
                    const auto tier = number(p, "MultiplierScore");
                    if (tier == 2 || tier == 3 || tier == 5) {
                        reward(host);
                        if (mode == RunMode::Showoff)
                            action(WorldActionKind::Multiplier, thread, tier);
                        if (thread.human)
                            action(WorldActionKind::MainSound, thread, tier == 2 ? 116 : tier == 3 ? 117 : 118);
                    }
                } else if (node.main == 8)
                    action(WorldActionKind::CourseSound, thread, number(p, "SoundPlay"));
                else if (node.main == 24) {
                    const auto target = ref(node.refs, "instance", instance_ids);
                    if (thread.rider && target < hosts.size())
                        action(WorldActionKind::Teleport, thread, 0, target);
                } else if (node.main == 25) {
                    const auto rail = ref(node.refs, "spline", spline_ids);
                    if (rail != none) {
                        if (thread.setup)
                            mode_rails[rail] = number(p.at("Spline"), "Effect") != 0;
                        action(WorldActionKind::RailToggle, thread, number(p.at("Spline"), "Effect"), rail);
                    }
                } else
                    ++unknown;
            }
            if (hold)
                waiting.push_back(std::move(thread));
            else if (thread.collision)
                busy[thread.instance] = false;
        }
        // A malformed graph cannot monopolize a fixed tick or leave contact latched.
        for (const auto& thread : ready)
            if (thread.collision)
                busy[thread.instance] = false;
        ready.clear();
        refresh_frames();
    }
};

WorldLogic::WorldLogic() : data_(std::make_unique<Data>()) {}

WorldLogic::~WorldLogic() = default;
WorldLogic::WorldLogic(WorldLogic&&) noexcept = default;
WorldLogic& WorldLogic::operator=(WorldLogic&&) noexcept = default;

WorldLogic WorldLogic::load(const std::filesystem::path& root) {
    WorldLogic result;
    if (root.empty() || !std::filesystem::exists(root / "Instances.json"))
        return result;
    auto& d = *result.data_;
    const auto instances = read(root, "Instances.json");
    const auto& rows = instances.at("Instances");
    if (!rows.is_array() || rows.size() > 100000)
        throw std::runtime_error("Invalid world instance count");
    Json doc;
    if (std::filesystem::exists(root / "Effects.json")) {
        doc = read(root, "Effects.json");
        if (doc.value("kind", "") != "openslope-effects" || doc.value("version", 0) != 1)
            throw std::runtime_error("Unsupported Effects document");
    } else if (std::filesystem::exists(root / "SSFLogic.json"))
        doc = legacy(read(root, "SSFLogic.json"));
    else {
        doc = legacy(Json::object());
        const auto source = root / "Source";
        if (std::filesystem::is_directory(source)) {
            std::optional<std::filesystem::path> behavior;
            for (const auto& entry : std::filesystem::directory_iterator(source))
                if (entry.is_regular_file() &&
                    (entry.path().extension() == ".SSF" || entry.path().extension() == ".ssf")) {
                    if (behavior)
                        throw std::runtime_error("Ambiguous source behavior files");
                    behavior = entry.path();
                }
            if (behavior) {
                const auto base = std::filesystem::weakly_canonical(root),
                           resolved = std::filesystem::weakly_canonical(*behavior),
                           relative = resolved.lexically_relative(base);
                if (relative.empty() || relative.is_absolute() || *relative.begin() == ".." ||
                    std::filesystem::file_size(resolved) > 64 * 1024 * 1024)
                    throw std::runtime_error("Invalid source behavior file");
                std::ifstream file(resolved, std::ios::binary);
                const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(file),
                                                      std::istreambuf_iterator<char>()};
                doc = Json::parse(import_detail::logic_document(bytes, root.filename().string()));
            }
        }
    }
    std::size_t node_count = 0;
    for (const auto& name : {"graphs", "functions"}) {
        const auto& array = doc.at(name);
        if (!array.is_array() || array.size() > 4096)
            throw std::runtime_error("Invalid world graph count");
        auto& lookup = std::string(name) == "graphs" ? d.graphs : d.functions;
        for (const auto& row : array) {
            if (!lookup.emplace(row.at("id").get<std::string>(), d.chains.size()).second)
                throw std::runtime_error("Duplicate world graph identity");
            Data::Chain chain;
            chain.name = row.value("name", "");
            if (std::string(name) == "functions")
                d.entries.try_emplace(chain.name, d.chains.size());
            for (const auto& node : row.at("nodes")) {
                if (++node_count > 100000)
                    throw std::runtime_error("Too many world graph nodes");
                auto payload = node.at("payload");
                if (node.at("mainType") == 0)
                    restore_throw_direction(
                        payload, node.value("extensions", Json::object()).value("nativeWords", Json::array()), false);
                if (node.at("mainType") == 0 && payload.at("type0").at("SubType") == 24) {
                    auto& fields = payload["type0"]["type0Sub24"];
                    const auto words = node.value("extensions", Json::object()).value("nativeWords", Json::array());
                    if (!fields.contains("U18") && words.size() >= 22)
                        fields["U18"] = std::bit_cast<float>(words[21].get<std::uint32_t>());
                }
                chain.nodes.push_back(
                    {node.at("mainType"), std::move(payload), node.value("references", Json::object())});
                auto& decoded = chain.nodes.back();
                if (decoded.main == 2 && decoded.payload.contains("type2")) {
                    const auto& type = decoded.payload.at("type2");
                    const auto sub = type.value("SubType", -1);
                    if (sub == 0 || sub == 2) {
                        const auto& fields = type.at(sub == 0 ? "type2Sub0" : "type2Sub2");
                        std::array<double, 51> values{};
                        values[3] = 1;
                        for (unsigned i = 0; i < values.size(); ++i) {
                            const auto key = "U" + std::to_string(i);
                            if (!fields.contains(key))
                                continue;
                            const auto& value = fields.at(key);
                            values[i] = sub == 2 && i >= 2 && i <= 48 && value.is_number_integer()
                                            ? double(std::bit_cast<float>(value.get<std::int32_t>()))
                                            : value.get<double>();
                        }
                        decoded.emitter = ParticleLaw::decode(values);
                    }
                }
            }
            d.chains.push_back(std::move(chain));
        }
    }
    const std::array<const char*, 7> columns{"persistent", "collision", "slot3", "slot4", "trigger", "slot6", "slot7"};
    std::map<std::size_t, std::size_t> original_slots;
    if (!doc.at("slots").is_array() || doc.at("slots").size() > 4096)
        throw std::runtime_error("Invalid world slot count");
    for (const auto& row : doc.at("slots")) {
        const auto index = d.slots.size();
        if (!d.slot_ids.emplace(row.at("id").get<std::string>(), index).second)
            throw std::runtime_error("Duplicate world slot identity");
        original_slots[index] = index;
        Data::Slot slot;
        for (unsigned c = 0; c < 7; ++c)
            slot.chains[c] = d.ref(row.at("circumstances"), columns[c], d.graphs);
        d.slots.push_back(slot);
    }
    for (std::size_t i = 0; i < rows.size(); ++i)
        d.instance_ids[id("instance:", i)] = i;
    const auto bindings_rows = doc.value("instances", Json::array());
    for (std::size_t i = 0; i < bindings_rows.size() && i < rows.size(); ++i)
        d.instance_ids[bindings_rows[i].at("id").get<std::string>()] = i;
    std::map<std::string, std::size_t> properties;
    for (const auto& row : doc.value("objectProperties", Json::array()))
        properties[row.at("id").get<std::string>()] = d.ref(row.at("references"), "effectSlot", d.slot_ids);
    std::map<std::size_t, std::size_t> bindings;
    for (const auto& row : doc.value("instances", Json::array())) {
        const auto index = d.ref(Json{{"instance", row.at("id")}}, "instance", d.instance_ids),
                   prop = d.ref(row, "property", properties);
        if (index < rows.size())
            bindings[index] = prop;
    }
    for (const auto& row : doc.value("splines", Json::array()))
        d.spline_ids[row.at("id").get<std::string>()] = d.spline_ids.size();
    if (std::filesystem::exists(root / "Splines.json")) {
        const auto splines = read(root, "Splines.json").at("Splines");
        for (std::size_t i = 0; i < splines.size(); ++i)
            d.spline_ids.try_emplace(id("spline:", i), i);
    }
    for (const auto& book : material_flipbooks(root))
        d.material_counts.push_back(unsigned(book.size()));
    std::vector<std::string> models;
    if (std::filesystem::exists(root / "Models.json")) {
        const auto model_rows = read(root, "Models.json").at("Models");
        for (const auto& row : model_rows) {
            models.push_back(row.value("ModelName", ""));
            std::set<std::size_t> materials;
            std::vector<std::size_t> ordered;
            for (const auto& object : row.value("ModelObjects", Json::array()))
                for (const auto& mesh : object.value("MeshData", Json::array())) {
                    const auto material = mesh.at("MaterialID").get<std::size_t>();
                    if (materials.insert(material).second)
                        ordered.push_back(material);
                }
            d.draw_materials.push_back(std::move(ordered));
            d.model_materials.push_back(std::move(materials));
        }
    }
    const auto placements = prop_detail::placements(rows);
    for (std::size_t i = 0; i < rows.size(); ++i) {
        const auto& row = rows[i];
        const auto old = row.value("EffectSlotIndex", -1);
        auto slot = old >= 0 && original_slots.contains(std::size_t(old)) ? original_slots.at(std::size_t(old)) : none;
        if (bindings.contains(i))
            slot = bindings.at(i);
        const auto model = row.value("ModelID", std::size_t(-1));
        const bool showoff =
            row.value("LTGState", 0) == 2 || (model < models.size() && models[model].starts_with("Gem_"));
        d.hosts.push_back({slot, {placements[i][12], placements[i][13], placements[i][14]}, showoff, model});
        d.hosts.back().inverse = inverse_transform(placements[i]);
        d.initial.push_back(std::uint8_t((row.value("Visable", true) ? WorldDraw : 0) |
                                         (row.value("PlayerCollision", false) ? WorldCollide : 0)));
    }
    d.pad_instances.resize(d.hosts.size());
    d.reward_marks.resize(d.hosts.size());
    for (std::size_t i = 0; i < d.hosts.size(); ++i)
        if (d.hosts[i].slot < d.slots.size()) {
            std::set<std::size_t> visited;
            d.pad_instances[i] = d.pad_graph(d.slots[d.hosts[i].slot].chains[1], i, visited);
            visited.clear();
            if (d.pad_graph(d.slots[d.hosts[i].slot].chains[1], i, visited, 14))
                d.faceted_models.push_back(d.hosts[i].model);
            for (auto column : {1u, 4u}) {
                visited.clear();
                if (d.pad_graph(d.slots[d.hosts[i].slot].chains[column], i, visited, 13)) {
                    d.reset_volumes.push_back(i);
                    break;
                }
            }
        }
    std::sort(d.faceted_models.begin(), d.faceted_models.end());
    d.faceted_models.erase(std::unique(d.faceted_models.begin(), d.faceted_models.end()), d.faceted_models.end());
    d.fragile_targets.resize(d.hosts.size());
    for (std::size_t i = 0; i < d.hosts.size(); ++i) {
        d.fragile_targets[i] = {i};
        if (d.hosts[i].slot < d.slots.size()) {
            std::set<std::size_t> visited;
            if (d.fragile_graph(d.slots[d.hosts[i].slot].chains[1], i, visited)) {
                d.initial[i] |= WorldFragile;
                d.fragile_possible = true;
                d.find_fragile_targets(i);
            }
        }
    }
    d.flag_models = d.find_models(13);
    const auto throw_models = d.find_models(20);
    if (!throw_models.empty()) {
        const auto layouts = prop_layout(root, throw_models);
        for (const auto model : throw_models) {
            auto& centres = d.throw_centres[model];
            for (const auto& object : layouts.at(model))
                centres.push_back(object.has_box ? transform_point(map_transform(object.rest), object.box.center())
                                                 : Vec3{});
        }
    }
    d.paths = spline_paths(root);
    d.host_active.resize(rows.size());
    d.clips = PropClips::load(root);
    d.flags = d.initial;
    d.busy.resize(rows.size());
    d.properties.resize(rows.size());
    d.motion_ids.resize(rows.size(), none);
    d.cooldowns.resize(rows.size());
    d.reset_due.resize(rows.size(), -1);
    for (std::size_t i = 0; i < d.hosts.size(); ++i) {
        const auto position = d.hosts[i].position;
        if (std::abs(position.x) > 1e9 || std::abs(position.y) > 1e9 || std::abs(position.z) > 1e9)
            throw std::runtime_error("World region coordinates exceed their range");
        const std::array<int, 3> key{int(std::floor(position.x / 100)), int(std::floor(position.y / 100)),
                                     int(std::floor(position.z / 100))};
        d.regions[key].hosts.push_back(i);
    }
    d.route_regions();
    result.restart(RunMode::Freeride);
    return result;
}

void WorldLogic::restart(RunMode mode, bool preserve_collected_pads) {
    auto& d = *data_;
    d.mode = mode;
    d.clock = 0;
    d.interaction_due.clear();
    d.rail_reset_due.clear();
    d.mode_rails.clear();
    std::fill(d.reset_due.begin(), d.reset_due.end(), -1);
    std::fill(d.reward_marks.begin(), d.reward_marks.end(), false);
    d.collected_rewards.clear();
    if (!preserve_collected_pads)
        d.collected_pads.clear();
    d.force_hosts.clear();
    d.body_hosts.clear();
    d.force_wait_exit.clear();
    d.actions.clear();
    d.particles.reset();
    d.particle_hosts.clear();
    d.ready.clear();
    d.waiting.clear();
    d.motions.clear();
    d.texture_states.clear();
    d.material_states.clear();
    d.materials_dirty = false;
    d.frame_owners.clear();
    d.movers.clear();
    d.route_draws.clear();
    std::fill(d.host_active.begin(), d.host_active.end(), false);
    std::fill(d.motion_ids.begin(), d.motion_ids.end(), none);
    std::fill(d.cooldowns.begin(), d.cooldowns.end(), 0);
    for (auto& [key, region] : d.regions) {
        static_cast<void>(key);
        region.active = false;
        region.absent = 0;
    }
    d.random.seed(0x4f534c50);
    d.crowd_clock = CrowdPlayback{};
    d.unknown = 0;
    d.budget = 4096;
    std::fill(d.busy.begin(), d.busy.end(), false);
    for (auto& property : d.properties)
        property = Data::Property{};
    for (std::size_t i = 0; i < d.hosts.size(); ++i) {
        d.hosts[i].mode_hidden = false;
        d.hosts[i].kill_movers = false;
        d.restore(i);
    }
    const auto name = mode == RunMode::Showoff ? "ShowoffMode" : mode == RunMode::Race ? "RaceMode" : "FreerideMode";
    if (const auto entry = d.entries.find(name); entry != d.entries.end())
        d.enqueue(entry->second, none, false, false, false, {}, true);
    d.drain(0);
    for (const auto host : d.collected_pads) {
        d.destroy(host, false);
        d.properties[host].kind = 5;
        d.properties[host].mode = 2;
        d.flags[host] = 0;
    }
    d.refresh_frames();
}

void WorldLogic::tick(double seconds, double speed, std::span<const Vec3> observers,
                      std::span<const CrowdActivity> riders, bool force_crowd) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1 || !std::isfinite(speed) || speed < 0)
        throw std::invalid_argument("Invalid world tick");
    for (const auto& rider : riders)
        if (!finite(rider.position) || rider.code > 7)
            throw std::invalid_argument("Invalid crowd rider activity");
    auto& d = *data_;
    d.budget = 4096;
    d.rider_speeds[0] = speed;
    d.clock += seconds;
    d.reset_interactions();
    d.particles.step(seconds);
    for (auto& motion : d.motions)
        motion.previous = motion.current;
    d.observe_regions(observers);
    d.drain(speed);
    unsigned activity = force_crowd ? 7 : 0;
    if (!force_crowd)
        for (std::size_t i = 0; i < d.hosts.size(); ++i)
            if (d.properties[i].crowd && !d.properties[i].paused && (d.flags[i] & WorldDraw))
                for (const auto& rider : riders)
                    if (rider.active && length(rider.position - d.hosts[i].position) <= 200)
                        activity = std::max(activity, rider.code);
    d.crowd_clock.step(seconds, activity);
    for (std::size_t i = 0; i < d.properties.size(); ++i) {
        d.cooldowns[i] = std::max(0., d.cooldowns[i] - seconds);
        auto& p = d.properties[i];
        if (p.paused)
            continue;
        if (p.fence) {
            p.fence->step(seconds);
            d.update_motion(i);
            if (p.fence->settled())
                d.finish(i);
        } else if (p.flag) {
            p.flag->step(seconds);
            d.update_material(i);
            if (p.flag->expired())
                d.finish(i);
        } else if (p.crowd) {
            d.update_material(i);
        } else if (p.scroll) {
            p.scroll->step(seconds);
            d.update_material(i);
            if (p.scroll->expired())
                d.finish(i);
        } else if (p.flip) {
            p.flip->step(seconds);
            d.update_material(i);
            if (p.flip->expired())
                d.finish(i);
        } else if (p.pieces) {
            p.pieces->step(seconds);
            d.update_motion(i);
            if (p.pieces->expired()) {
                d.destroy(i, false);
                d.properties[i].kind = 5;
                d.properties[i].mode = 4;
                d.flags[i] = 0;
            }
        } else if (p.animation) {
            p.animation->step(seconds);
            d.update_motion(i);
            if (p.animation->take_end())
                d.finish(i);
        } else if (p.kind == 2 && p.time > 0) {
            p.time = std::max(0., p.time - seconds);
            if (p.time <= 1e-9)
                d.finish(i);
        } else if (p.checklist) {
            if (p.checklist->take_trigger())
                d.trigger(i);
        } else if (p.fragile) {
            p.fragile->step(seconds);
            if (p.fragile->expired())
                d.finish(i);
        }
    }
    std::vector<std::size_t> dead_routes;
    for (auto& [host, mover] : d.movers) {
        if (d.hosts[host].kill_movers || d.properties[host].kind < 0) {
            dead_routes.push_back(host);
            continue;
        }
        mover.playback.step(seconds);
        if (mover.playback.retired())
            dead_routes.push_back(host);
        else
            d.route_pose_update(host);
    }
    for (const auto host : dead_routes)
        d.erase_route(host);
    auto threads = std::move(d.waiting);
    d.waiting.clear();
    for (auto& thread : threads) {
        thread.wait -= seconds;
        if (thread.wait <= 1e-9)
            d.ready.push_back(std::move(thread));
        else
            d.waiting.push_back(std::move(thread));
    }
    d.drain(speed);
}

void WorldLogic::apply_forces(double seconds, const CollisionWorld& world, std::span<BoostRider> riders,
                              const LapEntry& lap_entry) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1)
        throw std::invalid_argument("Invalid force update");
    auto& d = *data_;
    const auto rider_volume = [&](std::size_t host, const BoostRider& rider) {
        if (!rider.active)
            return std::optional<WorldVolume>{};
        auto hit = world.volume(host, rider.previous, rider.position);
        for (std::size_t i = 0; !hit && i < rider.probes.size(); ++i) {
            const auto current = rider.probes[i];
            const auto previous =
                rider.previous_probes.size() == rider.probes.size() ? rider.previous_probes[i] : current;
            hit = world.volume(host, previous.centre, current.centre,
                               std::max(previous.radius, current.radius) + rider.contact_margin);
        }
        return hit;
    };
    for (auto it = d.force_wait_exit.begin(); it != d.force_wait_exit.end();) {
        std::erase_if(it->second, [&](auto id) {
            return std::none_of(riders.begin(), riders.end(), [&](const auto& rider) {
                return rider.id == id && rider_volume(it->first, rider).has_value();
            });
        });
        if (it->second.empty())
            it = d.force_wait_exit.erase(it);
        else
            ++it;
    }
    std::vector<std::size_t> ended;
    for (const auto host : d.force_hosts) {
        auto& property = d.properties[host];
        if (property.paused || !property.force)
            continue;
        std::vector<std::optional<BoostVolume>> volumes;
        volumes.reserve(riders.size());
        for (const auto& rider : riders) {
            const bool waiting = d.force_wait_exit.contains(host) && d.force_wait_exit.at(host).contains(rider.id);
            const auto hit = waiting ? std::optional<WorldVolume>{} : rider_volume(host, rider);
            volumes.push_back(hit ? std::optional(BoostVolume{hit->box, hit->axis}) : std::nullopt);
        }
        property.force->apply(seconds, riders, volumes, lap_entry);
        if (property.force->expired())
            ended.push_back(host);
    }
    for (const auto host : ended)
        d.finish(host);
    d.drain(0);
}

std::size_t WorldLogic::forces() const { return data_->force_hosts.size(); }

std::optional<std::pair<Vec3, Vec3>> WorldLogic::teleport_destination(std::size_t instance, unsigned rider_slot) const {
    if (rider_slot > 5)
        throw std::invalid_argument("Invalid teleport rider slot");
    if (instance >= data_->hosts.size())
        return {};
    const auto& host = data_->hosts[instance];
    const auto matrix = inverse_transform(host.inverse);
    const auto right = normalized(transform_point(matrix, {1, 0, 0}) - host.position, {1, 0, 0}),
               forward = normalized(transform_point(matrix, {0, 0, -1}) - host.position, {0, 0, -1});
    const std::array<std::array<double, 2>, 6> offsets{{{{-1, 0}}, {{-1, 1}}, {{0, 1}}, {{1, 1}}, {{1, 0}}, {{0, 0}}}};
    return std::pair{host.position + (right * offsets[rider_slot][0] + forward * offsets[rider_slot][1]) * 3,
                     normalized(project(forward, {0, 1, 0}), {0, 0, -1})};
}

void WorldLogic::contact(std::size_t instance, double speed, bool human, double force, Vec3 direction,
                         std::optional<ParticleContact> particle_contact, std::uint64_t actor) {
    auto& d = *data_;
    if (!std::isfinite(speed) || speed < 0 || !std::isfinite(force) || force < 0 || force > 1e9 || !finite(direction))
        throw std::invalid_argument("Invalid world contact");
    if (particle_contact && (!finite(particle_contact->position) || !finite(particle_contact->normal)))
        throw std::invalid_argument("Invalid world particle contact");
    d.rider_speeds[actor] = speed;
    if (instance >= d.hosts.size() || !(d.flags[instance] & WorldCollide))
        return;
    d.hosts[instance].impact = normalized(direction, {});
    d.hosts[instance].contact =
        particle_contact.value_or(ParticleContact{d.hosts[instance].position, normalized(-direction, {0, 1, 0})});
    if (d.properties[instance].roller || d.properties[instance].fence)
        return;
    if (d.properties[instance].fragile) {
        d.properties[instance].fragile->hit(force);
        if (d.properties[instance].fragile->take_trigger()) {
            d.trigger(instance);
            d.drain(speed);
        }
        return;
    }
    if (d.force_wait_exit.contains(instance) && d.force_wait_exit.at(instance).contains(actor))
        return;
    if (d.properties[instance].force) {
        d.properties[instance].force->contact(actor);
        return;
    }
    if (d.busy[instance] || d.properties[instance].kind == 2 || d.cooldowns[instance] > 1e-9)
        return;
    const auto slot = d.hosts[instance].slot;
    if (slot < d.slots.size()) {
        const auto interaction = d.arm_interaction(instance, d.slots[slot].chains[1]) ? instance : none;
        d.cooldowns[instance] = d.properties[instance].debounce;
        d.enqueue(d.slots[slot].chains[1], instance, true, human, true, {}, false, d.hosts[instance].impact,
                  d.hosts[instance].contact, interaction, actor);
        d.drain(speed);
        d.cooldowns[instance] = std::max(d.cooldowns[instance], d.properties[instance].debounce);
        if (d.properties[instance].fragile) {
            d.properties[instance].fragile->hit(force);
            if (d.properties[instance].fragile->take_trigger()) {
                d.trigger(instance);
                d.drain(speed);
            }
        }
    }
}

std::span<const std::uint8_t> WorldLogic::flags() const { return data_->flags; }

std::span<const std::size_t> WorldLogic::faceted_models() const { return data_->faceted_models; }

std::span<const std::size_t> WorldLogic::reset_volumes() const { return data_->reset_volumes; }

void WorldLogic::prepare_bodies(const CollisionWorld& world) {
    auto& d = *data_;
    for (auto i = d.body_hosts.begin(); i != d.body_hosts.end();) {
        const auto host = *i++;
        auto& p = d.properties[host];
        if (p.body || !p.roller)
            continue;
        auto shape = world.body_shape(host);
        if (!shape) {
            ++d.unknown;
            d.body_hosts.erase(host);
            p.roller.reset();
            p.kind = 2;
            p.time = -1;
            d.flags[host] &= ~WorldDynamic;
            continue;
        }
        p.body = std::make_unique<RigidProp>(std::move(*shape), p.roller->mass, p.roller->launch);
        d.update_motion(host, true);
    }
}

void WorldLogic::step_bodies(double seconds, const Terrain& terrain, const CollisionWorld& world) {
    prepare_bodies(world);
    auto& d = *data_;
    for (const auto host : d.body_hosts) {
        auto& p = d.properties[host];
        if (!p.body || p.paused)
            continue;
        p.body->step(seconds, [&](std::span<const ProbeSphere> from, std::span<const ProbeSphere> to) {
            std::vector<PropBodyContact> contacts;
            for (const auto& hit : terrain.body_contacts(from, to))
                contacts.push_back({{hit.point, hit.normal, hit.t, hit.depth}, {}});
            for (const auto& hit : world.sweep_body(from, to, host))
                contacts.push_back({{hit.point, hit.normal, hit.t, hit.depth}, hit.surface_velocity});
            return contacts;
        });
        d.update_motion(host);
    }
}

std::optional<CollisionResponse> WorldLogic::shove(const WorldContact& contact, Vec3 velocity, Vec3 up) {
    auto& d = *data_;
    if (contact.instance >= d.properties.size() || !(d.flags[contact.instance] & WorldDynamic))
        return {};
    auto& p = d.properties[contact.instance];
    if (!p.body || p.paused)
        return {};
    return p.body->shove(contact, velocity, up);
}

std::size_t WorldLogic::bodies() const { return data_->body_hosts.size(); }

std::size_t WorldLogic::sleeping_bodies() const {
    std::size_t result = 0;
    for (const auto host : data_->body_hosts)
        if (const auto& body = data_->properties[host].body; body && body->sleeping())
            ++result;
    return result;
}

void WorldLogic::rider_speed(std::uint64_t actor, double speed) {
    if (!std::isfinite(speed) || speed < 0)
        throw std::invalid_argument("Invalid rider speed context");
    data_->rider_speeds[actor] = speed;
}

void WorldLogic::retire_rider(std::uint64_t actor) {
    data_->rider_speeds.erase(actor);
    for (auto& [host, riders] : data_->force_wait_exit) {
        (void)host;
        riders.erase(actor);
    }
    for (auto& action : data_->actions)
        if (action.rider && action.actor == actor)
            action.rider = false;
    for (auto& thread : data_->ready)
        if (thread.actor == actor)
            thread.rider = thread.human = false;
    for (auto& thread : data_->waiting)
        if (thread.actor == actor)
            thread.rider = thread.human = false;
}

std::vector<WorldAction> WorldLogic::take_actions() {
    auto actions = std::move(data_->actions);
    data_->actions.clear();
    return actions;
}

std::span<const PropMotion> WorldLogic::motions() const { return data_->motions; }

std::span<const PropRouteMotion> WorldLogic::route_motions() const { return data_->route_draws; }

std::span<const std::size_t> WorldLogic::flag_models() const { return data_->flag_models; }

std::span<const PropTextureFrame> WorldLogic::texture_frames() const { return data_->texture_states; }

bool WorldLogic::has_fragile_surfaces() const { return data_->fragile_possible; }

std::size_t WorldLogic::active_regions() const {
    return std::size_t(std::count_if(data_->regions.begin(), data_->regions.end(),
                                     [](const auto& entry) { return entry.second.active; }));
}

std::size_t WorldLogic::chains() const { return data_->chains.size(); }

std::size_t WorldLogic::unsupported() const { return data_->unknown; }

std::vector<ParticleSprite> WorldLogic::particles(double alpha, Vec3 eye) const {
    return data_->particles.draw(alpha, eye);
}

std::size_t WorldLogic::emitters() const { return data_->particles.emitters(); }
} // namespace openslope
