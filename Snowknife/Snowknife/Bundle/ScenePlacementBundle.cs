using System.Globalization;
using System.Numerics;
using Snowknife.Engine;
using Snowknife.Services;

namespace Snowknife.Bundle;

/// <summary>
/// The engine-agnostic PLACEMENT compute the Unity importer's AudioBuilder / ProbeBuilder consume rather than
/// derive, with the engine bindings left behind:
///   - Native audio: preserve retail ADL ExternalSounds type-0 point emitters, including their offsets, radii,
///     event/bank choice, and falloff selectors. SoundIndex group-3 routes suppress the older mat_crowd geometry
///     fallback; fixed group-6 environment events carry an explicit decoded-bank clip path.
///   - Light probes: de-duplicated avatar light-probe sample positions, one per unique instance cell on a
///     ProbeMinSpacing grid (X-negated mesh space). The importer places a LightProbeGroup at these; the SH
///     authoring + CPU bake (Unity SphericalHarmonicsL2 / Lightmapping) stay engine-side.
/// Both in SSX mesh space (X negated) - root-local, exactly as the importer placed them. See Unity docs/015 (audio),
/// Unity docs/unity/010 (object lighting). Skybox stays fully engine-side: its sky-fill / horizon-fog colours are derived
/// from the GPU-rendered cubemap (RenderToCubemap), which has no snowknife equivalent.
/// </summary>
public static class ScenePlacementBundle
{
    public sealed class Opts
    {
        public float CrowdClusterRadius = 12000f;   // SSX units (~120 m): mat_crowd cells within this merge into one stand
        public int CrowdMaxSources = 24;            // cap so a dense level can't emit dozens of voices
        public float ProbeMinSpacing = 150f;        // de-dupe grid spacing in raw SSX units
    }

    const string NativeCrowdKind = "native-crowd";
    const string NativeEnvironmentKind = "native-environment";

