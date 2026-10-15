#include "openslope/player.hpp"
#include <set>
#include <stdexcept>

namespace openslope {
namespace {
Vec3 ease_up(Vec3 current, Vec3 target, double rate, double dt) {
    current = normalized(current);
    target = normalized(target);
    const auto angle = std::acos(std::clamp(dot(current, target), -1.0, 1.0));
    if (angle < 1e-9)
        return target;
    auto axis = cross(current, target);
    if (length(axis) < 1e-9)
        axis = cross(current, {1, 0, 0});
    if (length(axis) < 1e-9)
        axis = cross(current, {0, 0, 1});
    return normalized(rotate(current, normalized(axis), std::min(angle, rate * dt)));
}

double boost_cap(const RideContract& contract, double amount) {
    return amount > .666   ? contract.value("speed", "boostCap")
           : amount > .334 ? contract.value("speed", "defaultCap") * 1.1
                           : contract.value("speed", "defaultCap");
}

double carried_cap(const RideContract& contract, double current, double amount) {
    const auto target = boost_cap(contract, amount);
    return std::max(target, approach(current, target, contract.value("speed", "capDecay") * contract.tick_seconds()));
}
} // namespace

Player::Player(Terrain terrain, PlayTuning tuning)
    : terrain_(std::move(terrain)), world_(CollisionWorld::load(terrain_.map_root())),
      rails_(Rails::load(terrain_.map_root())), run_(CourseRun::load(terrain_.map_root(), RunMode::Freeride)),
      logic_(WorldLogic::load(terrain_.map_root())), course_recovery_(run_.paths()),
      clock_(contract_.tick_seconds(), contract_.max_catchup_ticks()),
      get_up_(PoseAnimation::get_up(terrain_.map_root())), tuning_(tuning) {
    if (!std::isfinite(tuning.charge_rate) || tuning.charge_rate <= 0 || !std::isfinite(tuning.brake_acceleration) ||
        tuning.brake_acceleration < 0 || !std::isfinite(tuning.flip_recovery_rate) || tuning.flip_recovery_rate <= 0 ||
        tuning.jump_stat > 255 || !std::isfinite(tuning.body_radius) || tuning.body_radius <= 0 ||
        tuning.body_radius > 2)
        throw std::runtime_error("Invalid desktop riding tuning");
    for (const auto value : {tuning.hard_landing_speed, tuning.unrideable_speed, tuning.settle_angular_speed,
                             tuning.settle_normal_speed, tuning.settle_hold})
        if (!std::isfinite(value) || value <= 0)
            throw std::runtime_error("Invalid crash/recovery tuning");
    for (const auto value : {tuning.tumble_ground_drag, tuning.tumble_air_drag})
        if (!std::isfinite(value) || value < 0)
            throw std::runtime_error("Invalid tumble damping");
    apply_world_actions();
    const auto spawn = terrain_.spawn();
    spawn_position_ = spawn.first;
    spawn_forward_ = spawn.second;
    reset();
}

void Player::release_inputs() {
    held_boost_ = 0;
    boost_engaged_ = false;
    jump_held_ = false;
    jump_edges_.clear();
    reset_held_ = false;
    mount_held_ = false;
    mount_pending_ = false;
    restart_held_ = false;
    restart_pending_ = false;
    spawn_held_ = spawn_pending_ = false;
    if (rider_.control == Control::Charge) {
        rider_.charge = 0;
        rider_.control = rider_.motion == Motion::Rail ? Control::OnRail
                         : rider_.grounded             ? Control::Cruise
                                                       : Control::Air;
    }
}

void Player::warp(Vec3 position, Vec3 forward, Vec3 velocity, Vec3 up) {
    if (!finite(position) || !finite(forward) || !finite(velocity) || !finite(up) || length(forward) < 1e-9 ||
        length(cross(forward, up)) < 1e-9)
        throw std::runtime_error("Invalid rider placement");
    teleport_pending_.reset();
    recovery_target_.reset();
    reset_age_ = reset_fade_in_ = 0;
    score_.lose(ScoreLoss::Reset);
    on_foot_ = false;
    ++placement_serial_;
    effects_.reset();
    boost_trail_.reset();
    get_up_.stop();
    settled_ = 0;
    tumble_velocity_ = {};
    rider_ = {};
    previous_contacts_.clear();
    contact_events_.clear();
    rider_.position = rider_.previous_position = position;
    rider_.velocity = velocity;
    rider_.forward = normalized(forward);
    rider_.board_up = normalized(project(up, rider_.forward));
    if (const auto hit = trace_ground(position + Vec3{0, 2, 0}, position - Vec3{0, 1, 0})) {
        rider_.normal = hit->normal;
        rider_.surface = hit->surface;
        rider_.contact_error = dot(position - hit->point, hit->normal);
        rider_.ground_instance = hit->instance;
        rider_.ground_object = hit->object;
        rider_.ground_velocity = hit->velocity;
        rider_.grounded = rider_.contact_error <= contract_.surface(hit->surface).threshold &&
                          dot(velocity - hit->velocity, hit->normal) <= contract_.value("contact", "separationSpeed");
    }
    rider_.smoothed_up = rider_.normal;
    const auto& s = contract_.surface(rider_.surface);
    rider_.bog = s.bog;
    rider_.budget = s.budget;
    rider_.lift = s.lift;
    rider_.speed_cap = contract_.value("speed", "defaultCap");
    rider_.motion = rider_.grounded ? Motion::Ground : Motion::Air;
    rider_.control = rider_.grounded ? Control::Cruise : Control::Air;
    flight_heading_ = normalized(project(velocity, {0, 1, 0}), normalized(project(forward, {0, 1, 0}), {0, 0, -1}));
    jump_cooldown_ = air_grace_ = rail_cooldown_ = 0;
    clock_.reset();
    release_inputs();
}

void Player::reset(bool manual) {
    if (manual) {
        recover_course(true);
        return;
    }
    score_.lose(ScoreLoss::Reset, manual ? .12 : 0);
    // Desktop drop-in: seed the surface fields, then land from one metre up.
    // Authored start-row selection is separate from this application policy.
    auto position = spawn_position_;
    if (const auto hit = trace_ground(position + Vec3{0, 2, 0}, position - Vec3{0, 10, 0}))
        position = hit->point;
    warp(position + Vec3{0, 1, 0}, spawn_forward_);
    if (start_on_foot_)
        start_on_foot();
}

void Player::configure_run(RunMode mode) {
    auto run = CourseRun::load(terrain_.map_root(), mode);
    if (mode == RunMode::Race && !run.finish())
        throw std::runtime_error("This map has no race finish route. Choose Freeride or Showoff.");
    run_ = std::move(run);
    rails_.reset();
    logic_.restart(mode);
    apply_world_actions();
    course_recovery_ = CourseRecovery(run_.paths());
    last_recovery_.reset();
    score_.reset();
    score_started_ = false;
    const auto spawn = run_.paths().start_pose().value_or(terrain_.spawn());
    spawn_position_ = spawn.first;
    spawn_forward_ = spawn.second;
    reset();
}

void Player::restart_run() {
    run_.restart();
    rails_.reset();
    logic_.restart(run_.status().mode, true);
    apply_world_actions();
    course_recovery_ = CourseRecovery(run_.paths());
    last_recovery_.reset();
    score_.reset();
    score_started_ = false;
    reset();
}

bool Player::recover_course(bool manual) { return request_course_recovery(manual, false); }

bool Player::request_course_recovery(bool manual, bool authored) {
    const auto phase = run_.status().phase;
    if (teleport_pending_ || recovery_target_ || phase == RunPhase::Finished || phase == RunPhase::Expired ||
        (!manual && !authored && !run_active() && !on_foot_))
        return false;
    const auto safe = [&](Vec3 point) {
        const auto hit = trace_ground(point + Vec3{0, 2, 0}, point - Vec3{0, 3, 0});
        return hit && hit->normal.y > .2 && hit->surface != 0 && hit->surface != 6 && hit->surface != 10 &&
               hit->surface != 17;
    };
    auto start = spawn_position_;
    if (const auto floor = trace_ground(start + Vec3{0, 2, 0}, start - Vec3{0, 10, 0}))
        start = floor->point;
    const auto target = course_recovery_.choose(rider_.position, {start, spawn_forward_}, safe);
    if (!target)
        return false;
    const auto hit = trace_ground(target->position + Vec3{0, 2, 0}, target->position - Vec3{0, 3, 0});
    if (!hit)
        return false;
    reset_camera_forward_ = camera_forward();
    score_.lose(ScoreLoss::Reset, manual ? .12 : 0);
    recovery_target_ = RecoveryPlacement{*target, hit->point, hit->normal, on_foot_};
    reset_age_ = reset_fade_in_ = 0;
    rider_.control = Control::ResetWarp;
    rider_.velocity = {};
    rider_.charge = rider_.release_remaining = rider_.release_snapshot = 0;
    held_boost_ = 0;
    jump_edges_.clear();
    get_up_.stop();
    return true;
}

void Player::finish_course_recovery() {
    const auto placement = *recovery_target_;
    const auto forward = normalized(project(placement.target.forward, placement.normal), placement.target.forward);
    warp(placement.point + Vec3{0, 1, 0}, forward, placement.target.forward * (30. / 3.6), placement.normal);
    if (placement.foot)
        start_on_foot();
    last_recovery_ = placement.target;
    reset_fade_in_ = .2;
}

void Player::sample_input(const RideInput& input) {
    if (!std::isfinite(input.steer) || !std::isfinite(input.posture) || !finite(input.walk_forward) ||
        !finite(input.room_offset) || length(input.room_offset) > 10 || !finite(input.vr.gaze) ||
        !std::isfinite(input.vr.spin) || std::abs(input.vr.spin) > 1)
        throw std::invalid_argument("Rider input must be finite");
    if (input.spawn_board && !spawn_held_)
        spawn_pending_ = true;
    spawn_held_ = input.spawn_board;
    if (input.mount && !mount_held_)
        mount_pending_ = true;
    mount_held_ = input.mount;
    if (input.run_restart && !restart_held_)
        restart_pending_ = true;
    restart_held_ = input.run_restart;
    if (input.jump != jump_held_) {
        if (jump_edges_.size() >= 16)
            throw std::runtime_error("Too many unconsumed jump edges");
        jump_edges_.push_back(input.jump);
        jump_held_ = input.jump;
    }
}

std::optional<Player::GroundContact> Player::trace_ground(Vec3 start, Vec3 end) const {
    std::optional<GroundContact> result;
    if (const auto hit = terrain_.intersect(start, end))
        result = GroundContact{hit->point, hit->normal, hit->t, hit->surface, {}};
    if (const auto hit = world_.ray(start, end, true); hit && (!result || hit->t < result->t))
        result = GroundContact{hit->point,  hit->normal,          hit->t, hit->surface, hit->instance,
                               hit->object, hit->surface_velocity};
    return result;
}

std::optional<Player::GroundContact> Player::probe(Vec3 position) const {
    const auto lateral = normalized(cross(rider_.normal, rider_.forward * double(rider_.lead)), {1, 0, 0});
    const auto base = position + lateral * rider_.slide;
    return trace_ground(base + rider_.normal * contract_.value("contact", "probeAbove"),
                        base - rider_.normal * contract_.value("contact", "probeBelow"));
}

void Player::enter_air() {
    rider_.pads.trick = 0;
    if (rider_.motion == Motion::Ground) {
        rider_.air_time = 0;
        flight_heading_ = normalized(project(rider_.forward * double(rider_.lead), {0, 1, 0}), flight_heading_);
    }
    rider_.grounded = false;
    rider_.ground_instance.reset();
    rider_.ground_object.reset();
    rider_.ground_velocity = {};
    if (!recovering())
        rider_.motion = Motion::Air;
    if (rider_.control == Control::Cruise)
        rider_.control = Control::Air;
}

void Player::crash(CrashCause cause, Vec3 normal) {
    if (rider_.control == Control::Wipeout)
        return;
    score_.lose(ScoreLoss::Crash, .1);
    // [Trailmap: 300-wipeout-triggers, 300-recovery] Save the carried frame,
    // cancel committed control, and retain linear momentum.
    recovery_camera_ = camera_forward();
    recovery_forward_ = normalized(project(render_forward(), rider_.normal), rider_.forward);
    const auto up = render_up(), forward = render_forward();
    const auto axis = normalized(cross(rider_.velocity, normal), normalized(cross(forward, normal), {1, 0, 0}));
    tumble_velocity_ = axis * std::clamp(length(rider_.velocity) * .18, 2.4, 8.0);
    rider_.forward = normalized(project(forward, up), forward);
    rider_.board_up = up;
    rider_.flip_degrees = 0;
    rider_.motion = Motion::Wipeout;
    rider_.control = Control::Wipeout;
    rider_.rail_spline.reset();
    rider_.crash_cause = cause;
    ++rider_.crashes;
    rider_.crash_age = rider_.crash_contact_age = rider_.recovery_height = rider_.recovery_standing = 0;
    settled_ = 0;
    rider_.charge = rider_.release_remaining = rider_.release_snapshot = 0;
    jump_edges_.clear();
    get_up_.stop();
}

void Player::begin_recovery() {
    // Relative application offset; this is independent of course respawn.
    const auto target = normalized(project(recovery_forward_, rider_.normal),
                                   normalized(project(recovery_camera_, rider_.normal), {0, 0, -1}));
    rider_.position += rider_.normal * .08 - target * .3;
    rider_.previous_position = rider_.position;
    get_up_forward_ = rider_.forward;
    get_up_up_ = rider_.board_up;
    rider_.motion = Motion::RecoverContact;
    rider_.control = Control::RecoverWait;
    rider_.flip_degrees = 0;
    get_up_.play();
    const auto pose = get_up_.pose();
    rider_.crouch = pose.crouch;
    rider_.recovery_height = pose.height;
    rider_.recovery_standing = pose.standing;
}

bool Player::update_recovery() {
    const auto dt = contract_.tick_seconds();
    if (rider_.control == Control::Wipeout) {
        rider_.crash_age += dt;
        rider_.crash_contact_age = rider_.grounded ? rider_.crash_contact_age + dt : 0;
        const auto angular = length(tumble_velocity_);
        if (angular > 1e-9) {
            const auto axis = tumble_velocity_ / angular;
            rider_.forward = normalized(rotate(rider_.forward, axis, angular * dt));
            rider_.board_up = normalized(project(rotate(rider_.board_up, axis, angular * dt), rider_.forward));
        }
        tumble_velocity_ *= std::exp(-(rider_.grounded ? tuning_.tumble_ground_drag : tuning_.tumble_air_drag) * dt);
        const bool stable = rider_.grounded &&
                            std::abs(dot(rider_.velocity, rider_.normal)) <= tuning_.settle_normal_speed &&
                            length(tumble_velocity_) <= tuning_.settle_angular_speed;
        settled_ = stable ? settled_ + dt : 0;
        const bool overdue = rider_.crash_age > 7 || rider_.crash_contact_age > 3;
        if (overdue && run_active() && recover_course(false))
            return false;
        if ((stable && settled_ >= tuning_.settle_hold) || (overdue && !run_active()))
            begin_recovery();
    } else if (rider_.control == Control::RecoverWait) {
        get_up_.tick(dt);
        const auto pose = get_up_.pose();
        rider_.recovery_standing = pose.standing;
        rider_.recovery_height = pose.height;
        rider_.crouch = pose.crouch;
        const auto target_up = normalized(rider_.normal),
                   target_forward = normalized(project(recovery_forward_, target_up), recovery_forward_);
        const auto up_angle = std::acos(std::clamp(dot(get_up_up_, target_up), -1., 1.)),
                   forward_angle = std::acos(std::clamp(dot(get_up_forward_, target_forward), -1., 1.));
        rider_.board_up = ease_up(get_up_up_, target_up, up_angle * pose.standing, 1);
        rider_.forward = normalized(
            project(ease_up(get_up_forward_, target_forward, forward_angle * pose.standing, 1), rider_.board_up),
            target_forward);
        // [Trailmap: 300-recovery] Clip event, never the crash-age clock.
        if (get_up_.take(PoseEvent::GetUpFinished)) {
            rider_.recovery_height = 0;
            rider_.recovery_standing = 1;
            rider_.control = rider_.grounded ? Control::Cruise : Control::Air;
            rider_.motion = rider_.grounded ? Motion::Ground : Motion::Air;
            ++rider_.recoveries;
        }
    }
    return true;
}

void Player::land(const GroundContact& hit) {
    const auto deck_up = render_up(), nose = normalized(project(rider_.forward, hit.normal), rider_.forward),
               travel = project(rider_.velocity - hit.velocity, hit.normal);
    const auto tilt = std::acos(std::clamp(dot(deck_up, hit.normal), -1.0, 1.0));
    const auto yaw =
        length(travel) > 1e-6 ? std::acos(std::clamp(std::abs(dot(normalized(travel), nose)), 0.0, 1.0)) : 0;
    const auto impact = -dot(rider_.velocity - hit.velocity, hit.normal);
    const bool unrideable = hit.surface == 6 || hit.surface == 10;
    const bool hard = !recovering() && (tilt >= pi / 2 || impact > tuning_.hard_landing_speed ||
                                        (unrideable && length(travel) > tuning_.unrideable_speed));
    rider_.landing_scale = recovering() ? 1 : contract_.landing_retention(tilt, yaw);
    rider_.velocity = hit.velocity + (rider_.velocity - hit.velocity) * rider_.landing_scale;
    if (length(travel) > .5)
        rider_.lead = dot(travel, nose) < 0 ? -1 : 1;
    // [Trailmap: 340-landing-seed] A swept hit seats at contact with zero
    // response error and preserves incoming normal velocity for ground response.
    rider_.position = hit.point;
    rider_.normal = hit.normal;
    rider_.surface = hit.surface;
    rider_.contact_error = 0;
    rider_.forward = nose;
    rider_.ground_instance = hit.instance;
    rider_.ground_object = hit.object;
    rider_.ground_velocity = hit.velocity;
    rider_.grounded = true;
    if (!recovering())
        rider_.motion = Motion::Ground;
    ++rider_.landings;
    if (rider_.control == Control::Air || rider_.control == Control::Launched)
        rider_.control = Control::Cruise;
    if (hard)
        crash(unrideable ? CrashCause::Unrideable : CrashCause::Landing, hit.normal);
    else if (!recovering())
        score_.land();
}

void Player::notify_tick(const Rider& before) {
    if (!reset_pending() && !teleport_pending_ && run_.status().phase == RunPhase::Running) {
        if (on_foot_) {
            for (const auto height : {.28, .825, 1.37}) {
                if (teleport_pending_)
                    break;
                const std::array<ProbeSphere, 1> from{{{before.position + Vec3{0, height, 0}, .28}}},
                    to{{{rider_.position + Vec3{0, height, 0}, .28}}};
                for (const auto& hit : world_.sweep(from, to)) {
                    dispatch_world_contact(hit, length(before.velocity));
                    if (teleport_pending_)
                        break;
                }
            }
        }
    }
    apply_world_actions();
    const bool placed = teleport_pending_.has_value();
    if (placed) {
        const auto [position, forward] = *teleport_pending_;
        teleport_pending_.reset();
        teleport(position, forward);
    }
    const auto dt = contract_.tick_seconds();
    BoostRider driven{0,
                      placed ? rider_.position : before.position,
                      rider_.position,
                      rider_.velocity,
                      !placed && run_.status().phase == RunPhase::Running && !reset_pending() && !recovering(),
                      rider_.tube_stage};
    logic_.apply_forces(dt, world_, std::span(&driven, 1), [&](std::uint64_t) -> std::optional<unsigned> {
        if (run_.status().mode == RunMode::Freeride || run_.status().passes <= 1)
            return {};
        run_.enter_lap_volume();
        return run_.status().remaining;
    });
    rider_.tube_stage = driven.stage;
    rider_.position = driven.position;
    rider_.velocity = driven.velocity;
    if (driven.snapped) {
        rider_.previous_position = rider_.position;
        ++placement_serial_;
        ++transport_placements_;
        boost_trail_.reset();
        previous_contacts_.clear();
    }
    if (driven.driven) {
        if (rider_.motion == Motion::Rail &&
            (driven.snapped || dot(rider_.velocity, rider_.normal) > contract_.value("contact", "separationSpeed")))
            leave_rail(.25);
        if (rider_.grounded && dot(rider_.velocity - rider_.ground_velocity, rider_.normal) >
                                   contract_.value("contact", "separationSpeed")) {
            if (on_foot_) {
                rider_.grounded = false;
                rider_.ground_instance.reset();
                rider_.ground_object.reset();
                rider_.ground_velocity = {};
                rider_.pads.trick = 0;
            } else
                enter_air();
        }
        if (!on_foot_ && (rider_.grounded || rider_.motion == Motion::Rail)) {
            rider_.speed_cap = carried_cap(contract_, rider_.speed_cap, rider_.pads.speed > 0 ? 1 : held_boost_);
            const auto relative = rider_.velocity - rider_.ground_velocity;
            const auto speed = length(relative);
            if (speed > rider_.speed_cap)
                rider_.velocity = rider_.ground_velocity + relative * (rider_.speed_cap / speed);
        }
    }
    apply_world_actions();
    course_recovery_.tick(contract_.tick_seconds());
    if ((rider_.grounded || rider_.motion == Motion::Rail) && !recovering() && rider_.surface != 0 &&
        rider_.surface != 6 && rider_.surface != 10 && rider_.surface != 17)
        course_recovery_.observe(rider_.position, camera_forward());
    run_.end_tick(rider_.position, placement_serial_);
    if (score_.status().active &&
        (run_.status().phase == RunPhase::Finished || run_.status().phase == RunPhase::Expired))
        score_.finish();
    const bool board_active =
        !on_foot_ && !reset_pending() && !recovering() && run_.status().phase == RunPhase::Running;
    const auto lateral = normalized(cross(rider_.normal, rider_.forward * double(rider_.lead)));
    const auto deck = rider_.position + rider_.smoothed_up * rider_.lift + lateral * rider_.slide +
                      rider_.normal * rider_.recovery_height;
    boost_trail_.step(game_frame_, {deck, render_forward(), render_up()}, board_active ? held_boost_ : 0,
                      score_.boost_amount(), board_active && rider_.pads.speed > 0);
    effects_.tick(placed ? rider_ : before, rider_, contract_.tick_seconds(),
                  [&](Vec3 position) -> std::optional<WakeContact> {
                      const auto n = normalized(rider_.normal);
                      if (const auto hit = trace_ground(position + n * .75, position - n * .75))
                          return WakeContact{hit->point, hit->normal, hit->surface};
                      return {};
                  });
    if (tick_observer_)
        tick_observer_(*this, placed ? rider_ : before);
}

void Player::teleport(Vec3 position, Vec3 forward) {
    const auto foot = on_foot_;
    const auto serial = placement_serial_;
    Vec3 up{0, 1, 0};
    if (const auto floor = trace_ground(position + Vec3{0, 2, 0}, position - Vec3{0, 3, 0})) {
        position = floor->point;
        up = floor->normal;
    }
    warp(position, normalized(project(forward, up), forward), {}, up);
    if (foot) {
        place_foot(position, forward, {});
        const auto right = normalized(cross(forward, {0, 1, 0}), {1, 0, 0});
        auto board = position - right * .7;
        Vec3 board_up = up;
        const auto floor = walk_ground(board + Vec3{0, 2, 0}, board - Vec3{0, 3, 0});
        if (floor) {
            board = floor->point;
            board_up = floor->normal;
        }
        loose_board_ = {board, board, {}, normalized(project(forward, board_up), forward), board_up, bool(floor), 1, 0};
        if (floor) {
            loose_board_.ground_object = floor->object;
            loose_board_.ground_velocity = floor->velocity;
        }
    }
    transport_placements_ += placement_serial_ - serial;
    ++teleports_;
}

void Player::dispatch_world_contact(const WorldContact& contact, double speed, std::optional<Vec3> support_normal) {
    if (!reset_pending() && !teleport_pending_ && run_.status().phase == RunPhase::Running &&
        logic_contacts_.insert(contact.instance).second) {
        const auto normal = support_normal.value_or(contact.normal);
        const auto normal_speed = std::abs(dot(rider_.velocity - contact.surface_velocity, normal));
        const bool supported =
            support_normal.has_value() || (rider_.grounded && rider_.ground_instance == contact.instance);
        logic_.contact(contact.instance, speed, true, fragile_contact_cost(normal_speed, normal, supported));
        apply_world_actions();
    }
}

bool Player::dispatch_fragile_ground(const GroundContact& contact) {
    if (!logic_.has_fragile_surfaces())
        return true;
    const auto flags = logic_.flags();
    if (contact.instance && (flags[*contact.instance] & WorldFragile)) {
        WorldContact hit;
        hit.instance = *contact.instance;
        hit.object = contact.object.value_or(0);
        hit.point = contact.point;
        hit.normal = contact.normal;
        hit.surface_velocity = contact.velocity;
        dispatch_world_contact(hit, length(rider_.velocity), contact.normal);
    }
    const std::array<ProbeSphere, 1> reach{{{contact.point, .3}}};
    for (const auto& hit : world_.sweep(reach, reach))
        if (logic_.flags()[hit.instance] & WorldFragile)
            dispatch_world_contact(hit, length(rider_.velocity), contact.normal);
    return !contact.instance || (logic_.flags()[*contact.instance] & WorldCollide) != 0;
}

void Player::apply_world_actions() {
    auto actions = logic_.take_actions();
    world_actions_.insert(world_actions_.end(), actions.begin(), actions.end());
    for (const auto& action : actions)
        switch (action.kind) {
        case WorldActionKind::Reset:
            if (action.rider)
                request_course_recovery(false, true);
            break;
        case WorldActionKind::Teleport:
            if (action.rider && !teleport_pending_ && !reset_pending() && run_.status().phase == RunPhase::Running)
                teleport_pending_ = logic_.teleport_destination(action.target, tuning_.rider_slot);
            break;
        case WorldActionKind::Multiplier:
            if (action.rider)
                score_.multiplier(unsigned(action.value));
            break;
        case WorldActionKind::SpeedBoost:
            if (action.rider)
                rider_.pads.request(false, action.value);
            break;
        case WorldActionKind::TrickBoost:
            if (action.rider)
                rider_.pads.request(true, action.value);
            break;
        case WorldActionKind::RailToggle:
            if (action.target < rails_.splines())
                rails_.enable(action.target, action.value != 0);
            break;
        case WorldActionKind::CourseSound:
        case WorldActionKind::MainSound: break;
        }
    world_.instance_flags(logic_.flags());
    world_.motion(logic_.motions(), contract_.tick_seconds());
}

bool Player::update_jump() {
    const auto dt = contract_.tick_seconds();
    if (rider_.control == Control::Charge)
        rider_.charge = approach(rider_.charge, 1, tuning_.charge_rate * dt);
    else if (rider_.control == Control::Release) {
        rider_.release_remaining = approach(rider_.release_remaining, 0, 13.33 * dt);
        rider_.charge = rider_.release_remaining;
        return rider_.release_remaining <= 1e-9;
    }
    return false;
}

void Player::leave_rail(double cooldown) {
    rider_.pads.trick = 0;
    rider_.motion = Motion::Air;
    rider_.grounded = false;
    rider_.ground_instance.reset();
    rider_.ground_object.reset();
    rider_.ground_velocity = {};
    rider_.rail_spline.reset();
    rider_.rail_spin = rider_.rail_spin_rate = 0;
    rider_.air_time = 0;
    ++rider_.rail_exits;
    rail_cooldown_ = cooldown;
    if (rider_.control == Control::OnRail)
        rider_.control = Control::Launched;
}

void Player::ride_rail(const RailHit& hit, const RideInput& input, const Rider& before) {
    // [Trailmap: 350-travel, 350-control] No friction or balance accumulator.
    const auto dt = contract_.tick_seconds();
    rider_.rail_spline = hit.spline;
    rider_.rail_segment = hit.segment;
    rider_.rail_parameter = hit.parameter;
    rider_.rail_age += dt;
    rider_.surface = rails_.surface(hit.spline);
    rider_.normal = hit.up;
    rider_.board_up = hit.up;
    rider_.smoothed_up = normalized(rider_.smoothed_up + hit.up * .5);
    rider_.flip_degrees = 0;
    const auto& s = contract_.surface(rider_.surface);
    const auto slew = contract_.value("contact", "surfaceFieldSlew") * dt;
    rider_.bog = approach(rider_.bog, s.bog, slew);
    rider_.budget = approach(rider_.budget, s.budget, slew);
    rider_.lift = approach(rider_.lift, s.lift, slew);
    const auto speed = length(rider_.velocity), along = dot(rider_.velocity, hit.tangent);
    if (std::abs(along) > 1e-7)
        rider_.rail_direction = along < 0 ? -1 : 1;
    const auto direction = double(rider_.rail_direction);
    const auto target = hit.tangent * (direction * speed);
    if (speed > 1e-9)
        rider_.velocity =
            normalized(rider_.velocity + (target - rider_.velocity) * std::min(1., 30 * dt), hit.tangent * direction) *
            speed;
    const auto quantized = std::abs(input.steer) > .25 ? (input.steer < 0 ? -1. : 1.) : 0.;
    const auto gain = (input.boost || rider_.pads.trick > 0) ? 1.6 : 1.;
    if (input.vr.enabled) {
        const auto turn =
            input.vr.stick  ? input.vr.spin * 90 * gain * dt * pi / 180
            : input.vr.head ? gaze_turn(input.vr.gaze, rider_.forward * double(rider_.lead), 90 * gain * dt * pi / 180)
                            : 0.;
        rider_.rail_spin += turn * 180 / pi;
        rider_.rail_spin_rate = turn / dt * 180 / pi;
        if (input.vr.stick)
            rider_.view_yaw += turn;
    } else {
        rider_.rail_spin_rate = approach(rider_.rail_spin_rate, quantized * 80 * gain, 75 * gain * dt);
        rider_.rail_spin = std::clamp(rider_.rail_spin + rider_.rail_spin_rate * dt, -80., 80.);
        if (std::abs(rider_.rail_spin) >= 80 && rider_.rail_spin * quantized > 0)
            rider_.rail_spin_rate = 0;
    }
    if (std::abs(rider_.rail_spin_rate) < 2 && (std::abs(input.steer) > .25 || std::abs(input.posture) > .25)) {
        const auto x = std::abs(input.steer) > .25 ? (input.steer < 0 ? -1. : 1.) : 0.,
                   y = std::abs(input.posture) > .25 ? (input.posture < 0 ? -1. : 1.) : 0.;
        rider_.rail_trick = int(std::floor((std::atan2(y, x) + 2 * pi) / (pi / 4) + .5)) % 8;
    }
    rider_.forward = normalized(rotate(hit.tangent * (direction * rider_.lead), hit.up, rider_.rail_spin * pi / 180));
    flight_heading_ = normalized(project(hit.tangent * direction, {0, 1, 0}), flight_heading_);
    rider_.position += hit.right * std::clamp(-hit.offset.y, -2.9, 2.9) + hit.up * std::clamp(-hit.offset.z, -2.9, 2.9);
    const bool launch = update_jump();
    if (launch) {
        rider_.velocity +=
            contract_.jump_impulse(hit.up, hit.tangent * direction, length(rider_.velocity),
                                   std::max(0., rider_.release_snapshot - rider_.release_remaining), tuning_.jump_stat);
        leave_rail(.35);
        rider_.control = Control::Launched;
        rider_.charge = 0;
        ++rider_.launches;
        jump_cooldown_ = .35;
        air_grace_ = contract_.value("pose", "orientationGrace");
    }
    score_.step(dt, ScoreMotion::Rail);
    const auto destination = rider_.position + rider_.velocity * dt;
    rider_.velocity +=
        hit.tangent *
        ((dot(Vec3{0, -9.8, 0}, hit.tangent) + (input.boost ? 24.508 * held_boost_ * direction : 0)) * dt);
    rider_.speed_cap = launch ? contract_.value("speed", "boostCap")
                              : carried_cap(contract_, rider_.speed_cap, rider_.pads.speed > 0 ? 1 : held_boost_);
    const auto updated = length(rider_.velocity);
    if (updated > rider_.speed_cap)
        rider_.velocity *= rider_.speed_cap / updated;
    if (!move_world(before, destination, false))
        return;
    const auto crouch = rider_.control == Control::Charge ? rider_.charge : .3;
    rider_.crouch = approach(rider_.crouch, crouch, 6 * dt);
    if (!finite(rider_.position) || !finite(rider_.velocity))
        reset();
    else if (run_active() && !recovering() && rider_.position.y < terrain_.bounds().min.y - 30)
        recover_course(false);
}

void Player::tick(const RideInput& input) {
    ++game_frame_;
    world_actions_.clear();
    logic_contacts_.clear();
    sample_input(input);
    const auto before_pose = rider_;
    const auto dt = contract_.tick_seconds();
    rider_.pads.tick(dt);
    const std::array<Vec3, 2> observers{rider_.position, world_view_.value_or(rider_.position + Vec3{0, 1.7, 0})};
    const std::array<CrowdActivity, 1> crowd_riders{
        {{rider_.position, 1, run_.status().phase == RunPhase::Running && !reset_pending()}}};
    logic_.tick(dt, length(rider_.velocity), observers, crowd_riders);
    apply_world_actions();
    if (on_foot_ && rider_.grounded && rider_.ground_object)
        rider_.position += world_.carry(*rider_.ground_object, rider_.position);
    rider_.previous_position = before_pose.position;
    jump_cooldown_ = std::max(0.0, jump_cooldown_ - dt);
    air_grace_ = std::max(0.0, air_grace_ - dt);
    rail_cooldown_ = std::max(0., rail_cooldown_ - dt);
    reset_fade_in_ = std::max(0., reset_fade_in_ - dt);
    if (restart_pending_) {
        restart_run();
        restart_held_ = input.run_restart;
        notify_tick(before_pose);
        return;
    }
    if (input.reset && !reset_held_) {
        reset(true);
        reset_held_ = true;
        notify_tick(before_pose);
        return;
    }
    reset_held_ = input.reset;
    if (spawn_pending_) {
        spawn_pending_ = false;
        recall_board(input.walk_forward);
    }
    if (mount_pending_) {
        mount_pending_ = false;
        const auto changed = interact_board(input.room_offset);
        mount_held_ = input.mount;
        if (changed) {
            jump_held_ = input.jump;
            jump_edges_.clear();
            notify_tick(before_pose);
            return;
        }
    }
    const auto running = run_.begin_tick(dt, !on_foot_);
    if (recovery_target_) {
        reset_age_ += dt;
        jump_edges_.clear();
        if (reset_age_ >= .8 - 1e-9) {
            finish_course_recovery();
            jump_held_ = input.jump;
            mount_held_ = input.mount;
            reset_held_ = input.reset;
            restart_held_ = input.run_restart;
        }
        notify_tick(before_pose);
        return;
    }
    if (!running) {
        jump_edges_.clear();
        rider_.velocity = {};
        notify_tick(before_pose);
        return;
    }
    if (!score_started_ && run_.status().mode != RunMode::Freeride && run_.status().phase == RunPhase::Running) {
        score_.start();
        score_started_ = true;
    }
    if (on_foot_) {
        boost_engaged_ = false;
        tick_foot(input, before_pose);
        notify_tick(before_pose);
        return;
    }
    if (!update_recovery()) {
        notify_tick(before_pose);
        return;
    }
    auto active = input;
    if (recovering())
        active = {};
    held_boost_ = active.boost ? score_.boost_amount() : 0;
    active.boost = held_boost_ > 0;
    if (active.boost && !boost_engaged_) {
        rider_.boost_end =
            tuning_.symmetric_deck && dot(rider_.forward, project(rider_.velocity, {0, 1, 0})) < 0 ? -1 : 1;
        world_actions_.push_back({WorldActionKind::MainSound,
                                  held_boost_ > .666   ? 120.
                                  : held_boost_ > .334 ? 121.
                                                       : 122.,
                                  0, rider_.position, true});
    }
    boost_engaged_ = active.boost;
    score_.spend(dt, active.boost);
    // Interpret edges against the last validated motion state. A press made
    // on the last ground frame must not be lost to this tick's crest discovery.
    while (!jump_edges_.empty()) {
        const auto down = jump_edges_.front();
        jump_edges_.pop_front();
        if (down &&
            ((rider_.grounded && rider_.control == Control::Cruise) ||
             (rider_.motion == Motion::Rail && rider_.control == Control::OnRail)) &&
            jump_cooldown_ <= 0) {
            rider_.control = Control::Charge;
            rider_.charge = 0;
        } else if (!down && rider_.control == Control::Charge) {
            rider_.release_snapshot = rider_.release_remaining = rider_.charge;
            rider_.control = Control::Release;
        }
    }
    if (!recovering() && !input.rail_exit && rail_cooldown_ <= 0) {
        if (const auto rail = rails_.nearest(rider_.position); rail) {
            const bool attached = rider_.motion == Motion::Rail;
            const auto blend = attached ? (rider_.rail_age < .6 ? 1. : 0.) : 1.;
            const bool past_end =
                (rail->parameter == 1 && dot(rider_.velocity, rail->tangent) > 0 && rail->offset.x > .001) ||
                (rail->parameter == 0 && dot(rider_.velocity, rail->tangent) < 0 && rail->offset.x < -.001);
            if (!past_end && rails_.accepts(*rail, !attached, blend)) {
                if (!attached) {
                    rider_.rail_direction = dot(rider_.velocity, rail->tangent) < 0 ? -1 : 1;
                    if (length(rider_.velocity) < 1e-7)
                        rider_.rail_direction = dot(rider_.forward * double(rider_.lead), rail->tangent) < 0 ? -1 : 1;
                    rider_.motion = Motion::Rail;
                    rider_.grounded = false;
                    rider_.ground_instance.reset();
                    rider_.ground_object.reset();
                    rider_.ground_velocity = {};
                    rider_.rail_age = rider_.air_time = 0;
                    rider_.rail_spin = rider_.rail_spin_rate = 0;
                    rider_.lean = rider_.slide = 0;
                    ++rider_.grinds;
                    if (rider_.control != Control::Charge && rider_.control != Control::Release)
                        rider_.control = Control::OnRail;
                } else if (rider_.rail_spline != rail->spline || rider_.rail_segment != rail->segment)
                    ++rider_.rail_transfers;
                ride_rail(*rail, active, before_pose);
                notify_tick(before_pose);
                return;
            }
        }
    }
    if (rider_.motion == Motion::Rail)
        leave_rail(input.rail_exit ? .25 : 0);
    auto hit = probe(rider_.position);
    bool just_landed = false;
    if (hit && rider_.grounded) {
        const auto error =
            dot(rider_.position +
                    normalized(cross(rider_.normal, rider_.forward * double(rider_.lead))) * rider_.slide - hit->point,
                hit->normal);
        if (error <= contract_.surface(hit->surface).threshold && !dispatch_fragile_ground(*hit))
            hit = probe(rider_.position);
    }
    if (hit) {
        if (hit->surface == 0 && run_active() && recover_course(false)) {
            notify_tick(before_pose);
            return;
        }
        const auto lateral = normalized(cross(rider_.normal, rider_.forward * double(rider_.lead)));
        const auto error = dot(rider_.position + lateral * rider_.slide - hit->point, hit->normal);
        rider_.normal = hit->normal;
        rider_.surface = hit->surface;
        rider_.ground_instance = hit->instance;
        rider_.ground_object = hit->object;
        rider_.ground_velocity = hit->velocity;
        if (rider_.grounded) {
            rider_.contact_error = error;
            // [Trailmap: 320-redirect] Redirect before separation and launch.
            // A small tangent floor prevents the standstill redirect feeding
            // vertical absorber oscillation into unpowered horizontal travel.
            const auto relative = rider_.velocity - hit->velocity;
            if (length(project(relative, hit->normal)) > .3)
                rider_.velocity = hit->velocity + contract_.redirect(relative, hit->normal, hit->surface);
            if (error > contract_.surface(hit->surface).threshold)
                enter_air();
        } else if (air_grace_ <= 0 && error <= 0 && dot(rider_.velocity - hit->velocity, hit->normal) < 0) {
            if (dispatch_fragile_ground(*hit)) {
                land(*hit);
                just_landed = true;
            } else
                enter_air();
        }
    } else if (rider_.grounded)
        enter_air();
    if (!recovering() && rider_.grounded && (rider_.surface == 6 || rider_.surface == 10) &&
        length(project(rider_.velocity - rider_.ground_velocity, rider_.normal)) > tuning_.unrideable_speed)
        crash(CrashCause::Unrideable, rider_.normal);
    if (recovering())
        active = {};
    rider_.smoothed_up = normalized(rider_.smoothed_up + rider_.normal * .5);
    // [Trailmap: 300-decoupled, 340-charge] Only charge entry needs ground;
    // an existing charge/release survives a crest or a missed contact probe.
    const bool launch = update_jump();
    const auto& s = contract_.surface(rider_.surface);
    const auto posture = std::clamp(active.posture, -1.0, 1.0);
    const auto steering_velocity = rider_.velocity - (rider_.grounded ? rider_.ground_velocity : Vec3{});
    if (active.vr.enabled && active.vr.head && !active.vr.stick)
        active.steer =
            gaze_carve(active.vr.gaze, steering_velocity, rider_.normal, rider_.forward * double(rider_.lead));
    rider_.lean =
        contract_.lean(rider_.lean, std::clamp(active.steer, -1.0, 1.0), length(steering_velocity), rider_.surface, dt);
    Vec3 acceleration;
    const bool ground = rider_.grounded;
    if (ground) {
        const auto relative_velocity = rider_.velocity - rider_.ground_velocity;
        const auto slew = contract_.value("contact", "surfaceFieldSlew") * dt;
        rider_.bog = approach(rider_.bog, s.bog, slew);
        rider_.budget = approach(rider_.budget, s.budget, slew);
        rider_.lift = approach(rider_.lift, s.lift, slew);
        rider_.slide =
            approach(rider_.slide,
                     -contract_.value("steering", "carveSlideScale") * rider_.lean *
                         std::min(1.0, length(relative_velocity) * contract_.value("steering", "carveSlideSpeedGate")),
                     contract_.value("steering", "carveSlideSlew") * dt);
        if (!just_landed && rider_.budget + rider_.contact_error < 0) {
            const auto push = std::min(contract_.value("contact", "pushoutCap"), -rider_.budget - rider_.contact_error);
            rider_.position += rider_.normal * push;
            rider_.velocity += rider_.normal * push;
            rider_.contact_error += push;
        }
        const auto normal_response = contract_.contact_response(
            s, rider_.contact_error, dot(relative_velocity, rider_.normal), rider_.bog, rider_.budget);
        const auto load = s.A / contract_.response("units", "centimetresPerMetre"),
                   capped = std::min(normal_response, contract_.response("bank", "loadCapMultiplier") * load),
                   theta = s.tilt_degrees * pi / 180 * rider_.lean;
        const auto forward = normalized(project(rider_.forward, rider_.normal), rider_.forward) * double(rider_.lead),
                   lateral = normalized(cross(rider_.normal, forward));
        acceleration = rider_.normal * (normal_response + capped - capped / std::cos(theta)) +
                       lateral * (capped * std::tan(theta)) + Vec3{0, -load, 0};
        const auto u = dot(relative_velocity, forward), w = dot(relative_velocity, lateral);
        const bool pad_thrust = rider_.pads.speed > 0 && length(project(relative_velocity, rider_.normal)) > 1e-6;
        const bool boosting = (active.boost || pad_thrust) && posture >= 0;
        const auto boost = boosting ? (pad_thrust ? 1 : held_boost_) : 0.0;
        acceleration +=
            forward * contract_.forward_resistance(s, u, rider_.contact_error, rider_.budget, rider_.charge, boost);
        acceleration += lateral * contract_.lateral_resistance(s.drag, u, w, rider_.lean, boost);
        if (posture < 0) {
            const auto tangent = project(relative_velocity, rider_.normal);
            const auto speed = length(tangent);
            if (speed > 1e-9)
                acceleration -= tangent / speed * std::min(tuning_.brake_acceleration * (-posture), speed / dt);
        } else if (!recovering()) {
            const auto deficit =
                std::clamp(s.target - length(relative_velocity), 0.0, contract_.value("speed", "cruiseDeficitMax"));
            const auto align = contract_.cruise_alignment(relative_velocity, rider_.forward, rider_.normal);
            const auto drive = align * deficit * s.multiplier * contract_.value("speed", "riderDrive");
            const auto window = contract_.value("speed", "boostLeanWindow");
            const auto thrust = boosting ? contract_.value("speed", "boostAcceleration") *
                                               std::clamp(1 - std::abs(rider_.lean) / window, 0.0, 1.0)
                                         : 0;
            acceleration += forward * (drive + thrust);
        }
        if (!recovering()) {
            const auto angle = std::acos(std::clamp(dot(rider_.board_up, rider_.normal), -1.0, 1.0));
            const auto rate = std::min(contract_.value("pose", "groundRateCapDeg") * pi / 180,
                                       contract_.value("pose", "groundCubicGain") * angle * angle * angle);
            rider_.board_up = ease_up(rider_.board_up, rider_.normal, rate, dt);
            rider_.flip_degrees = approach(rider_.flip_degrees, std::round(rider_.flip_degrees / 360) * 360,
                                           tuning_.flip_recovery_rate * dt);
        }
        if (rider_.control == Control::RecoverWait) {
            rider_.position -= rider_.normal * std::clamp(rider_.contact_error, -.0833, .0833);
            rider_.velocity = project(rider_.velocity, rider_.normal);
            acceleration = project(acceleration, rider_.normal);
        }
    } else {
        acceleration = {-rider_.velocity.x * contract_.value("gravity", "airHorizontalDrag"),
                        -contract_.value("gravity", rider_.velocity.y > 0 ? "airRising" : "airFalling"),
                        -rider_.velocity.z * contract_.value("gravity", "airHorizontalDrag")};
        const auto rate = contract_.value("steering", "airTurnRateDeg") *
                          ((active.boost || rider_.pads.speed > 0) ? 1.6 : 1),
                   spin = active.vr.enabled
                              ? (active.vr.stick  ? active.vr.spin * rate * dt
                                 : active.vr.head ? gaze_turn(active.vr.gaze, rider_.forward * double(rider_.lead),
                                                              rate * dt * pi / 180) *
                                                        180 / pi
                                                  : 0)
                              : std::clamp(active.steer, -1.0, 1.0) * rate * dt;
        if (active.vr.enabled && active.vr.stick)
            rider_.view_yaw += spin * pi / 180;
        rider_.forward = normalized(rotate(rider_.forward, {0, 1, 0}, spin * pi / 180));
        rider_.spin_degrees += spin;
        rider_.flip_degrees += posture * rate * dt;
        rider_.air_time += dt;
        if (!recovering())
            score_.step(dt, ScoreMotion::Air, spin, posture * rate * dt);
        if (!recovering()) {
            rider_.board_up =
                ease_up(rider_.board_up, {0, 1, 0}, contract_.value("pose", "airLevelRateDeg") * pi / 180, dt);
            if (rider_.velocity.y < 0) {
                if (const auto upcoming =
                        trace_ground(rider_.position,
                                     rider_.position + rider_.velocity * contract_.value("pose", "orientationGrace"));
                    upcoming && dot(render_up(), upcoming->normal) > .9)
                    rider_.board_up = ease_up(rider_.board_up, upcoming->normal,
                                              contract_.value("pose", "groundRateCapDeg") * pi / 180, dt);
            }
        }
        // Held air thrust follows the visible deck; pads never supply this force.
    }
    if (launch) {
        const auto relative = rider_.velocity - rider_.ground_velocity;
        const auto tangent = normalized(project(relative, rider_.normal), rider_.forward * double(rider_.lead));
        rider_.velocity += contract_.jump_impulse(rider_.normal, tangent, length(relative),
                                                  std::max(0.0, rider_.release_snapshot - rider_.release_remaining),
                                                  tuning_.jump_stat);
        enter_air();
        rider_.control = Control::Launched;
        rider_.charge = 0;
        ++rider_.launches;
        jump_cooldown_ = .35;
        air_grace_ = contract_.value("pose", "orientationGrace");
    }
    rider_.speed_cap = !rider_.grounded
                           ? contract_.value("speed", "boostCap")
                           : carried_cap(contract_, rider_.speed_cap, rider_.pads.speed > 0 ? 1 : held_boost_);
    const auto destination = rider_.position + rider_.velocity * dt;
    const auto air_delta = !ground && active.boost
                               ? air_boost_velocity(rider_.velocity, render_forward() * double(rider_.boost_end),
                                                    contract_.value("speed", "boostCap"), dt) -
                                     rider_.velocity
                               : Vec3{};
    rider_.velocity += acceleration * dt + air_delta;
    const auto support_velocity = rider_.grounded ? rider_.ground_velocity : Vec3{};
    const auto relative_velocity = rider_.velocity - support_velocity;
    const auto speed = length(relative_velocity);
    if (rider_.grounded && speed > rider_.speed_cap)
        rider_.velocity = support_velocity + relative_velocity * (rider_.speed_cap / speed);
    if (!move_world(before_pose, destination, !ground && !launch && air_grace_ <= 0)) {
        notify_tick(before_pose);
        return;
    }
    if (ground && !launch && !recovering()) {
        score_.step(dt, ScoreMotion::Ground);
        const auto forward = normalized(project(rider_.forward, rider_.normal), rider_.forward) * double(rider_.lead);
        const auto speed_now = length(rider_.velocity);
        const auto downhill = normalized(project(Vec3{0, -1, 0}, rider_.normal), forward);
        const auto slip = speed_now > 1e-6 ? dot(cross(rider_.velocity, forward), rider_.normal) / speed_now : 0;
        const auto yaw =
            contract_.heading_yaw(rider_.lean, contract_.heading_lead(rider_.lean, rider_.charge), slip, speed_now,
                                  dot(rider_.velocity, forward), dot(rider_.velocity, downhill), dt);
        rider_.forward = normalized(rotate(forward, rider_.normal, yaw)) * double(rider_.lead);
        if (active.vr.enabled && active.vr.stick)
            rider_.view_yaw += yaw * .25;
    }
    if (rider_.control != Control::RecoverWait) {
        const auto crouch = rider_.control == Control::Charge ? rider_.charge
                            : recovering()                    ? 1
                            : !rider_.grounded                ? .3
                            : posture > 0                     ? 1.0
                            : posture < 0                     ? .55
                                                              : 0.0;
        rider_.crouch = approach(rider_.crouch, crouch, (crouch > rider_.crouch ? 6 : 18) * dt);
    }
    if (!finite(rider_.position) || !finite(rider_.velocity))
        reset();
    else if (run_active() && !recovering() && rider_.position.y < terrain_.bounds().min.y - 30)
        recover_course(false);
    notify_tick(before_pose);
}

void Player::advance(double seconds, const RideInput& input) {
    sample_input(input);
    if (input.reset && !reset_held_) {
        reset(true);
        reset_held_ = true;
        return;
    }
    reset_held_ = input.reset;
    const auto ticks = clock_.advance(seconds);
    for (unsigned i = 0; i < ticks; ++i)
        tick(input);
}

std::vector<ProbeSphere> Player::volume(const Rider& pose, bool airborne, bool rail) const {
    // [Trailmap: 370-probe-volume, 370-probe-mask] An original pose profile,
    // pending character skeletons: pelvis, torso/head, paired limb chains and
    // four board spheres. Ground excludes the board spheres; air uses all.
    const auto forward = normalized(project(pose.forward, pose.board_up), pose.forward),
               right = normalized(cross(forward, pose.board_up));
    const auto nose = rotate(forward, right, -pose.flip_degrees * pi / 180);
    auto up = rotate(pose.board_up, right, -pose.flip_degrees * pi / 180);
    if (pose.motion == Motion::Ground)
        up = rotate(up, nose, -contract_.value("steering", "bankMaxDeg") * pi / 180 * pose.lean * pose.lead);
    up = normalized(up);
    const auto side = normalized(cross(nose, up));
    const auto lateral = normalized(cross(pose.normal, pose.forward * double(pose.lead)));
    const auto base =
        pose.position + pose.smoothed_up * pose.lift + lateral * pose.slide + pose.normal * pose.recovery_height;
    const auto bend = std::clamp(pose.crouch, 0.0, 1.0);
    const auto point = [&](Vec3 local) { return base + side * local.x + up * local.y + nose * local.z; };
    const double hips = .92 - .3 * bend, chest = 1.32 - .35 * bend, head = 1.65 - .4 * bend;
    std::vector<ProbeSphere> result{{point({0, hips, 0}), tuning_.body_radius}};
    result.push_back({point({0, chest, 0}), .25});
    result.push_back({point({0, head, 0}), .2});
    if (rail)
        return result; // [Trailmap: 350-probe] Body gate, torso/head only.
    for (const auto sign : {-1., 1.}) {
        result.push_back({point({sign * .25, chest - .05, 0}), .16});
        result.push_back({point({sign * .36, chest - .3, .05}), .13});
        result.push_back({point({sign * .42, chest - .55, .1}), .1});
    }
    for (const auto sign : {-1., 1.}) {
        result.push_back({point({sign * .15, hips, 0}), .2});
        result.push_back({point({sign * .17, .5 - .18 * bend, .12 * bend}), .2});
        result.push_back({point({sign * .18, .12, sign * .2}), .3});
    }
    if (airborne)
        for (const auto sign : {-1., 1.})
            for (const auto direction : {-1., 1.})
                result.push_back({point({sign * .18, .04, sign * .2 + direction * .3}), .16});
    return result;
}

bool Player::move_world(const Rider& before, Vec3 destination, bool landing_allowed) {
    if (teleport_pending_)
        return false;
    const bool airborne = !rider_.grounded;
    Rider start = before;
    double remaining = contract_.tick_seconds(), elapsed = 0;
    std::map<std::size_t, WorldContact> seen;
    std::map<std::size_t, CollisionResponse> responses;
    std::set<std::size_t> resolved;
    const auto collect = [&](const WorldContact& hit, double portion) {
        auto contact = hit;
        contact.t = elapsed + hit.t * portion;
        const auto old = seen.find(contact.instance);
        if (old == seen.end() || contact.t < old->second.t)
            seen[contact.instance] = contact;
        dispatch_world_contact(contact, length(before.velocity));
    };
    rider_.position = destination;
    for (unsigned pass = 0; pass < 8; ++pass) {
        const bool rail = rider_.motion == Motion::Rail;
        const auto initial = volume(start, airborne, rail), final = volume(rider_, airborne, rail);
        const auto hits = world_.sweep(initial, final);
        const auto support = [&](const WorldContact& contact) {
            return contact.surface >= 0 && contact.surface != 17 && dot(contact.normal, rider_.normal) > .5;
        };
        const WorldContact* solid = nullptr;
        for (const auto& contact : hits)
            if (contact.response && !support(contact) && !resolved.contains(contact.instance) &&
                (contact.depth > 1e-8 || dot(rider_.velocity - contact.surface_velocity, contact.normal) < -1e-8)) {
                solid = &contact;
                break;
            }
        auto floor = landing_allowed ? trace_ground(start.position, rider_.position) : std::nullopt;
        if (floor && dot(rider_.velocity - floor->velocity, floor->normal) >= 0)
            floor.reset();
        const auto stop = std::min(solid ? solid->t : 1.0, floor ? floor->t : 1.0),
                   portion = remaining / contract_.tick_seconds();
        for (const auto& contact : hits)
            if (contact.t <= stop + 1e-8) {
                collect(contact, portion);
                if (reset_pending() || teleport_pending_)
                    return false;
            }
        if (floor && (!solid || floor->t <= solid->t))
            dispatch_fragile_ground(*floor);
        if (teleport_pending_)
            return false;
        const auto flags = logic_.flags();
        if ((solid && !flags.empty() && !(flags[solid->instance] & WorldCollide)) ||
            (floor && floor->instance && !flags.empty() && !(flags[*floor->instance] & WorldCollide)))
            continue;
        if (floor && (!solid || floor->t <= solid->t)) {
            if (floor->surface == 0 && run_active() && recover_course(false))
                return false;
            land(*floor);
            break;
        }
        if (!solid)
            break;
        rider_.position = start.position + (rider_.position - start.position) * solid->t;
        const auto response = collision_response(*solid, rider_.velocity, render_up());
        responses[solid->instance] = response;
        resolved.insert(solid->instance);
        rider_.position += response.position_delta;
        rider_.velocity = response.velocity;
        if (response.impulse > 0 && solid->surface < 0)
            ++rider_.bounces;
        if (response.hard) {
            ++rider_.hard_impacts;
            crash(CrashCause::PropImpact, solid->normal);
        }
        elapsed += solid->t * portion;
        remaining *= 1 - solid->t;
        if (pass == 7 || remaining < 1e-10)
            break;
        start = rider_;
        rider_.position += rider_.velocity * remaining;
    }
    const auto stationary = volume(rider_, airborne, rider_.motion == Motion::Rail);
    for (const auto& contact : world_.sweep(stationary, stationary))
        if (!seen.contains(contact.instance)) {
            auto hit = contact;
            hit.t = 1;
            seen[hit.instance] = hit;
            dispatch_world_contact(hit, length(before.velocity));
            if (teleport_pending_)
                return false;
        }
    contact_events_.clear();
    for (const auto& [instance, contact] : seen) {
        const auto phase = previous_contacts_.contains(instance) ? ContactPhase::Stay : ContactPhase::Begin;
        if (phase == ContactPhase::Begin)
            ++rider_.world_contacts;
        const auto response = responses.find(instance);
        contact_events_.push_back(
            {contact, phase,
             response == responses.end() ? CollisionResponse{{}, rider_.velocity, 0, false} : response->second});
    }
    for (const auto& [instance, contact] : previous_contacts_)
        if (!seen.contains(instance))
            contact_events_.push_back({contact, ContactPhase::End, {{}, rider_.velocity, 0, false}});
    std::stable_sort(contact_events_.begin(), contact_events_.end(), [](const auto& a, const auto& b) {
        if (a.phase == ContactPhase::End || b.phase == ContactPhase::End)
            return a.phase != ContactPhase::End && b.phase == ContactPhase::End;
        return a.contact.t < b.contact.t;
    });
    previous_contacts_ = std::move(seen);
    return true;
}

Vec3 Player::camera_position(Vec3 desired) const {
    if (!finite(desired))
        throw std::runtime_error("Invalid camera position");
    const auto anchor = render_position() + Vec3{0, 1.4, 0}, delta = desired - anchor;
    const auto distance = length(delta);
    if (distance < 1e-8)
        return desired;
    double t = 1;
    if (const auto hit = terrain_.intersect(anchor, desired))
        t = std::min(t, hit->t);
    if (const auto hit = world_.ray(anchor, desired))
        t = std::min(t, hit->t);
    return anchor + delta * std::max(0.0, t - (t < 1 ? .15 / distance : 0));
}

Vec3 Player::render_position() const {
    if (on_foot_)
        return rider_.previous_position * (1 - clock_.alpha()) + rider_.position * clock_.alpha();
    const auto lateral = normalized(cross(rider_.normal, rider_.forward * double(rider_.lead)));
    return rider_.previous_position * (1 - clock_.alpha()) + rider_.position * clock_.alpha() +
           rider_.smoothed_up * rider_.lift + lateral * rider_.slide;
}

Vec3 Player::render_board_position() const {
    if (on_foot_)
        return loose_board_.previous * (1 - clock_.alpha()) + loose_board_.position * clock_.alpha();
    return render_position() + rider_.normal * rider_.recovery_height;
}

Vec3 Player::render_forward() const {
    if (on_foot_)
        return loose_board_.forward;
    const auto forward = normalized(project(rider_.forward, rider_.board_up), rider_.forward),
               right = normalized(cross(forward, rider_.board_up));
    return rotate(forward, right, -rider_.flip_degrees * pi / 180);
}

Vec3 Player::render_up() const {
    if (on_foot_)
        return loose_board_.up;
    const auto forward = normalized(project(rider_.forward, rider_.board_up), rider_.forward),
               right = normalized(cross(forward, rider_.board_up));
    auto up = rotate(rider_.board_up, right, -rider_.flip_degrees * pi / 180);
    if (rider_.motion == Motion::Ground)
        up = rotate(up, render_forward(),
                    -contract_.value("steering", "bankMaxDeg") * pi / 180 * rider_.lean * rider_.lead);
    return normalized(up);
}

Vec3 Player::camera_forward() const {
    if (recovery_target_)
        return reset_camera_forward_;
    if (on_foot_)
        return flight_heading_;
    if (recovering())
        return recovery_camera_;
    if (rider_.motion == Motion::Rail)
        return flight_heading_;
    return rider_.grounded ? normalized(project(rider_.forward * double(rider_.lead), {0, 1, 0}), flight_heading_)
                           : flight_heading_;
}
} // namespace openslope
