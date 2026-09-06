using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for a breakable logo/sign/balloon (docs/036): swaps an intact renderer set for a broken twin (or a
    // connected-component piece cluster) on rider contact, with a shard/star burst + break sound, then respawns. The
    // importer (PropBuilder) builds the twins/pieces/debris/sound and tags it; the platform wiring pass realizes the
    // runtime breakable behaviour. Field names mirror the behaviour's. The throw fields default to the behaviour's own
    // defaults so an unset (non-mesh-throw) breakable keeps them; PropBuilder overwrites them only for Sub20 mesh-throw pieces.
    public sealed class BreakableLogoMarker : Marker
    {
        public Renderer[] intactRenderers;   // hidden on break
        public Renderer[] brokenRenderers;   // shown on break
        public AudioSource breakSound;       // break one-shot
        public ParticleSystem debris;        // shard/star burst
        public bool respawn = true;          // respawn after breaking
        public float respawnDelay = 12f;     // seconds before respawn
        public float minRideSpeed = 0f;      // minimum board speed to break
        public float breakVolume = 1f;       // break one-shot volume
        public bool growBackOnRestore = false; // grow back from nothing on respawn (star-burst breakables)
        public float growBackDuration = 1f;  // grow-back time

        public Transform[] pieceTransforms;  // connected-component pieces (mesh-throw breakables)
        public Renderer[] pieceRenderers;    // piece renderers

        // Roll-away breakables (docs/036 - the globe sign): the sequenced break. On hit the break-owned animated
        // prop (rollAnimObject, resolved to the platform's animated-prop behaviour by the wiring PASS 2) plays the
        // intact's roll clip; the hide/reveal/throw runs breakDelay seconds later with endSound (the chain's
        // raw-slot crash, anchored at the landing) played at the swap. breakDelay 0 = the instant break.
        public float breakDelay = 0f;
        public AudioSource endSound;
        public GameObject rollAnimObject;

        // Sub20 mesh-throw params - default to the behaviour's own defaults (only overwritten when authored, docs/036).
        public float throwDuration = 2f;
        public Vector3 throwDir = Vector3.zero;
        public Vector3 throwVelScale = new Vector3(500f, 500f, 300f);
        public float throwDirScale = 0.8f;

        // The manifest ClusterKey this object was built for. Not copied to any behaviour - it is how CollisionBuilder,
        // which imports the prop colliders AFTER PropBuilder has built these objects, finds the breakable a support
        // bucket belongs to (docs/036 §Cracked glass).
        [ImporterOnly] public string clusterKey;

        // ---- fragile surface (docs/036 §Cracked glass - the megaplex panes) --------------------------------------
        // crackStrength > 0 turns the whole behaviour from "break on contact" into "wear down, then break": contacts
        // drain an impact pool and only the contact that empties it runs the break. 0 = every other breakable.
        public float crackStrength = 0f;
        public float crackLifetime = -1f;    // seconds a crack lasts before healing; <= 0 never heals
        public AudioSource crackSound;       // the glancing-hit crack one-shot (a separate event from breakSound)
        public Renderer crackRenderer;       // the pane, whose material carries the plain/cracked state frames
        public int crackSlot;                // material-slot (submesh) index on that renderer
        public Texture2D[] crackFrames;      // [0] plain, [1] cracked - the material's own two-frame state list
        public Vector3 crackNormal = Vector3.up;   // the pane's plane normal (level-local); the impact-vs-carried axis

        // The invisible SOLID twins holding the rider up until the glass gives way - disabled by the break, restored
        // by the respawn. Filled by CollisionBuilder, which owns the objects these live on.
        public Collider[] supportColliders;
    }
}
