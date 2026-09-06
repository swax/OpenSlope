#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Rebuilds SSX's authored particle effects as camera-facing billboard quads. These are the
    // "Fog_*" volumes - the clouds on the start line (Fog_Sphere_A_0/1) plus the fog banks down the course.
    // The per-puff placement (centre + radius + sprite) comes from the snowknife gltf (manifest.Particles; see
    // Snowknife docs/034) - snowknife decoded the world placement (ParticleInstances.json) and each effect's puff cluster
    // (ParticleModels.json) into world-space puffs once; the importer just builds the billboard quad mesh +
    // material. The sprite art is decoded by `snowknife import` from the shared DATA\TEXTURES\PARTICLE.SSH bank
    // into Textures/Particles/ (fog0 = the soft fog blob), and snowknife picks the sprite per effect. Each puff
    // becomes a 4-vertex quad sharing one centre, with
    // its corner offset (world units) in UV1; the OpenSlope/Particle shader spreads the corners on the view plane so
    // the quad always faces the camera - no runtime script, so it works in a VRChat build / mirrors. One
    // GameObject per effect under Particles; every puff mesh is stored as a sub-asset of Particles.mesh
    // (the prop-spinner trick) so they persist with the scene without scattering N .mesh files.
    // See docs/unity/014-particles.md for the format + the fog0-from-PARTICLE.SSH reverse-engineering.
    public class ParticleBuilder
    {
        readonly ImportConfig _cfg;
        readonly Shader _shader;

        public ParticleBuilder(ImportConfig cfg, Shader shader) { _cfg = cfg; _shader = shader; }

        // One effect's billboard plan: a sprite + a list of puff (centre, radius) in SSX units (negated-X mesh
        // space) - exactly the data snowknife bakes into the bundle.
        struct Effect { public string Name; public string Sprite; public List<Vector3> Centres; public List<float> RadiiSSX; }

        public void Build(Transform parent)
        {
            if (!_cfg.BuildParticles) return;
            if (_shader == null) { Debug.LogWarning($"OpenSlope: particle shader '{_cfg.ParticleShaderName}' not found - skipping particles (is VRC in the project?)."); return; }

            var effects = GatherEffects();
            if (effects == null || effects.Count == 0) return;   // no bundle (warned upstream) or no particle effects

            var root = new GameObject("Particles");
            root.transform.SetParent(parent, false);

            // One container .mesh asset; each effect's puff mesh is added as a sub-asset so they persist with the
            // scene without scattering N files (same trick PropBuilder uses for the spinning pickups).
            string meshAssetPath = _cfg.LevelFolder + "/Particles.mesh";
            AssetDatabase.DeleteAsset(meshAssetPath);
            Mesh container = null;

            var matCache = new Dictionary<string, Material>(StringComparer.Ordinal);
            int built = 0, puffs = 0;

            foreach (var eff in effects)
            {
                int count = eff.Centres.Count;
                var verts = new List<Vector3>(count * 4);
                var uvs   = new List<Vector2>(count * 4);
                var offs  = new List<Vector2>(count * 4);   // per-corner billboard offset (world units), -> UV1
                var tris  = new List<int>(count * 6);

                float maxSSX = 1f;
                for (int i = 0; i < count; i++)
                {
                    Vector3 centre = eff.Centres[i];        // already negated-X mesh space; the shader spreads the corners in view space
                    // Radius is the puff's authored half-extent in SSX units; the quad's world half-extent = radius *
                    // WorldScale. (snowknife baked radius = Max(1,Unknown)*perPuffScale*maxAbsInstanceScale;
                    // ParticleSizeScale is our visual draw-size knob.)
                    float radiusSSX = eff.RadiiSSX[i];
                    if (radiusSSX > maxSSX) maxSSX = radiusSSX;
                    float half = radiusSSX * _cfg.WorldScale;

                    int b = verts.Count;
                    verts.Add(centre); verts.Add(centre); verts.Add(centre); verts.Add(centre);
                    uvs.Add(new Vector2(0, 0)); uvs.Add(new Vector2(1, 0)); uvs.Add(new Vector2(1, 1)); uvs.Add(new Vector2(0, 1));
                    offs.Add(new Vector2(-half, -half)); offs.Add(new Vector2(half, -half)); offs.Add(new Vector2(half, half)); offs.Add(new Vector2(-half, half));
                    tris.Add(b); tris.Add(b + 1); tris.Add(b + 2); tris.Add(b); tris.Add(b + 2); tris.Add(b + 3);
                }

                var mesh = new Mesh { name = "Ptcl_" + eff.Name };
                mesh.SetVertices(verts);
                mesh.SetUVs(0, uvs);
                mesh.SetUVs(1, offs);
                mesh.SetTriangles(tris, 0, calculateBounds: false);
                mesh.RecalculateBounds();
                // Every vertex sits at a puff centre; the shader spreads the quad out from there, so the computed
                // bounds are too tight - pad by the biggest puff (local SSX units) or the effect frustum-culls the
                // moment its centres leave view (e.g. while you're riding through it). Cheap and safe.
                var bd = mesh.bounds; bd.Expand(maxSSX * 2f); mesh.bounds = bd;

                if (container == null) { container = mesh; AssetDatabase.CreateAsset(mesh, meshAssetPath); }
                else AssetDatabase.AddObjectToAsset(mesh, container);

                var go = new GameObject(eff.Name);
                go.transform.SetParent(root.transform, false);
                go.AddComponent<MeshFilter>().sharedMesh = mesh;
                go.AddComponent<MeshRenderer>().sharedMaterial = GetMaterial(matCache, eff.Sprite);

                built++; puffs += count;
            }

            if (built == 0)
            {
                UnityEngine.Object.DestroyImmediate(root);
                AssetDatabase.DeleteAsset(meshAssetPath);
            }

            Debug.Log($"OpenSlope: particles built - {built} effect(s), {puffs} billboards under Particles " +
                      $"(sprites from Textures/Particles, size x{_cfg.ParticleSizeScale}, bundle).");
        }

        // Gather every effect's (sprite + puff centres/radii) from the bundle. ParticleSizeScale (our exaggeration
        // knob) is applied here so the SSX-unit radius feeds straight into the mesher. Returns null when there's no
        // bundle (the import is gated on one upstream; this just no-ops the standalone Refresh menu).
        List<Effect> GatherEffects()
        {
            var bundle = new BundleManifestReader(_cfg);
            if (!bundle.Exists) { Debug.LogWarning("OpenSlope: particles - no snowknife gltf; run `snowknife gltf`."); return null; }

            var outList = new List<Effect>();
            foreach (var e in bundle.Particles)
            {
                var eff = new Effect { Name = e.Name, Sprite = string.IsNullOrEmpty(e.Sprite) ? _cfg.ParticleSprite : e.Sprite,
                                       Centres = new List<Vector3>(e.Puffs.Length), RadiiSSX = new List<float>(e.Puffs.Length) };
                foreach (var p in e.Puffs) { eff.Centres.Add(p.Center); eff.RadiiSSX.Add(p.Radius * _cfg.ParticleSizeScale); }
                if (eff.Centres.Count > 0) outList.Add(eff);
            }
            return outList;
        }

        Material GetMaterial(Dictionary<string, Material> cache, string sprite)
        {
            if (cache.TryGetValue(sprite, out var hit)) return hit;
            string matName = "ptcl_" + Path.GetFileNameWithoutExtension(sprite);
            var mat = new Material(_shader) { name = matName };
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.LevelFolder + "/Textures/Particles/" + sprite);
            if (tex != null) mat.mainTexture = tex;
            else Debug.LogWarning("OpenSlope: particle sprite not found " + sprite + " - run `snowknife import` to decode PARTICLE.SSH into Textures/Particles/.");
            if (mat.HasProperty("_Tint"))  mat.SetColor("_Tint", _cfg.ParticleTint);
            if (mat.HasProperty("_Alpha")) mat.SetFloat("_Alpha", _cfg.ParticleAlpha);
            AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/" + matName + ".mat");
            cache[sprite] = mat;
            return mat;
        }
    }
}
#endif
