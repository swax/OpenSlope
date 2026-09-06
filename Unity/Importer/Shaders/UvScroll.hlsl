#ifndef OPENSLOPE_UV_SCROLL_INCLUDED
#define OPENSLOPE_UV_SCROLL_INCLUDED

// Exact fixed-60-Hz accumulation for SSX UVScroll. timing =
// (mode, active seconds, pause seconds, lifetime seconds). The return value is elapsed signed
// motion time; multiplying it by the importer's units/second speed reproduces native per-tick motion.
float UvDurationTicks(float seconds)
{
    return seconds > 0.0 ? max(ceil(seconds * 60.0 - 1e-4), 1.0) : 0.0;
}

float UvOdd(float value)
{
    return value - 2.0 * floor(value * 0.5);
}

// Sum min(i, activeTicks-i)/activeTicks for i=1..steps (mode 1's triangular envelope).
float UvEasePrefix(float steps, float activeTicks)
{
    steps = clamp(steps, 0.0, max(activeTicks - 1.0, 0.0));
    float half = floor(activeTicks * 0.5);
    float first = min(steps, half);
    float sum = first * (first + 1.0) * 0.5;
    float tailEnd = max(steps, half);
    float tailCount = tailEnd - half;
    sum += tailCount * activeTicks
         - (tailEnd * (tailEnd + 1.0) - half * (half + 1.0)) * 0.5;
    return sum / activeTicks;
}

float UvScrollElapsed(float timeSeconds, float4 timing)
{
    float ticks = floor(max(timeSeconds, 0.0) * 60.0 + 1e-4);
    if (timing.w > 0.0)
    {
        // Native decrements the lifetime countdown before applying each tick, so its final tick is silent.
        float lifetimeTicks = max(floor(timing.w * 60.0 + 0.5), 1.0);
        ticks = min(ticks, max(lifetimeTicks - 1.0, 0.0));
    }

    float active = UvDurationTicks(timing.y);
    float pause = UvDurationTicks(timing.z);
    if (active <= 0.0) return 0.0;

    float mode = floor(timing.x + 0.5);
    if (mode == 1.0)
    {
        float period = active + pause;
        float leg = floor(ticks / period);
        float remainder = ticks - leg * period;
        float total = UvEasePrefix(active - 1.0, active);
        float partial = UvEasePrefix(min(remainder, active - 1.0), active);
        return (UvOdd(leg) > 0.5 ? total - partial : partial) / 60.0;
    }

    if (mode == 2.0)
    {
        float moving = max(active - 1.0, 0.0);
        if (pause > 0.0)
        {
            float period = active + pause;
            float leg = floor(ticks / period);
            float remainder = ticks - leg * period;
            float partial = min(remainder, moving);
            return (UvOdd(leg) > 0.5 ? moving - partial : partial) / 60.0;
        }

        // With no pause, the active-interval boundary tick already moves in the reversed direction.
        if (ticks <= moving) return ticks / 60.0;
        float tail = ticks - moving;
        float block = floor(tail / active);
        float remainder = tail - block * active;
        float distance = moving + (UvOdd(block) > 0.5 ? -active + remainder : -remainder);
        return distance / 60.0;
    }

    // Mode 0 and unknown values retain direction. A pause suppresses the boundary and pause ticks.
    if (pause <= 0.0) return ticks / 60.0;
    float period = active + pause;
    float cycles = floor(ticks / period);
    float remainder = ticks - cycles * period;
    return (cycles * max(active - 1.0, 0.0) + min(remainder, max(active - 1.0, 0.0))) / 60.0;
}

#endif
