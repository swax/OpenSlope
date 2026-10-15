#include "openslope/board_carry.hpp"
#include <stdexcept>

namespace openslope {
namespace {
void check(const EquipmentPose& p) {
    if (!finite(p.position) || !finite(p.forward) || !finite(p.up) || std::abs(length(p.forward) - 1) > 1e-4 ||
        std::abs(length(p.up) - 1) > 1e-4 || std::abs(dot(normalized(p.forward), normalized(p.up))) > 1e-4)
        throw std::invalid_argument("Invalid equipment frame");
}

void check(const EquipmentHand& h) {
    if (!h.valid || !finite(h.position) || !finite(h.right) || !finite(h.up) || !finite(h.forward) ||
        std::abs(length(h.right) - 1) > 1e-4 || std::abs(length(h.up) - 1) > 1e-4 ||
        std::abs(length(h.forward) - 1) > 1e-4 || length(cross(h.forward, h.up) - h.right) > 1e-4)
        throw std::invalid_argument("Invalid equipment hand");
}

Vec3 local(const EquipmentPose& p, Vec3 point) {
    const auto delta = point - p.position;
    return {dot(delta, normalized(cross(p.forward, p.up))), dot(delta, p.up), dot(delta, p.forward)};
}

Vec3 limited(Vec3 v, double cap) {
    const auto n = length(v);
    return n > cap ? v * (cap / n) : v;
}

Vec3 angular(const EquipmentPose& a, const EquipmentPose& b) {
    const std::array<Vec3, 3> old{normalized(cross(a.forward, a.up)), a.up, -a.forward},
        now{normalized(cross(b.forward, b.up)), b.up, -b.forward};
    std::array<double, 9> r{};
    for (unsigned row = 0; row < 3; ++row)
        for (unsigned col = 0; col < 3; ++col)
            for (unsigned i = 0; i < 3; ++i) {
                const std::array<double, 3> x{now[i].x, now[i].y, now[i].z}, y{old[i].x, old[i].y, old[i].z};
                r[row * 3 + col] += x[row] * y[col];
            }
    const auto angle = std::acos(std::clamp((r[0] + r[4] + r[8] - 1) / 2, -1., 1.));
    Vec3 skew{r[7] - r[5], r[2] - r[6], r[3] - r[1]};
    if (angle < 1e-8)
        return {};
    if (length(skew) > 1e-7)
        return normalized(skew) * angle;
    Vec3 axis;
    if (r[0] >= r[4] && r[0] >= r[8]) {
        axis.x = std::sqrt(std::max(0., (r[0] + 1) / 2));
        axis.y = (r[1] + r[3]) / (4 * axis.x);
        axis.z = (r[2] + r[6]) / (4 * axis.x);
    } else if (r[4] >= r[8]) {
        axis.y = std::sqrt(std::max(0., (r[4] + 1) / 2));
        axis.x = (r[1] + r[3]) / (4 * axis.y);
        axis.z = (r[5] + r[7]) / (4 * axis.y);
    } else {
        axis.z = std::sqrt(std::max(0., (r[8] + 1) / 2));
        axis.x = (r[2] + r[6]) / (4 * axis.z);
        axis.y = (r[5] + r[7]) / (4 * axis.z);
    }
    return normalized(axis, {1, 0, 0}) * angle;
}
} // namespace

EquipmentHand carry_hand(EquipmentHand grip) {
    if (!grip.valid)
        return grip;
    check(grip);
    return {grip.position, grip.forward, -grip.up, grip.right, true};
}

EquipmentHand grip_hand(EquipmentHand hand) {
    if (!hand.valid)
        return hand;
    check(hand);
    return {hand.position, hand.forward, -hand.up, hand.right, true};
}

Vec3 equipment_point(const EquipmentPose& pose, Vec3 p) {
    check(pose);
    return pose.position + normalized(cross(pose.forward, pose.up)) * p.x + pose.up * p.y + pose.forward * p.z;
}

Vec3 equipment_nearest(const EquipmentPose& pose, Vec3 p) {
    check(pose);
    if (!finite(p))
        throw std::invalid_argument("Invalid equipment query");
    auto q = local(pose, p);
    q.x = std::clamp(q.x, -equipment_half_width, equipment_half_width);
    q.y = std::clamp(q.y, equipment_height - equipment_half_height, equipment_height + equipment_half_height);
    q.z = std::clamp(q.z, -equipment_half_length, equipment_half_length);
    return equipment_point(pose, q);
}

double equipment_distance(const EquipmentPose& pose, const EquipmentHand& h) {
    check(h);
    const auto fist = h.position + h.up * .1;
    return length(fist - equipment_nearest(pose, fist));
}

std::optional<double> equipment_ray(const EquipmentPose& pose, const EquipmentRay& ray, double padding, double range) {
    check(pose);
    if (!ray.valid)
        return {};
    if (!finite(ray.origin) || !finite(ray.direction) || length(ray.direction) < 1e-9 || !std::isfinite(padding) ||
        padding < 0 || padding > 1 || !std::isfinite(range) || range < 0 || range > 100)
        throw std::invalid_argument("Invalid equipment ray");
    const auto origin = local(pose, ray.origin) - Vec3{0, equipment_height, 0},
               direction = local(pose, pose.position + normalized(ray.direction));
    const std::array<double, 3> o{origin.x, origin.y, origin.z}, d{direction.x, direction.y, direction.z},
        half{equipment_half_width + padding, equipment_half_height + padding, equipment_half_length + padding};
    double enter = 0, leave = range;
    for (unsigned i = 0; i < 3; ++i) {
        if (std::abs(d[i]) < 1e-12) {
            if (std::abs(o[i]) > half[i])
                return {};
            continue;
        }
        auto a = (-half[i] - o[i]) / d[i], b = (half[i] - o[i]) / d[i];
        if (a > b)
            std::swap(a, b);
        enter = std::max(enter, a);
        leave = std::min(leave, b);
        if (enter > leave)
            return {};
    }
    return enter;
}

bool equipment_summon(Vec3 head, Vec3 facing, Vec3 hand) {
    if (!finite(head) || !finite(facing) || !finite(hand))
        return false;
    const auto flat = project(facing, {0, 1, 0});
    if (length(flat) < 1e-6)
        return false;
    const auto delta = hand - head;
    return dot(delta, normalized(flat)) <= -.1 && length(delta) <= .55 && delta.y >= -.25;
}

EquipmentPose BoardCarry::attached(const EquipmentHand& at) const {
    const bool right = *hand_ == 1;
    EquipmentPose p;
    p.forward = at.right;
    p.up = -at.up;
    const auto edge = normalized(cross(p.forward, p.up)) * (right ? equipment_half_width : -equipment_half_width) +
                      p.up * equipment_height + p.forward * along_;
    const auto palm = at.position - at.up * .0381 + at.forward * (right ? .0508 : -.0508);
    p.position = palm - edge;
    return p;
}

void BoardCarry::grab(unsigned hand, const EquipmentHand& at, const EquipmentPose& deck, bool summon,
                      std::optional<Vec3> contact, bool ease) {
    if (hand > 1)
        throw std::invalid_argument("Invalid holding hand");
    check(at);
    check(deck);
    if (contact && !finite(*contact))
        throw std::invalid_argument("Invalid equipment contact");
    const auto along = summon
                           ? 0
                           : std::clamp(dot(contact.value_or(at.position + at.up * .1) - deck.position, deck.forward),
                                        -equipment_half_length, equipment_half_length);
    hand_ = hand;
    along_ = along;
    approach_ = ease && !summon ? .18 : 0;
    pose_ = approach_ > 0 ? deck : attached(at);
    velocity_ = spin_ = {};
    ready_ = false;
}

void BoardCarry::follow(const EquipmentHand& at, double seconds) {
    check(at);
    if (!std::isfinite(seconds) || seconds <= 0 || seconds > 1)
        throw std::invalid_argument("Invalid carry step");
    if (!hand_)
        return;
    const auto next = attached(at);
    if (approach_ > 0) {
        const auto blend = std::min(1., seconds / approach_);
        pose_.position += (next.position - pose_.position) * blend;
        pose_.forward = normalized(pose_.forward * (1 - blend) + next.forward * blend, next.forward);
        pose_.up = normalized(project(pose_.up * (1 - blend) + next.up * blend, pose_.forward), next.up);
        approach_ = std::max(0., approach_ - seconds);
        ready_ = false;
        return;
    }
    if (ready_) {
        const auto blend = 1 - std::exp(-seconds / .05);
        velocity_ += (limited((next.position - pose_.position) / seconds, 12) - velocity_) * blend;
        spin_ += (limited(angular(pose_, next) / seconds, 4 * pi) - spin_) * blend;
    }
    pose_ = next;
    ready_ = true;
}

EquipmentThrow BoardCarry::release(bool throw_motion) {
    EquipmentThrow result{pose_, throw_motion ? limited(velocity_, 12) : Vec3{},
                          throw_motion ? limited(spin_, 4 * pi) : Vec3{}};
    clear();
    return result;
}
} // namespace openslope
