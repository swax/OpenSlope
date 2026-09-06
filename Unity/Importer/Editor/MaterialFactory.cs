#if UNITY_EDITOR
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Builds one cached Unity material per source texture from the snowknife gltf's resolved material records.
    // The slot-name -> texture/flipbook/scroll RESOLUTION (and the Materials.json / Scroll.json / Flip.json /
    // crowd-frame tables it read) lives in snowknife (MaterialBundle -> manifest "Materials" section); this
    // just looks up the record by the glb prim's material-slot name and turns it into a Unity material asset,
    // applying alpha-cutout (via AlphaClassifier), UV scroll, flipbook and per-instance-lighting setup. See
    // docs/unity/005-materials-and-alpha.md (materials) and docs/008-texture-animation.md (animation) and Snowknife docs/034
    // (the bundle pipeline).
    public class MaterialFactory
    {
        public readonly struct ScrollSpec
        {
            public readonly Vector2 Speed;
            public readonly Vector4 Cycle;
            public ScrollSpec(Vector2 speed, Vector4 cycle) { Speed = speed; Cycle = cycle; }
        }

        readonly ImportConfig _cfg;
        readonly Shader _shader;
        readonly AlphaClassifier _alpha;

        readonly Dictionary<string, BundleManifestReader.MatRecord> _records;   // slot name -> snowknife's resolution
        readonly Dictionary<string, Material> _propCache = new Dictionary<string, Material>();
        readonly Dictionary<string, Material> _terrainCache = new Dictionary<string, Material>();

        public int PropMaterialCount => _propCache.Count;
        public int ScrollMaterialCount
        {
            get { int n = 0; foreach (var kv in _propCache) if (kv.Key.Contains("|scr")) n++; return n; }
        }

        public MaterialFactory(ImportConfig cfg, Shader shader, AlphaClassifier alpha)
        {
            _cfg = cfg; _shader = shader; _alpha = alpha;
            _records = new BundleManifestReader(cfg).Materials;   // resolved by snowknife; the importer only reads the resolved records
        }

        // ---- slot resolution ---------------------------------------------------
        // Look up the bundle's resolved record for a glb prim's material-slot name (terrain "0012.png"; prop
        // "mat_10" / "mat_108_scr0" / "mat_crowd"). All the table-reading is baked into the manifest by
        // snowknife's MaterialBundle. Unknown slot -> untextured.
        public void Resolve(string slotName, out string tex, out List<string> frames, out ScrollSpec? scroll, out float flipFps, out Vector2? dwell)
        {
            tex = null; frames = null; scroll = null; flipFps = 0f; dwell = null;
            if (_records != null && _records.TryGetValue(slotName, out var rec))
            {
                tex = rec.Texture;
                // A frame list is a STATE list; the effect is what animates it, and snowknife has already decided which
                // (docs/008). Only a record carrying a playback rate is a runtime flipbook: a Crowd record's frames are
                // the SHADER's texture-array source, a ride-over button's are the two states its pulse selects, and a
                // material whose frames no effect drives at all (glass intact/cracked, the start-light countdown, the
                // broken-LCD twins) just renders rec.Texture. Frames surface for the animated case only, so nobody
                // registers the rest with the Udon animator; state consumers read them through StateFrames instead.
                frames = (rec.Flipbook != null && rec.Flipbook.Count >= 2 && !rec.Crowd && rec.FlipFps > 0f) ? rec.Flipbook : null;
                if (rec.Scroll.HasValue && rec.ScrollCycle.HasValue)
                    scroll = new ScrollSpec(rec.Scroll.Value, rec.ScrollCycle.Value);
                else if (rec.Scroll.HasValue)
                    Debug.LogError("OpenSlope: scrolled material '" + slotName + "' has no required ScrollCycle in manifest.json; re-export/re-import the map.");
                if (frames != null) { flipFps = rec.FlipFps; dwell = rec.Dwell; }   // U4 pause screens: (dwellBase, flash)
            }
        }

        /// <summary>
        /// A slot's ordered STATE frames, whatever selects between them - false when the material has no frame list.
        /// Unlike <see cref="Resolve"/>'s frames (which surface only for a free-running flipbook, so nothing registers
        /// a static material with the Udon animator), this is the frames-as-data view a state consumer needs: the
        /// ride-over buttons' pulse (docs/008) reads it to swap in its second state for a moment on a crossing.
        /// </summary>
        public bool StateFrames(string slotName, out Texture2D[] frames)
        {
            frames = null;
            if (_records == null || !_records.TryGetValue(slotName, out var rec)) return false;
            if (rec.Flipbook == null || rec.Flipbook.Count < 2) return false;
            frames = LoadFrames(rec.Flipbook);
            return frames.Length >= 2;
        }

        // The shared CrowdBox slot ("mat_crowd")? Its material is shader-animated (BuildCrowd), not flipbooked.
        public bool IsCrowd(string slotName)
            => _records != null && _records.TryGetValue(slotName, out var rec) && rec.Crowd;

        // Load flipbook frame textures (in play order) from Textures/; skips any missing.
        public Texture2D[] LoadFrames(List<string> frames)
        {
            var list = new List<Texture2D>(frames.Count);
            foreach (var f in frames)
            {
                var t = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.LevelFolder + "/Textures/" + f);
                if (t != null) list.Add(t);
                else Debug.LogWarning("OpenSlope: flipbook frame not found " + f);
            }
            return list.ToArray();
        }

        // Cut-out foliage/fences/decals. NOT a hard binary clip: we clip only the fully-transparent HOLES
        // (a~0) and alpha-BLEND everything else, so the partial-alpha pixels these sheets carry actually
        // render - the perforated barrier panel is ~90% opaque and its hole rings are ~16%, all thrown away
        // by a clip(a-0.5). ZWrite stays ON: the sheet is mostly solid, so it must write depth to sort
        // against the world and itself (an alpha-blended foliage thicket with ZWrite off pops badly); drawn in
        // the AlphaTest queue (2450) after opaque geometry so the blend reads over an already-filled frame.
        // Pure-binary cutouts (no partial alpha) are unaffected - there's nothing between hole and solid to
        // soften. Same path for props and terrain. See docs/unity/005-materials-and-alpha.md.
        const float CutoutHoleCutoff = 0.05f;        // clip only near-zero (true hole) alpha; keep the soft band for coverage AA

        void ApplyCutout(Material mat, string texFile)
        {
            mat.EnableKeyword("_CUTOUT");
            mat.SetFloat("_UseCutout", 1f);
            mat.SetFloat("_Cutoff", CutoutHoleCutoff);
            // Alpha-to-coverage softens the clipped edge using MSAA samples - which VRChat renders with. An
            // opaque-pass SrcAlpha blend on the soft band instead composites against the wrong thing and loses
            // its blend on upload. Coverage handles the edge, so the blend stays opaque; the clip above still
            // removes true holes and is the fallback when MSAA is off.
            mat.SetFloat("_AlphaToMask", 1f);
            mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.One);   // 1  - opaque; coverage does the AA
            mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.Zero);  // 0
            mat.SetFloat("_ZWrite", 1f);                                                         // keep depth (sorting)
            mat.SetOverrideTag("RenderType", "TransparentCutout");
            mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.AlphaTest;                  // 2450
            _alpha.MarkCutout(texFile);
        }

        // ---- prop materials ----------------------------------------------------
        public Material Build(string texFile, List<string> frames, ScrollSpec? scroll, bool propLighting = false, bool directional = false, bool instanced = false)
        {
            // Flipbooks key on their whole frame list so two materials sharing only a first frame don't
            // collide, and identical flipbooks share one animated material. Scroll variants key on their
            // complete native profile so equal-speed effects with different timing stay distinct.
            // Directional (spinning-prop) variants key on "|dir" so a gem's real-time-lit material is a separate
            // cached asset from the same texture's flat static-prop material (docs/012).
            bool isFlip = frames != null && frames.Count >= 2;
            bool isScroll = scroll.HasValue;
            string scrollKey = isScroll
                ? "|scr" + VectorKey(scroll.Value.Speed) + "," + VectorKey(scroll.Value.Cycle)
                : "";
            string key = (isFlip ? "flip:" + string.Join("|", frames) : (texFile ?? "__none")) + scrollKey + (directional ? "|dir" : "") + (instanced ? "|inst" : "");
            if (_propCache.TryGetValue(key, out var hit)) return hit;

            string baseName = texFile != null ? Path.GetFileNameWithoutExtension(texFile) : "untextured";
            // A flipbook's asset NAME must distinguish frame SETS that share a first frame, or two different
            // flipbooks (same frame 0, different frame list - e.g. mat_15 [0027,0026x5] and mat_182
            // [0027,0026x6]) both write "flip_<frame0>.mat" and the second CreateAsset orphans the first. That
            // renderer slot then reloads as a null material (magenta), and the static chunker, seeing null, mistakes
            // the now-null flipbook for static geometry and bakes it into the chunks (spreading the magenta + killing
            // the flip). The cache KEY already carries the full frame list; mirror that uniqueness into the file name
            // with a short stable hash of the frames. Name still starts with "flip_" so the packer/chunker still
            // classify it as animated.
            string flipTag = isFlip ? "_" + FramesHash(frames) : "";
            string matName = (isFlip ? "flip_" : "mat_") + baseName + flipTag + (isScroll ? "_scr" + ScrollTag(scroll.Value) : "") + (directional ? "_dir" : "") + (instanced ? "_inst" : "");
            var mat = new Material(_shader) { name = matName, enableInstancing = true };

            // The scroll speed is already scaled (x ScrollSpeedScale) and V-negated by snowknife's MaterialBundle,
            // so set it straight - no per-tick conversion here.
            if (isScroll)
            {
                mat.SetVector("_ScrollSpeed", new Vector4(scroll.Value.Speed.x, scroll.Value.Speed.y, 0f, 0f));
                mat.SetVector("_ScrollCycle", scroll.Value.Cycle);
            }

            if (texFile != null)
            {
                var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.LevelFolder + "/Textures/" + texFile);
                if (tex != null) mat.mainTexture = tex;   // frame 0; the animator swaps it at runtime
                else Debug.LogWarning("OpenSlope: texture not found " + texFile);

                // Cut-out foliage/billboards/fences: clip the holes + blend the soft band (ApplyCutout) so they
                // don't render as boxy opaque quads. For a flipbook, clip if ANY frame holes. Cutout wins over
                // glow, glow over blend; only non-cutout uniformly-translucent textures (glass/water/LCD) take
                // the blend path.
                bool cutout = _alpha.IsCutout(texFile);
                if (isFlip) foreach (var f in frames) cutout |= _alpha.IsCutout(f);
                bool glow = !cutout && _alpha.IsGlow(texFile);
                if (isFlip && !cutout) foreach (var f in frames) glow |= _alpha.IsGlow(f);
                bool blend = !cutout && !glow && _alpha.IsBlend(texFile);
                if (isFlip && !cutout && !glow) foreach (var f in frames) blend |= _alpha.IsBlend(f);
                if (cutout)
                {
                    ApplyCutout(mat, texFile);
                }
                else if (glow)
                {
                    // Glow sheets - soft light-halo art (lamp starbursts, light-ray fans, light spill; snowknife's
                    // IsGlowSheet). The game state for these is the shared alpha object-mesh state: alpha-over
                    // blend + a low alpha test + z-write (170-materials.md) - the soft partial-alpha ramp IS the
                    // art, so it must BLEND (the cutout path's clip+coverage dithers it to a hard-edged star).
                    // Keep the low clip: most of the sheet is a fully-transparent background, and without the
                    // AREF-style hole clip those pixels would depth-write invisible walls over whatever draws
                    // later behind them.
                    mat.EnableKeyword("_CUTOUT");
                    mat.SetFloat("_UseCutout", 1f);
                    mat.SetFloat("_Cutoff", CutoutHoleCutoff);
                    mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);          // 5
                    mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);  // 10
                    mat.SetFloat("_ZWrite", 1f);
                    mat.SetOverrideTag("RenderType", "Transparent");
                    mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent; // 3000
                    _alpha.MarkGlow(texFile);
                }
                else if (blend)
                {
                    // Translucent glass/water/LCD signs: alpha-blend (SrcAlpha/OneMinusSrcAlpha), drawn in the
                    // Transparent queue after opaque/cutout geometry; the texture's own alpha (carried unchanged
                    // through frag) drives the blend, so opaque geometry behind it still shows through.
                    // ZWrite ON, matching the SSX engine, which drew these alpha object meshes with z-write
                    // enabled (the shared GS alpha-over + AREF=12 alpha-test state - 170-materials.md). Depth is
                    // what keeps them correct under our mesh combine: transparent prop submeshes are merged into
                    // one big combined mesh, and Unity sorts transparent draws per-renderer by that combined
                    // mesh's far centroid - so a near glass pane would otherwise paint over a separate prop that
                    // sits behind it (a breakable LCD board read in front of the crowd-stand glass roof). Writing
                    // depth restores per-pixel occlusion against both the world and other transparent renderers.
                    // EXCEPT for a page that draws only single-facing SHEETS (snowknife's manifest Sheet flag):
                    // a sheet has no far side of its own to occlude, and depth write there would let whichever of
                    // two stacked sheets draws first depth-reject the other - MESA's river is a fast layer over a
                    // slow one, and both must composite whichever side you view it from.
                    bool sheet = _alpha.IsSheet(texFile);
                    mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);          // 5
                    mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);  // 10
                    mat.SetFloat("_ZWrite", sheet ? 0f : 1f);
                    mat.SetOverrideTag("RenderType", "Transparent");
                    mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent; // 3000
                    _alpha.MarkBlend(texFile);
                }
            }

            if (propLighting)
            {
                // Static props already carry the exact three-key N.L result in COLOR. _PROPLIGHT makes
                // _LIGHTMAP multiply it in the PS2's byte/sRGB domain (record value 256 == 1.0), including
                // explicit linear<->sRGB conversion in Linear projects. Set keywords before CreateAsset.
                mat.EnableKeyword("_LIGHTMAP");
                mat.EnableKeyword("_PROPLIGHT");
                mat.SetFloat("_UseLightmap", 1f);
                mat.SetFloat("_UsePropLight", 1f);
                mat.SetFloat("_LightmapGain", _cfg.PropLightGain);
                mat.SetFloat("_LightmapStrength", _cfg.PropLightStrength);
                mat.SetFloat("_LightmapContrast", _cfg.PropLightContrast);
            }

            if (directional)
            {
                // Moving props carry native normals plus ambient, three keys and three fixed world directions.
                // The shader evaluates the retail three-term N.L equation every frame, then uses the same exact
                // byte/sRGB modulation as static props.
                mat.EnableKeyword("_DIRLIGHT");
                mat.EnableKeyword("_PROPLIGHT");
                // Instanced row (parking meters / pylons): amb/key arrive per-instance from a MaterialPropertyBlock
                // instead of the mesh's vertex colour, so one shared mesh GPU-instances while each copy lights itself (docs/012).
                if (instanced) mat.EnableKeyword("_DIRLIGHT_INST");
                mat.SetFloat("_UseDirLight", 1f);
                mat.SetFloat("_UsePropLight", 1f);
                mat.SetFloat("_LightmapGain", _cfg.PropLightGain);
                mat.SetFloat("_LightmapStrength", _cfg.PropLightStrength);
                mat.SetFloat("_LightmapContrast", _cfg.PropLightContrast);
            }

            AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/" + matName + ".mat");
            _propCache[key] = mat;
            return mat;
        }

        // ---- crowd material (docs/008) ------------------------------------------------------------------
        // The CrowdBox stands: ONE material whose shader (_CROWD) plays every grid cell's independent cheer
        // stream from _Time. The cd frames stack into a Texture2DArray (a slice per frame, dual-baked
        // DXT5/ASTC like the batching arrays so the per-platform swap applies); the cell identity the
        // schedule keys on rides the mesh's UV1, baked by snowknife. No Udon, no material instances, one
        // crowd draw - and it animates everywhere the shader runs, including a VRChat upload.
        public Material BuildCrowd(string slotName, bool propLighting = false)
        {
            string key = "crowd:" + slotName;
            if (_propCache.TryGetValue(key, out var hit)) return hit;

            var rec = (_records != null && _records.TryGetValue(slotName, out var r)) ? r : null;
            var frames = rec != null ? rec.Flipbook : null;
            var slices = (frames != null && frames.Count >= 2) ? LoadFrames(frames) : null;
            var arr = (slices != null && slices.Length == frames.Count)
                ? TextureArrayPacker.BuildDualArrays(new List<Texture2D>(slices), _cfg.MatFolder + "/TexArrays", "crowd", 0, needsAlpha: true)
                : null;
            if (arr == null)
            {
                // Missing frames or a failed array bake: a static frame-0 stand beats a magenta one.
                Debug.LogWarning("OpenSlope: crowd - cd frame array unavailable for '" + slotName + "'; using a static material.");
                var fb = Build(rec != null ? rec.Texture : null, null, null, propLighting);
                _propCache[key] = fb;
                return fb;
            }

            var mat = new Material(_shader) { name = "crowd", enableInstancing = true };
            // Keywords BEFORE CreateAsset (a keyword enabled after the .mat is written silently reverts on
            // the next domain reload - same rule as Build's _LIGHTMAP).
            mat.EnableKeyword("_CROWD");
            mat.SetFloat("_UseCrowd", 1f);
            mat.SetTexture("_MainTexArray", arr);
            mat.mainTexture = slices[0];   // inspector preview only; the shader samples the array

            // The people sheets are cutout billboards: clip the holes + coverage-AA the soft edges, exactly
            // like every other foliage/billboard sheet (Build's cutout path).
            bool cutout = false;
            foreach (var f in frames) cutout |= _alpha.IsCutout(f);
            if (cutout) ApplyCutout(mat, frames[0]);

            if (propLighting)
            {
                mat.EnableKeyword("_LIGHTMAP");
                mat.EnableKeyword("_PROPLIGHT");
                mat.SetFloat("_UseLightmap", 1f);
                mat.SetFloat("_UsePropLight", 1f);
                mat.SetFloat("_LightmapGain", _cfg.PropLightGain);
                mat.SetFloat("_LightmapStrength", _cfg.PropLightStrength);
                mat.SetFloat("_LightmapContrast", _cfg.PropLightContrast);
            }

            AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/crowd.mat");
            _propCache[key] = mat;
            return mat;
        }

        // ---- terrain materials -------------------------------------------------
        public Material BuildTerrain(string texFile, bool hasLightmap, Texture2D lmAtlas)
        {
            string key = texFile ?? "__none";
            if (_terrainCache.TryGetValue(key, out var hit)) return hit;

            string matName = "ter_" + (texFile != null ? Path.GetFileNameWithoutExtension(texFile) : "untextured");
            var mat = new Material(_shader) { name = matName, enableInstancing = true };

            if (texFile != null)
            {
                var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.LevelFolder + "/Textures/" + texFile);
                if (tex != null) mat.mainTexture = tex;
                else Debug.LogWarning("OpenSlope: terrain texture not found " + texFile);

                if (_alpha.IsCutout(texFile))
                    ApplyCutout(mat, texFile);
            }

            if (hasLightmap)
            {
                // Per-pixel lightmap atlas (RGBA: rgb = C_S, alpha = A_S): the shader reconstructs the game's
                // PS2 GS blend (C_D - C_S) x A_S per-pixel (_LIGHTMAP_GS) - full-resolution, tessellation-
                // independent, with the real coloured light (cool shadow / warm sun). The GS scales use the
                // shader's derived defaults (base x0.5, C_S x1, A_S x255/128). The vertex-colour path
                // (_LIGHTMAP) stays baked on the mesh as a fallback but is left OFF here.
                mat.EnableKeyword("_LIGHTMAP_GS");
                if (lmAtlas != null) mat.SetTexture("_LightmapTex", lmAtlas);
                mat.SetFloat("_LightmapStrength", 1f);
            }

            AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/" + matName + ".mat");
            _terrainCache[key] = mat;
            return mat;
        }

        // A readable, filesystem-safe profile tag plus a full-precision stable hash. The hash prevents two
        // profiles that only differ beyond the three displayed decimals from colliding on one .mat asset path.
        static string ScrollTag(ScrollSpec s)
        {
            string F(float v) => v.ToString("0.###", CultureInfo.InvariantCulture).Replace('-', 'n').Replace('.', 'p');
            return F(s.Speed.x) + "_" + F(s.Speed.y)
                + "_m" + F(s.Cycle.x) + "_a" + F(s.Cycle.y)
                + "_p" + F(s.Cycle.z) + "_l" + F(s.Cycle.w)
                + "_" + StableHash(VectorKey(s.Speed) + "," + VectorKey(s.Cycle));
        }

        static string VectorKey(Vector2 v)
            => v.x.ToString("R", CultureInfo.InvariantCulture) + "," + v.y.ToString("R", CultureInfo.InvariantCulture);

        static string VectorKey(Vector4 v)
            => v.x.ToString("R", CultureInfo.InvariantCulture) + "," + v.y.ToString("R", CultureInfo.InvariantCulture)
             + "," + v.z.ToString("R", CultureInfo.InvariantCulture) + "," + v.w.ToString("R", CultureInfo.InvariantCulture);

        // A short, DETERMINISTIC hash (FNV-1a, 8 hex) of a flipbook's frame list, so two flipbooks that share a
        // first frame don't collide on the same "flip_<frame0>.mat" asset path. Deterministic across editor
        // sessions (unlike string.GetHashCode under .NET Core) so re-imports produce byte-stable material names.
        static string FramesHash(List<string> frames)
            => StableHash(string.Join("|", frames));

        static string StableHash(string s)
        {
            uint h = 2166136261u;
            for (int i = 0; i < s.Length; i++) { h ^= s[i]; h *= 16777619u; }
            return h.ToString("x8");
        }
    }
}
#endif