    // ---- crowd audio: native ADL emitters, with mat_crowd stand centroids as fallback ----------------------
    public static BundleManifest.AudioInfo? BuildAudio(string levelDir, Opts o)
    {
        string objPath = Path.Combine(levelDir, "Props.obj");
        var instances = SsxInstances.Load(levelDir);
        SoundIndexDocument? soundIndex = SoundIndexDocument.Load(levelDir);
        var info = new BundleManifest.AudioInfo();
        int[] externalTypes = new int[4]; int unsupportedTypes = 0;
        int nativeCrowd = 0, nativeEnvironment = 0;
        var dynamicSpecial = new SortedSet<int>();
        if (instances != null)
            for (int i = 0; i < instances.Count; i++)
            {
                var it = instances[i];
                if (it.Sounds?.ExternalSounds == null) continue;
                foreach (var sound in it.Sounds.ExternalSounds)
                {
                    if (sound.U0 >= 0 && sound.U0 < externalTypes.Length) externalTypes[sound.U0]++;
                    else unsupportedTypes++;

                    // Types 0 and 1 are maintained voices. The event takes one of three traced routes: Crowd
                    // 97..99; a fixed named group-6 environmental BNK; or the normal group-2/course-bank resolver.
                    // Only event 102 (the crowd name-chant) is still context-selected and stays excluded; 95/134
                    // resolve to a fixed traffic bank. Types 2/3 have no records in any of the 11 retail courses.
                    if ((sound.U0 != 0 && sound.U0 != 1) || sound.SoundIndex < 2 || sound.SoundIndex > 185) continue;
                    SoundIndexEvent? ordinaryRoute = soundIndex?.CollisionEvents
                        .GetValueOrDefault(sound.SoundIndex);
                    bool isCrowd = ordinaryRoute?.Group == 3;
                    string kind = isCrowd ? NativeCrowdKind : NativeEnvironmentKind;
                    string? clip = ordinaryRoute?.Clip;
                    string suffix;
                    if (isCrowd)
                    {
                        nativeCrowd++;
                        suffix = "Crowd";
                    }
                    else if (ExternalSoundCatalog.TryGetFixedBank(sound.SoundIndex, out string bank))
                    {
                        nativeEnvironment++;
                        clip = ExternalSoundCatalog.ClipPath(bank);
                        suffix = ExternalSoundCatalog.OutputBankName(bank);
                    }
                    else if (ExternalSoundCatalog.IsSpecialBankEvent(sound.SoundIndex))
                    {
                        dynamicSpecial.Add(sound.SoundIndex);
                        continue;
                    }
                    else
                    {
                        // Normal external events share the already-decoded course bank. Snowknife applies the
                        // same event-id -> group-2 route used for prop impacts, but keeps this source looping.
                        // The route and explicit WAV path come only from this map's extracted SoundIndex.
                        if (ordinaryRoute?.Group != 2) continue;
                        nativeEnvironment++;
                        suffix = "Event" + sound.SoundIndex;
                    }
                    float x = (it.Location != null && it.Location.Length >= 3 ? it.Location[0] : 0f) + sound.U2;
                    float y = (it.Location != null && it.Location.Length >= 3 ? it.Location[1] : 0f) + sound.U3;
                    float z = (it.Location != null && it.Location.Length >= 3 ? it.Location[2] : 0f) + sound.U4;
                    // Type 0 carries its audible radius in U5 and the falloff selector in U6. Type 1 is an
                    // oriented ellipsoid: three semi-axis radii (U5/U6/U7) about a unit axis (U8..U10) with the
                    // selector in U11, and the runtime drops any axis whose radius is 0. This point contract
                    // approximates it with the volume-equivalent sphere. Retail aspect ratios reach 11:1 (a 6 m
                    // fan region stretched to 68 m along one axis), so using the largest radius instead would
                    // make those emitters audible well outside the authored region.
                    float radius = sound.U0 == 1 ? EquivalentSphereRadius(sound.U5, sound.U6, sound.U7) : sound.U5;
                    float curve = sound.U0 == 1 ? sound.U11 : sound.U6;
                    // Retail's interactive ambient class is engine-fixed {16, 28, 57} (cars, fire hydrants,
                    // police cars): these loops start silent and are enabled forever by the first impact
                    // one-shot played on their owning instance [Trailmap: 420-audio-runtime].
                    bool hitGated = sound.SoundIndex is 16 or 28 or 57;
                    info.PlacedLoops.Add(new BundleManifest.PlacedLoopInfo
                    {
                        Name = (it.InstanceName ?? "inst" + i) + "_" + suffix,
                        Kind = kind,
                        Center = new[] { -x, y, z },
                        Radius = Math.Clamp(radius * 0.01f, 5, 250),
                        Sound = sound.SoundIndex,
                        Curve = Math.Clamp((int)MathF.Round(curve), 0, 5),
                        SoundClip = clip,
                        HitGated = hitGated ? true : null,
                        Owner = hitGated ? it.InstanceName : null,
                    });
                    if (!string.IsNullOrEmpty(sound.SoundClip))
                        info.PlacedLoops[^1].SoundClip = sound.SoundClip;
                }
            }
        bool hasNativeCrowd = nativeCrowd > 0;
        if (!File.Exists(objPath))
        {
            LogExternalSoundCensus(externalTypes, unsupportedTypes, nativeCrowd, nativeEnvironment, dynamicSpecial);
            return info.PlacedLoops.Count > 0 ? info : null;
        }

        // Gather the crowd faces' vertices in face order (deduped per OBJ vertex index, like the built mesh's
        // submesh), from VISIBLE instances only (matching the merged-mesh inclusion in PropsBundle).
        var pos = new List<Vector3>(1 << 16);   // all v lines (X negated); crowd faces index into this
        var crowdIdx = new List<int>();          // crowd triangle vertex indices (into pos)
        bool curVisible = true; bool curCrowd = false;

        foreach (var line in File.ReadLines(objPath))
        {
            if (line.Length < 2) continue;
            char c0 = line[0], c1 = line[1];
            if (c0 == 'v' && c1 == ' ')
            {
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 4) pos.Add(new Vector3(-PF(p[1]), PF(p[2]), PF(p[3])));
            }
            else if (c0 == 'o' && c1 == ' ')
            {
                curVisible = true;
                if (instances != null)
                {
                    int us = line.IndexOf("inst", StringComparison.Ordinal);
                    if (us >= 0)
                    {
                        int s = us + 4, e = s;
                        while (e < line.Length && line[e] >= '0' && line[e] <= '9') e++;
                        if (e > s && int.TryParse(line.AsSpan(s, e - s), out int n) && n >= 0 && n < instances.Count)
                            curVisible = instances[n].Visable;
                    }
                }
            }
            else if (c0 == 'u' && line.StartsWith("usemtl ", StringComparison.Ordinal))
            {
                // Prefix match: the OBJ tags crowd cells per-cell ("mat_crowd_c<NN>"); all of them are stand faces.
                curCrowd = line.Substring(7).Trim().StartsWith("mat_crowd", StringComparison.Ordinal);
            }
            else if (c0 == 'f' && c1 == ' ')
            {
                if (!curCrowd || !curVisible) continue;
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length < 4) continue;
                int v0 = ObjVert(p[1]);
                for (int k = 2; k < p.Length - 1; k++)
                {
                    int v1 = ObjVert(p[k]), v2 = ObjVert(p[k + 1]);
                    if (v0 >= 0 && v1 >= 0 && v2 >= 0) { crowdIdx.Add(v0); crowdIdx.Add(v1); crowdIdx.Add(v2); }
                }
            }
        }

        var centroids = !hasNativeCrowd && crowdIdx.Count > 0
            ? ClusterCrowd(pos, crowdIdx, o.CrowdClusterRadius, o.CrowdMaxSources) : new List<Vector3>();
        foreach (var c in centroids) info.CrowdCentroids.Add(BundleSpace.Xyz(c));

        LogExternalSoundCensus(externalTypes, unsupportedTypes, nativeCrowd, nativeEnvironment, dynamicSpecial);
        if (centroids.Count > 0 || info.PlacedLoops.Count > 0)
        {
            Log.Info(hasNativeCrowd
                ? $"  Audio: {nativeCrowd} native crowd + {nativeEnvironment} native environment emitter(s), geometry fallback suppressed."
                : $"  Audio: {centroids.Count} geometry crowd fallback centroid(s), {nativeEnvironment} native environment emitter(s).");
        }
        return centroids.Count > 0 || info.PlacedLoops.Count > 0 ? info : null;
    }

    // Radius of the sphere with the same volume as an ellipsoid of these semi-axes: the geometric mean of the
    // non-zero ones. A zero semi-axis means the runtime ignores that axis entirely, so it must not collapse the
    // product to zero.
    static float EquivalentSphereRadius(params float[] semiAxes)
    {
        double product = 1.0; int n = 0;
        foreach (float r in semiAxes) if (r > 0f) { product *= r; n++; }
        return n == 0 ? 0f : (float)Math.Pow(product, 1.0 / n);
    }

    static void LogExternalSoundCensus(int[] types, int other, int nativeCrowd, int nativeEnvironment,
        SortedSet<int> dynamicSpecial)
    {
        int total = other; foreach (int n in types) total += n;
        if (total == 0) return;
        Log.Info($"  ADL ExternalSounds: {total} record(s), types [0:{types[0]}, 1:{types[1]}, 2:{types[2]}, 3:{types[3]}, other:{other}]; " +
                          $"{nativeCrowd} crowd + {nativeEnvironment} environment emitter(s) exported" +
                          (dynamicSpecial.Count > 0 ? $"; dynamic event program(s) {string.Join(", ", dynamicSpecial)} skipped." : "."));
    }

    // Greedy-cluster the crowd vertices into stands (mirrors AudioBuilder.ClusterCrowd): each unseen vertex
    // joins the first cluster whose running-mean centroid is within radius, else seeds a new one; keep the
    // biggest maxSources clusters so a long wall can't spawn dozens of voices.
    static List<Vector3> ClusterCrowd(List<Vector3> verts, List<int> tris, float radius, int maxSources)
    {
        var seen = new HashSet<int>();
        var sums = new List<Vector3>();
        var counts = new List<int>();
        float r2 = radius * radius;

        foreach (int t in tris)
        {
            if (!seen.Add(t)) continue;
            Vector3 p = verts[t];
            int best = -1;
            for (int k = 0; k < sums.Count; k++)
            {
                Vector3 c = sums[k] / counts[k];
                if ((c - p).LengthSquared() <= r2) { best = k; break; }
            }
            if (best < 0) { sums.Add(p); counts.Add(1); }
            else { sums[best] += p; counts[best]++; }
        }

        var order = new List<int>();
        for (int k = 0; k < sums.Count; k++) order.Add(k);
        if (order.Count > maxSources) order.Sort((a, b) => counts[b].CompareTo(counts[a]));

        var centroids = new List<Vector3>();
        int n = Math.Min(maxSources, order.Count);
        for (int k = 0; k < n; k++) { int idx = order[k]; centroids.Add(sums[idx] / counts[idx]); }
        return centroids;
    }

    // ---- light probe positions: de-duped instance cells on a grid ----------------------------------------
    public static BundleManifest.ProbesInfo? BuildProbes(string levelDir, Opts o)
    {
        var instances = SsxInstances.Load(levelDir);
        if (instances == null || instances.Count == 0) return null;

        float q = MathF.Max(1f, o.ProbeMinSpacing);
        var seen = new HashSet<long>();
        var info = new BundleManifest.ProbesInfo { MinSpacing = q };
        foreach (var it in instances)
        {
            if (it.Location == null || it.Location.Length < 3) continue;
            float px = -it.Location[0], py = it.Location[1], pz = it.Location[2];   // mesh space (X negated)
            long key = ((long)RoundToInt(px / q) * 73856093)
                     ^ ((long)RoundToInt(py / q) * 19349663)
                     ^ ((long)RoundToInt(pz / q) * 83492791);
            if (!seen.Add(key)) continue;
            info.Positions.Add(new[] { px, py, pz });
        }
        if (info.Positions.Count == 0) return null;
        Log.Info($"  Probes: {info.Positions.Count} positions (from {instances.Count} instances, min spacing {q}).");
        return info;
    }

    // Match Unity's Mathf.RoundToInt (round-half-to-even, like Math.Round's default) so the grid keys - and
    // thus the de-duped position set - are bit-identical to the importer's ComputeProbes.
    static int RoundToInt(float f) => (int)MathF.Round(f);

    static int ObjVert(string tok)
    {
        int slash = tok.IndexOf('/');
        var span = slash < 0 ? tok.AsSpan() : tok.AsSpan(0, slash);
        return int.TryParse(span, out int vi) ? vi - 1 : -1;   // OBJ is 1-based
    }

    static float PF(string s) => float.Parse(s, CultureInfo.InvariantCulture);
}
