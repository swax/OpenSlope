#pragma once
#include "ai.hpp"

namespace openslope {
struct AiStanding {
    std::uint64_t actor = 0;
    const Player* rider = nullptr;
    double progress = 0, finish_time = 0;
    unsigned place = 0;
    bool finished = false;
};

class AiField {
public:
    AiField(Player& primary, unsigned count, std::shared_ptr<const AiNetwork> network = {});
    ~AiField();
    void step(Player& primary, const RideInput& input);
    void resize(Player& primary, unsigned count);
    void restart(Player& primary);
    unsigned size() const;
    Player& rider(std::size_t index);
    const Player& rider(std::size_t index) const;
    const AiStatus& control(std::size_t index) const;

    std::span<const AiStanding> standings() const { return standings_; }

    unsigned place() const { return primary_place_; }

private:
    friend class Player;
    struct Member;
    std::shared_ptr<const AiNetwork> network_;
    std::vector<std::unique_ptr<Member>> members_;
    std::vector<AiStanding> standings_;
    std::uint64_t serial_ = 0, frames_ = 0;
    unsigned next_start_ = 0, primary_place_ = 0;
    double elapsed_ = 0, total_ = 0;
    void add(Player& primary);
    void rank(Player& primary);
    void separate(std::span<Player* const> actors);
    void force_step(Player& primary, std::span<Player* const> actors, double world_seconds);
    std::optional<RecoveryPose> recovery(const Player& actor) const;
};
} // namespace openslope
