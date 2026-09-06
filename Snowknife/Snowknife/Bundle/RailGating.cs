using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>
/// Mode gating from the two retail leaf functions (Unity docs/026). <c>HideShowOff</c> identifies props and
/// grind rails present only in show-off mode; <c>HideRace</c> identifies props present only in race mode. The
/// mode entry points combine those leaves as follows: RaceMode calls HideShowOff, ShowoffMode calls HideRace,
/// and FreerideMode calls both. Keeping the two sets distinct lets the Unity settings board switch the exact
/// authored configuration at runtime. The functions are direct leaf scans by design; unrelated MainType 7/25
/// effects elsewhere in the graph are ordinary gameplay and must not become mode gates.
/// </summary>
public static class RailGating
{
    public sealed class Result
    {
        public HashSet<int> GatedSplines = new();        // HideShowOff MainType-25 Effect-0 targets
        public HashSet<int> HiddenInstances = new();     // HideShowOff MainType-7 targets: show-off-only props
        public HashSet<int> RaceHiddenInstances = new();// HideRace MainType-7 targets: race-only props
        public bool Any => GatedSplines.Count > 0 || HiddenInstances.Count > 0 || RaceHiddenInstances.Count > 0;
    }

    public static Result Load(string levelDir)
    {
        var r = new Result();
        var root = SsfLogic.Load(levelDir);

        var showoff = root?.Functions?.FirstOrDefault(f => f?.FunctionName == "HideShowOff");
        if (showoff?.Effects != null)
        {
            foreach (var e in showoff.Effects)
            {
                if (e == null) continue;
                if (e.MainType == SsfMainType.ToggleRail && e.Spline != null && e.Spline.Effect == 0) r.GatedSplines.Add(e.Spline.SplineIndex);
                else if (e.MainType == SsfMainType.ActOnInstance && e.Instance != null) r.HiddenInstances.Add(e.Instance.InstanceIndex);
            }
        }

        var race = root?.Functions?.FirstOrDefault(f => f?.FunctionName == "HideRace");
        if (race?.Effects != null)
        {
            foreach (var e in race.Effects)
                if (e?.MainType == SsfMainType.ActOnInstance && e.Instance != null)
                    r.RaceHiddenInstances.Add(e.Instance.InstanceIndex);
        }
        return r;
    }
}
