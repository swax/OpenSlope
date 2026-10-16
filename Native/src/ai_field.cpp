#include "openslope/ai_field.hpp"
#include <algorithm>
#include <stdexcept>

namespace openslope {
struct AiField::Member {
    std::unique_ptr<Player> rider;
    AiInput input;
    RideInput controls;
    std::uint64_t placement = 0;
    unsigned due = 0;

    Member(std::unique_ptr<Player> actor, std::shared_ptr<const AiNetwork> network, std::size_t start)
        : rider(std::move(actor)), input(std::move(network), start), placement(rider->placement_serial()) {}
};

AiField::AiField(Player& primary, unsigned count, std::shared_ptr<const AiNetwork> network)
    : network_(network ? std::move(network)
                       : std::make_shared<AiNetwork>(CoursePaths::load(primary.terrain().map_root()))) {
    if (!primary.human_ || count > 16)
        throw std::invalid_argument("AI field needs a local player and at most sixteen opponents");
    if (!network_->choose(primary.rider().position))
        throw std::runtime_error("This course has no usable AI routes.");
    for (const auto& path : network_->paths().race)
        total_ = std::max(total_, path.distance_to_finish);
    resize(primary, count);
    serial_ = primary.run_serial();
}

AiField::~AiField() = default;

unsigned AiField::size() const { return unsigned(members_.size()); }

Player& AiField::rider(std::size_t index) { return *members_.at(index)->rider; }

const Player& AiField::rider(std::size_t index) const { return *members_.at(index)->rider; }

const AiStatus& AiField::control(std::size_t index) const { return members_.at(index)->input.status(); }

void AiField::add(Player& primary) {
    const auto& paths = network_->paths();
    const auto ordinal = next_start_++;
    const auto chosen = network_->choose(primary.spawn_position_);
    std::size_t fallback = 0;
    while (!network_->rideable(fallback))
        ++fallback;
    const auto start = !paths.starts.empty() && network_->rideable(paths.starts[ordinal % paths.starts.size()])
                           ? paths.starts[ordinal % paths.starts.size()]
                       : chosen ? chosen->path
                                : fallback;
    auto tuning = primary.tuning_;
    tuning.rider_slot = ordinal % 6;
    auto actor = std::unique_ptr<Player>(new Player(primary.scene_, tuning, false));
    actor->input_field_ = this;
    auto settings = RunSettings::load(primary.terrain().map_root(), RunMode::Race);
    settings.countdown_seconds = 0;
    actor->run_ = CourseRun(paths, paths, settings);
    actor->course_recovery_ = CourseRecovery(paths);
    actor->run_active(true);
    actor->external_run_tick_ = 0;
    const auto point = network_->point(start, 0), ahead = network_->point(start, 8);
    const auto forward = normalized(project(ahead - point, {0, 1, 0}), {0, 0, -1});
    const auto slots = std::max(std::size_t(1), paths.starts.size());
    auto position = point - forward * (3. * (ordinal / slots));
    Vec3 up{0, 1, 0};
    if (const auto hit = actor->trace_ground(position + Vec3{0, 2, 0}, position - Vec3{0, 3, 0})) {
        up = hit->normal;
        position = hit->point - up * actor->contract().surface(hit->surface).bog;
    }
    actor->spawn_position_ = position;
    actor->spawn_forward_ = forward;
    actor->warp(position, normalized(project(forward, up), forward), {}, up);
    members_.push_back(std::make_unique<Member>(std::move(actor), network_, start));
}

void AiField::resize(Player& primary, unsigned count) {
    if (count > 16)
        throw std::invalid_argument("AI rider count exceeds sixteen");
    while (size() > count)
        members_.erase(members_.begin());
    while (size() < count)
        add(primary);
    rank(primary);
}

std::optional<RecoveryPose> AiField::recovery(const Player& actor) const {
    const auto choice = network_->choose(actor.rider().position);
    if (!choice)
        return {};
    const auto current = network_->project(choice->path, actor.rider().position);
    const auto progress = [&](const Player& rider) {
        const auto foot = rider.course_run().locate(rider.rider().position);
        return foot ? total_ - foot->distance_to_finish + (rider.course_run().status().lap - 1) * total_ : 0.;
    };
    double mean = 0;
    unsigned count = 0;
    for (const auto& row : standings_)
        if (row.rider != &actor && !row.rider->reset_pending()) {
            mean += progress(*row.rider);
            ++count;
        }
    const auto delta = count ? std::max(0., mean / count - progress(actor)) : 0;
    const auto ahead = network_->point(choice->path, current.station + delta);
    const auto placed = network_->choose(ahead, 50, {}, true);
    if (!placed)
        return {};
    const auto point = network_->point(placed->path, placed->station);
    return RecoveryPose{point, normalized(network_->point(placed->path, placed->station + 8) - point),
                        RecoverySource::AIPath, placed->path, placed->station};
}

void AiField::restart(Player& primary) {
    const auto count = size();
    members_.clear();
    next_start_ = 0;
    elapsed_ = 0;
    serial_ = primary.run_serial();
    resize(primary, count);
}

void AiField::rank(Player& primary) {
    auto previous = std::move(standings_);
    standings_.clear();
    const auto append = [&](const Player& actor) {
        const auto progress = actor.course_run().locate(actor.rider().position);
        const auto& run = actor.course_run().status();
        const auto distance = progress ? total_ - progress->distance_to_finish : 0;
        AiStanding row{actor.actor_, &actor, (run.lap - 1) * total_ + distance,
                       run.elapsed,  0,      run.phase == RunPhase::Finished};
        if (row.finished)
            for (const auto& old : previous)
                if (old.actor == row.actor && old.finished)
                    row.finish_time = old.finish_time;
        standings_.push_back(row);
    };
    append(primary);
    for (const auto& member : members_)
        append(*member->rider);
    std::stable_sort(standings_.begin(), standings_.end(), [](const auto& a, const auto& b) {
        if (a.finished != b.finished)
            return a.finished;
        if (a.finished && a.finish_time != b.finish_time)
            return a.finish_time < b.finish_time;
        return a.progress == b.progress ? a.actor < b.actor : a.progress > b.progress;
    });
    for (unsigned i = 0; i < standings_.size(); ++i) {
        standings_[i].place = i;
        if (standings_[i].actor == primary.actor_)
            primary_place_ = i;
    }
}

void AiField::separate(std::span<Player* const> actors) {
    for (std::size_t a = 0; a < actors.size(); ++a)
        for (std::size_t b = a + 1; b < actors.size(); ++b) {
            auto& left = *actors[a];
            auto& right = *actors[b];
            if (left.reset_pending() || right.reset_pending() || !left.run_.riding_allowed() ||
                !right.run_.riding_allowed())
                continue;
            auto delta = left.rider_.position - right.rider_.position;
            if (std::abs(delta.y) > 1.5)
                continue;
            delta.y = 0;
            const auto distance = length(delta);
            if (distance >= 1.5)
                continue;
            const auto axis = normalized(delta, normalized(cross(left.rider_.forward, {0, 1, 0}), {1, 0, 0}));
            const auto shift = axis * ((1.5 - distance) * .55);
            for (const auto& [actor, offset] :
                 std::array<std::pair<Player*, Vec3>, 2>{{{&left, shift}, {&right, -shift}}}) {
                if (actor->on_foot_) {
                    actor->rider_.position =
                        actor->walk_move(actor->rider_.position, actor->rider_.position + offset,
                                         actor->rider_.velocity, .28, 1.65, &actor->foot_contacts_);
                } else {
                    const auto before = actor->rider_;
                    actor->move_world(before, before.position + offset, false);
                }
            }
        }
}

void AiField::force_step(Player& primary, std::span<Player* const> actors, double world_seconds) {
    std::vector<Player::ForceStep> steps;
    std::vector<BoostRider> driven;
    steps.reserve(actors.size());
    driven.reserve(actors.size());
    for (auto* actor : actors) {
        if (actor->deferred_before_) {
            steps.push_back(actor->prepare_tick(*actor->deferred_before_));
            steps.back().driven.step_seconds = actor->contract().tick_seconds();
        } else {
            Player::ForceStep idle;
            idle.driven = {actor->actor_,
                           actor->rider_.position,
                           actor->rider_.position,
                           actor->rider_.velocity,
                           !actor->reset_pending() && !actor->recovering() && actor->run_.riding_allowed(),
                           actor->rider_.tube_stage};
            idle.driven.step_seconds = 0;
            idle.driven.scripted_transport = true;
            idle.driven.contact_margin = Player::trigger_margin;
            idle.probes = actor->volume(actor->rider_, !actor->rider_.grounded);
            if (actor->on_foot_)
                for (auto& probe : idle.probes)
                    probe.centre += actor->foot_room_offset_;
            idle.driven.probes = idle.probes;
            idle.driven.previous_probes = idle.probes;
            steps.push_back(std::move(idle));
        }
        driven.push_back(steps.back().driven);
    }
    primary.logic_.apply_forces(world_seconds, primary.world_, driven,
                                [&](std::uint64_t id) -> std::optional<unsigned> {
                                    for (auto* actor : actors)
                                        if (actor->actor_ == id)
                                            return actor->enter_lap();
                                    return {};
                                });
    for (std::size_t i = 0; i < actors.size(); ++i)
        if (actors[i]->deferred_before_) {
            steps[i].driven = driven[i];
            actors[i]->finish_tick(steps[i]);
            actors[i]->deferred_before_.reset();
        } else
            actors[i]->apply_driven(driven[i]);
}

void AiField::step(Player& primary, const RideInput& input) {
    if (serial_ != primary.run_serial())
        restart(primary);
    const auto dt = primary.contract().tick_seconds();
    elapsed_ += dt;
    ++frames_;
    for (const auto& member : members_)
        primary.logic_.rider_speed(member->rider->actor_, length(member->rider->rider().velocity));
    primary.field_tick_ = primary.defer_tick_ = primary.defer_observer_ = true;

    struct Restore {
        Player& primary;
        AiField& field;

        ~Restore() {
            primary.field_tick_ = primary.defer_tick_ = primary.defer_observer_ = false;
            primary.deferred_before_.reset();
            for (auto& member : field.members_) {
                member->rider->defer_tick_ = false;
                member->rider->deferred_before_.reset();
            }
        }
    } restore{primary, *this};

    primary.tick(input);
    const auto primary_before = primary.deferred_before_.value_or(primary.rider());
    if (serial_ != primary.run_serial())
        restart(primary);
    std::vector<Player*> actors{&primary};
    std::vector<AiPeer> peers{{primary.actor_, primary.rider().position, primary.rider().velocity}};
    for (const auto& member : members_) {
        actors.push_back(member->rider.get());
        peers.push_back({member->rider->actor_, member->rider->rider().position, member->rider->rider().velocity});
    }
    if (frames_ % 6 == 0)
        rank(primary);
    for (auto& member : members_) {
        auto& actor = *member->rider;
        actor.defer_tick_ = true;
        member->due = 0;
        if (!primary.run_.riding_allowed())
            continue;
        actor.run_.begin_tick(dt, true);
        if (member->placement != actor.placement_serial()) {
            member->input.placed();
            member->placement = actor.placement_serial();
        }
        AiContext context;
        context.id = actor.actor_;
        context.meter = actor.scoring().status().meter;
        context.peers = peers;
        for (std::size_t i = 0; i < standings_.size(); ++i)
            if (standings_[i].actor == actor.actor_) {
                context.place = unsigned(i);
                if (standings_.size() > 1) {
                    const auto ref = standings_[i ? i - 1 : 1].actor;
                    for (const auto& peer : peers)
                        if (peer.id == ref)
                            context.reference = peer;
                }
            }
        member->controls = member->input.step(actor.rider(), context, dt);
        actor.sample_input(member->controls);
        member->due = actor.clock_.advance(dt * member->input.status().time_scale);
        if (member->due)
            actor.tick(member->controls);
    }
    if (primary.run_.riding_allowed())
        separate(actors);
    force_step(primary, actors, dt);
    bool extra = false;
    for (auto& member : members_)
        if (member->due > 1) {
            member->rider->tick(member->controls);
            extra = true;
        }
    if (extra) {
        separate(actors);
        force_step(primary, actors, 0);
    }
    for (auto& member : members_) {
        auto& actor = *member->rider;
        actor.defer_tick_ = false;
        actor.interpolate_board_ = true;
        if (actor.previous_board_serial_ != actor.placement_serial_) {
            actor.previous_board_forward_ = actor.render_forward();
            actor.previous_board_up_ = actor.render_up();
            actor.previous_board_serial_ = actor.placement_serial_;
        }
    }
    if (primary.tick_observer_)
        primary.tick_observer_(primary, primary.placement_serial() == primary.previous_board_serial_ ? primary_before
                                                                                                     : primary.rider());
}
} // namespace openslope
