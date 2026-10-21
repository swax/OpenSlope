#include "openslope/player.hpp"
#include <stdexcept>

namespace openslope {
std::optional<Player::GroundContact> Player::walk_ground(Vec3 start, Vec3 end) const {
    std::optional<GroundContact> result;
    if (const auto hit = terrain_.intersect(start, end); hit && hit->normal.y > .1)
        result = GroundContact{hit->point, hit->normal, hit->t, hit->surface, {}};
    if (const auto hit = world_.ray(start, end); hit && hit->normal.y > .55 && (!result || hit->t < result->t))
        result = GroundContact{hit->point,  hit->normal,          hit->t, hit->surface, hit->instance,
                               hit->object, hit->surface_velocity};
    return result;
}

Vec3 Player::walk_move(Vec3 start, Vec3 destination, Vec3& velocity, double radius, double height,
                       std::vector<WorldContact>* contacts) const {
    // Application walker: separate sphere casts also test head/feet against boxes.
    // Positive-mass props block; triggers do not. There is no board bounce here.
    const auto offsets =
        std::array<double, 4>{radius, .65 * height, height < 1 ? .85 * height : height - .30, height - .16};
    for (unsigned pass = 0; pass < 6; ++pass) {
        std::optional<ShapeContact> closest;
        std::optional<WorldContact> world_hit;
        for (unsigned i = 0; i < offsets.size(); ++i) {
            const auto r = i == 3 ? .16 : radius;
            const std::array<ProbeSphere, 1> a{{{start + Vec3{0, offsets[i], 0}, r}}},
                b{{{destination + Vec3{0, offsets[i], 0}, r}}};
            for (const auto& hit : world_.sweep(a, b)) {
                if (!hit.response || hit.normal.y > .1 ||
                    (hit.depth <= 1e-7 && dot(destination - start, hit.normal) >= -1e-9))
                    continue;
                if (!closest || hit.t < closest->t) {
                    closest = hit;
                    world_hit = hit;
                }
            }
            if (const auto hit = terrain_.sweep(a[0].centre, b[0].centre, r);
                hit && hit->normal.y <= .1 && !(hit->depth <= 1e-7 && dot(destination - start, hit->normal) >= -1e-9) &&
                (!closest || hit->t < closest->t)) {
                closest = ShapeContact{hit->point, hit->normal, hit->t, hit->depth};
                world_hit.reset();
            }
        }
        if (!closest)
            break;
        if (contacts && world_hit)
            contacts->push_back(*world_hit);
        const auto delta = destination - start;
        start += delta * std::max(0., closest->t - .001);
        start += closest->normal * (std::max(0., closest->depth) + .001);
        const auto inward = std::min(0., dot(velocity, closest->normal));
        velocity -= closest->normal * inward;
        destination = start + project(delta * (1 - closest->t), closest->normal);
    }
    return destination;
}

void Player::place_foot(Vec3 position, Vec3 forward, Vec3 velocity, bool preserve_score) {
    if (!preserve_score)
        score_.lose(ScoreLoss::BoardReleased);
    rider_.view_yaw = 0;
    on_foot_ = true;
    foot_motion_.reset(length(project(velocity, {0, 1, 0})) > FootMotion::run_speed);
    ++placement_serial_;
    effects_.reset();
    get_up_.stop();
    settled_ = 0;
    rider_.position = rider_.previous_position = position;
    rider_.velocity = velocity;
    rider_.forward = flight_heading_ = normalized(project(forward, {0, 1, 0}), {0, 0, -1});
    rider_.board_up = rider_.smoothed_up = {0, 1, 0};
    rider_.normal = {0, 1, 0};
    rider_.motion = Motion::OnFoot;
    rider_.control = Control::OnFoot;
    rider_.grounded = false;
    rider_.ground_instance.reset();
    rider_.ground_object.reset();
    rider_.ground_velocity = {};
    rider_.lean = rider_.slide = rider_.lift = rider_.crouch = 0;
    rider_.flip_degrees = rider_.spin_degrees = rider_.charge = rider_.release_remaining = rider_.release_snapshot = 0;
    rider_.rail_spline.reset();
    rider_.rail_spin = rider_.rail_spin_rate = 0;
    rider_.crash_cause = CrashCause::None;
    rider_.recovery_height = 0;
    if (const auto hit = walk_ground(position + Vec3{0, .08, 0}, position - Vec3{0, .08, 0}); hit && velocity.y <= 0) {
        rider_.position.y = rider_.previous_position.y = hit->point.y;
        rider_.normal = hit->normal;
        rider_.surface = hit->surface;
        rider_.ground_instance = hit->instance;
        rider_.ground_object = hit->object;
        rider_.ground_velocity = hit->velocity;
        rider_.grounded = true;
    }
    previous_contacts_.clear();
    contact_events_.clear();
    walk_phase_ = 0;
    clock_.reset();
    release_inputs();
    latch_reset_contacts();
}

void Player::start_on_foot() {
    start_on_foot_ = true;
    const auto heading = camera_forward();
    auto position = rider_.position;
    if (const auto hit = walk_ground(position + Vec3{0, 2, 0}, position - Vec3{0, 10, 0}))
        position = hit->point;
    loose_board_ = {position, position, {}, normalized(project(heading, {0, 1, 0}), {0, 0, -1}), {0, 1, 0}, true, 1, 0};
    if (const auto hit = walk_ground(position + Vec3{0, .1, 0}, position - Vec3{0, .1, 0})) {
        loose_board_.ground_object = hit->object;
        loose_board_.ground_velocity = hit->velocity;
        loose_board_.up = hit->normal;
        loose_board_.forward = normalized(project(heading, hit->normal), loose_board_.forward);
    }
    const auto right = normalized(cross(heading, {0, 1, 0}));
    auto feet = position;
    for (const auto offset : std::array<Vec3, 4>{-right * .7, right * .7, -heading * .7, heading * .7}) {
        const auto candidate = position + offset;
        const auto floor = walk_ground(candidate + Vec3{0, .4, 0}, candidate - Vec3{0, 1, 0});
        if (!floor)
            continue;
        auto target = floor->point;
        Vec3 velocity{};
        const auto resolved = walk_move(target, target, velocity);
        if (length(resolved - target) < .01) {
            feet = target;
            break;
        }
    }
    place_foot(feet, heading);
}

bool Player::recall_board(Vec3 facing) {
    if (!finite(facing))
        throw std::invalid_argument("Invalid board recall heading");
    if (!on_foot_ || reset_pending() || recovering())
        return false;
    const auto forward = normalized(project(facing, {0, 1, 0}), camera_forward());
    auto position = rider_.position + forward;
    Vec3 up{0, 1, 0};
    const auto floor = walk_ground(position + Vec3{0, 2, 0}, position - Vec3{0, 10, 0});
    if (floor) {
        position = floor->point;
        up = floor->normal;
    }
    carry_.clear();
    score_.release_grab();
    holding_hand_ = {};
    loose_board_ = {position, position, {}, normalized(project(forward, up), forward), up, bool(floor), 1, 0};
    if (floor) {
        loose_board_.ground_object = floor->object;
        loose_board_.ground_velocity = floor->velocity;
    }
    return true;
}

double Player::board_distance(Vec3 room_offset) const {
    return on_foot_ ? length(rider_.position + project(room_offset, {0, 1, 0}) - loose_board_.position) : 0;
}

bool Player::interact_board(Vec3 room_offset) {
    if (!finite(room_offset) || length(room_offset) > 10)
        throw std::invalid_argument("Invalid room offset");
    if (recovering() || reset_pending())
        return false;
    if (on_foot_) {
        if (carry_.held())
            return equip_held_board();
        if (board_distance(room_offset) > 1.6)
            return false;
        const auto board = loose_board_;
        mount_board(board.position, board.forward, board.velocity + (board.grounded ? board.ground_velocity : Vec3{}),
                    board.up);
        rider_.lead = board.lead;
        return true;
    }
    return dismount_board(false);
}

bool Player::dismount_board(bool preserve_score) {
    if (!preserve_score) {
        run_.abandon();
        score_.reset();
        score_started_ = false;
        run_active_ = false;
        ++run_serial_;
    }
    const auto position = render_board_position(), forward = render_forward(), up = render_up(),
               heading = camera_forward();
    const auto velocity = rider_.velocity;
    const bool grounded = rider_.grounded;
    const auto lead = rider_.lead;
    loose_board_ = {position,
                    position,
                    grounded ? velocity - rider_.ground_velocity : velocity,
                    forward,
                    up,
                    grounded,
                    lead,
                    0,
                    rider_.ground_object,
                    rider_.ground_velocity};
    auto feet = position;
    if (grounded) {
        const auto right = normalized(cross(heading, {0, 1, 0}));
        const auto candidate = feet - right * .7;
        if (const auto floor = walk_ground(candidate + Vec3{0, .4, 0}, candidate - Vec3{0, 1, 0})) {
            Vec3 test = velocity;
            const auto resolved = walk_move(floor->point, floor->point, test);
            if (length(resolved - floor->point) < .01)
                feet = floor->point;
        }
    }
    place_foot(feet, heading, velocity, preserve_score);
    return true;
}

void Player::tick_foot(const RideInput& input, const Rider& before) {
    const auto dt = contract_.tick_seconds();
    if (!carry_.held())
        tick_loose_board();
    bool jump = false;
    while (!jump_edges_.empty()) {
        jump |= jump_edges_.front();
        jump_edges_.pop_front();
    }
    const auto heading = normalized(project(input.walk_forward, {0, 1, 0}), flight_heading_),
               right = normalized(cross(heading, {0, 1, 0}));
    auto wish = heading * std::clamp(input.posture, -1., 1.) - right * std::clamp(input.steer, -1., 1.);
    if (length(wish) > 1)
        wish = normalized(wish);
    const auto carried = rider_.grounded ? rider_.position - before.position : Vec3{};
    const auto support = rider_.grounded ? carried / dt : Vec3{};
    const bool was_grounded = rider_.grounded;
    const auto direction = carry_.held() ? carry_.pose().forward : input.flight_direction;
    const auto crouch_target = foot_motion_.flying() ? 0. : input.crouch ? 1. : 0.;
    auto crouch = approach(rider_.crouch, crouch_target, dt * 6);
    if (crouch < rider_.crouch) {
        Vec3 test_velocity{};
        if (length(walk_move(rider_.position, rider_.position, test_velocity, .28, 1.65 - .35 * crouch) -
                   rider_.position) > .001)
            crouch = rider_.crouch;
    }
    rider_.crouch = crouch;
    rider_.velocity = foot_motion_.step(rider_.velocity - support, rider_.grounded,
                                        {heading, direction, -input.steer, input.posture, jump, input.jump, input.boost,
                                         input.crouch, carry_.held()},
                                        dt) +
                      support;
    carry_thrust_ = carry_.held() && foot_motion_.boosting();
    if (jump && was_grounded)
        ++rider_.launches;
    if ((jump && was_grounded) || foot_motion_.boosting())
        rider_.grounded = false;
    if (rider_.grounded) {
        rider_.velocity.y = support.y;
        rider_.ground_velocity = support;
    }
    auto destination = rider_.position + rider_.velocity * dt - carried;
    // Test the actual diagonal chord before the short destination floor probe.
    // Fast flight must land at the crossed slope, not beneath its far endpoint.
    if (!rider_.grounded)
        if (const auto hit = walk_ground(rider_.position, destination);
            hit && dot(rider_.velocity - hit->velocity, hit->normal) < 0 && dispatch_fragile_ground(*hit)) {
            destination = hit->point;
            rider_.velocity.y = hit->velocity.y;
            rider_.grounded = true;
        }
    auto floor = walk_ground(destination + Vec3{0, rider_.grounded ? .35 : 0, 0},
                             destination - Vec3{0, rider_.grounded ? .5 : .05, 0});
    bool seated =
        floor && rider_.velocity.y <= floor->velocity.y && (rider_.grounded || floor->point.y >= destination.y);
    if (!seated && was_grounded && !jump && !foot_motion_.boosting())
        if (const auto crossed = walk_ground(before.position + Vec3{0, .35, 0}, destination);
            crossed && dot(rider_.velocity - crossed->velocity, crossed->normal) < 0) {
            floor = crossed;
            destination = crossed->point;
            seated = true;
        }
    if (seated && !dispatch_fragile_ground(*floor)) {
        floor = walk_ground(destination + Vec3{0, rider_.grounded ? .35 : 0, 0},
                            destination - Vec3{0, rider_.grounded ? .5 : .05, 0});
        seated =
            floor && rider_.velocity.y <= floor->velocity.y && (rider_.grounded || floor->point.y >= destination.y);
    }
    if (seated)
        destination.y = floor->point.y;
    foot_contact_velocity_ = rider_.velocity;
    destination =
        walk_move(before.position, destination, rider_.velocity, .28, 1.65 - .35 * rider_.crouch, &foot_contacts_);
    if (seated) {
        const auto resting = walk_ground(destination + Vec3{0, .1, 0}, destination - Vec3{0, .1, 0});
        seated = bool(resting);
        if (resting) {
            destination.y = resting->point.y;
            rider_.normal = resting->normal;
            rider_.surface = resting->surface;
            rider_.ground_instance = resting->instance;
            rider_.ground_object = resting->object;
            rider_.ground_velocity = resting->velocity;
            rider_.velocity.y = resting->velocity.y;
        }
    }
    if (!seated) {
        if (const auto hit = walk_ground(rider_.position, destination);
            hit && rider_.velocity.y <= hit->velocity.y && dispatch_fragile_ground(*hit)) {
            destination = hit->point;
            rider_.normal = hit->normal;
            rider_.surface = hit->surface;
            rider_.ground_instance = hit->instance;
            rider_.ground_object = hit->object;
            rider_.ground_velocity = hit->velocity;
            rider_.velocity.y = hit->velocity.y;
            seated = true;
        } else {
            if (was_grounded && !jump && !foot_motion_.boosting())
                rider_.velocity.y -= FootMotion::gravity * dt;
            rider_.ground_instance.reset();
            rider_.ground_object.reset();
            rider_.ground_velocity = {};
        }
    }
    rider_.position = destination;
    rider_.grounded = seated;
    if (seated)
        foot_motion_.landed();
    if (!seated)
        rider_.pads.trick = 0;
    rider_.motion = Motion::OnFoot;
    rider_.control = Control::OnFoot;
    rider_.board_up = rider_.smoothed_up = {0, 1, 0};
    if (input.face_walk_forward)
        rider_.forward = flight_heading_ = heading;
    else if (length(wish) > .05)
        rider_.forward = normalized(wish);
    walk_phase_ += length(project(rider_.velocity, {0, 1, 0})) * dt * 5;
    contact_events_.clear();
    previous_contacts_.clear();
    if (!finite(rider_.position) || !finite(rider_.velocity) || rider_.position.y < terrain_.bounds().min.y - 40)
        reset();
}

void Player::tick_loose_board() {
    const auto dt = contract_.tick_seconds();
    auto& b = loose_board_;
    b.previous = b.position;
    b.age += dt;
    const auto old_forward = b.forward, old_up = b.up;
    if (b.thrown && length(b.spin) > 1e-8) {
        const auto axis = normalized(b.spin);
        const auto angle = length(b.spin) * dt;
        b.forward = normalized(rotate(b.forward, axis, angle));
        b.up = normalized(project(rotate(b.up, axis, angle), b.forward));
    }
    if (b.grounded && b.ground_object)
        b.position += world_.carry(*b.ground_object, b.position);
    const auto was_grounded = b.grounded;
    auto destination = b.position + (b.velocity + Vec3{0, b.grounded ? 0 : -18 * dt, 0}) * dt;
    if (b.thrown) {
        std::optional<ShapeContact> impact;
        for (auto local : std::array<Vec3, 5>{{{},
                                               {equipment_half_width, 0, equipment_half_length},
                                               {-equipment_half_width, 0, equipment_half_length},
                                               {equipment_half_width, 0, -equipment_half_length},
                                               {-equipment_half_width, 0, -equipment_half_length}}}) {
            const auto a = equipment_point({b.previous, old_forward, old_up}, local);
            const auto z = equipment_point({destination, b.forward, b.up}, local);
            if (const auto hit = terrain_.intersect(a, z); hit && (!impact || hit->t < impact->t))
                impact = ShapeContact{hit->point, hit->normal, hit->t, 0};
            const std::array<ProbeSphere, 1> start{{{a, .02}}}, end{{{z, .02}}};
            for (const auto& hit : world_.sweep(start, end))
                if (hit.response && (!impact || hit.t < impact->t))
                    impact = ShapeContact{hit.point, hit.normal, hit.t, hit.depth};
        }
        if (impact) {
            destination =
                b.previous + (destination - b.previous) * std::max(0., impact->t - .001) + impact->normal * .025;
            b.velocity = project(b.velocity, impact->normal);
            b.spin = {};
            b.thrown = false;
            if (impact->normal.y > .55) {
                destination.y = impact->point.y;
                b.up = impact->normal;
                b.forward = normalized(project(b.forward, b.up), {0, 0, -1});
                b.grounded = true;
            }
        }
    }
    const auto floor =
        walk_ground(destination + Vec3{0, b.grounded ? .25 : 0, 0}, destination - Vec3{0, b.grounded ? .5 : .03, 0});
    if (floor && b.velocity.y <= 0 && (b.grounded || floor->point.y >= destination.y)) {
        destination.y = floor->point.y;
        if (!was_grounded)
            b.velocity -= floor->velocity;
        b.ground_object = floor->object;
        b.ground_velocity = floor->velocity;
        b.up = floor->normal;
        b.forward = normalized(project(b.forward, b.up), b.forward);
        b.velocity = project(b.velocity, b.up);
        const auto speed = length(b.velocity);
        b.velocity = speed > .001 ? b.velocity * (std::max(0., speed - 3.5 * dt) / speed) : Vec3{};
        b.grounded = true;
        b.thrown = false;
        b.spin = {};
    } else if (const auto hit = walk_ground(b.position, destination); hit && b.velocity.y <= 0) {
        destination = hit->point;
        if (!was_grounded)
            b.velocity -= hit->velocity;
        b.ground_object = hit->object;
        b.ground_velocity = hit->velocity;
        b.up = hit->normal;
        b.forward = normalized(project(b.forward, b.up), b.forward);
        b.velocity = project(b.velocity, b.up);
        b.grounded = true;
        b.thrown = false;
        b.spin = {};
    } else {
        if (was_grounded)
            b.velocity += b.ground_velocity;
        b.ground_object.reset();
        b.ground_velocity = {};
        b.grounded = false;
        b.velocity.y -= 18 * dt;
        if (!b.thrown) {
            b.velocity.x *= 1 - .25 * dt;
            b.velocity.z *= 1 - .25 * dt;
        }
    }
    b.position = walk_move(b.previous, destination, b.velocity, .10, .25);
    if (b.grounded && length(b.velocity) < .02) {
        b.velocity = {};
        b.age = 0;
    }
    if (!finite(b.position) || !finite(b.velocity) || b.position.y < terrain_.bounds().min.y - 40) {
        if (const auto safe_floor = walk_ground(rider_.position + Vec3{0, 2, 0}, rider_.position - Vec3{0, 10, 0})) {
            b.position = b.previous = safe_floor->point;
            b.up = safe_floor->normal;
            b.forward = normalized(project(b.forward, b.up), normalized(cross(b.up, {1, 0, 0}), {0, 0, -1}));
        } else
            b.position = b.previous = rider_.position;
        b.velocity = {};
        b.spin = {};
        b.thrown = false;
        b.age = 0;
    }
}
} // namespace openslope
