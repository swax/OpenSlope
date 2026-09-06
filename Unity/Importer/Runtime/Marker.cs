using UnityEngine;

namespace OpenSlope.Importer
{

    // Base type for the importer's neutral hand-off markers. The level importer (Assets/OpenSlope/Importer) builds only
    // platform-neutral geometry, colliders, particles, audio and DATA; wherever a platform needs to attach a runtime
    // behaviour (a VRChat UdonSharpBehaviour, a Basis MonoBehaviour, ...), the importer instead attaches one of these
    // markers carrying the exact fields that behaviour wants. A platform "wiring pass" then walks the markers and
    // realizes each into its own runtime component.
    //
    // This is the seam that keeps the importer free of any VRChat/Basis dependency: a marker is a plain MonoBehaviour
    // with public fields, so both the importer and every platform reference it without either referencing the other.
    // The common base lets a wiring pass enumerate + clear all markers generically once they're realized, and lets the
    // Basis scaffold report which marker types it does not yet handle.
    //
    // Field convention: a marker's public fields are named IDENTICALLY to the target behaviour's fields and use the
    // same types, so a platform can copy them across by name (see the wiring pass's CopyFieldsByName). There are
    // two exceptions:
    //   - a cross-reference to ANOTHER realized behaviour, which a neutral marker can't type: it stores that as a
    //     GameObject reference (suffix `Object`/`Objects`), and the wiring pass resolves it to the platform component
    //     in a second pass after every behaviour exists.
    //   - a field the IMPORTER alone reads, carried on the marker only to hand data between two import passes and
    //     never destined for any behaviour: tag it [ImporterOnly] (below).
    public abstract class Marker : MonoBehaviour
    {
    }

    // Marks a marker field as importer-internal: the wiring passes skip it instead of reporting it as rename drift.
    // A marker exists to hand fields to a runtime behaviour, so an unmatched field is normally a real bug - the copy
    // pass logs one per object, which is exactly the signal you want when a behaviour field gets renamed. A few fields
    // are legitimately not behaviour fields at all: they carry state between two importer passes that run in order
    // (BreakableLogoMarker.clusterKey lets CollisionBuilder find the breakable a support bucket belongs to, long
    // after PropBuilder built it). Without this tag those log one false warning per instance and bury the real ones.
    [System.AttributeUsage(System.AttributeTargets.Field)]
    public sealed class ImporterOnlyAttribute : System.Attribute
    {
    }
}
