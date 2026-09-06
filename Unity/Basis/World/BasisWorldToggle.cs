// Adapted from Basis's example interactable button (com.basis.examples, BasisInteractableButton).
// Basis is Copyright (c) 2024 MR LUKE B DOOLAN, MIT License — see ../../ThirdPartyNotices/Basis-LICENSE.txt.

using UnityEngine;

namespace OpenSlope.BasisPlugin
{
    using Basis.Scripts.BasisSdk.Interactions;      // BasisInteractableObject, BasisInputWrapper, BasisInteractInputState
    using Basis.Scripts.Device_Management.Devices;  // BasisInput
    using Basis.Scripts.BasisSdk.Highlight;         // BasisHighlightManager

    /// <summary>
    /// A world-space ON/OFF toggle PLATE for the Basis UI boards - a 3D checkbox you point at and press to flip. It's the
    /// Basis analogue of the VRChat UI <c>Toggle</c> the boards use, built on Basis's own interactable + pointer pipeline
    /// instead of uGUI, because a plain world-space Canvas isn't clickable in Basis without a physics collider on the right
    /// layer (a uGUI Toggle would need Basis's UI-raycast plumbing); a <see cref="BasisInteractableObject"/> plate is
    /// point-and-trigger in VR AND desktop out of the box (the same pointer + trigger drives both). Modeled on Basis's own
    /// example interactable button (com.basis.examples BasisInteractableButton) - same hover/interact state machine - but
    /// LATCHING: each press flips <see cref="IsOn"/> and fires <see cref="Changed"/>, which the owning board reads to
    /// re-assert its systems (idempotent, like the VRChat perf board's Apply).
    ///
    /// A colored quad shows the state (green on / grey off); an optional highlight fires on hover. Needs a Collider (the
    /// setup adds a BoxCollider) for the pointer ray. Local-only - toggling a plate affects only this client, exactly like
    /// the per-player cosmetic switches it drives.
    /// </summary>
    public class BasisWorldToggle : BasisInteractableObject
    {
        [Header("Toggle state")]
        [Tooltip("Current on/off state. The owning board reads this in its Apply().")]
        public bool IsOn = true;

        [Header("Visuals")]
        [Tooltip("The plate renderer tinted by state (green on / grey off). Auto-found on self if empty.")]
        public MeshRenderer targetRenderer;
        [Tooltip("Shader colour property to drive. URP Lit/Unlit use _BaseColor; the OpenSlope unlit uses _Color.")]
        public string colorProperty = "_BaseColor";
        public Color onColor = new Color(0.20f, 0.70f, 0.32f);
        public Color offColor = new Color(0.42f, 0.42f, 0.45f);
        [Tooltip("Brightening added while a pointer hovers the plate.")]
        public Color hoverAdd = new Color(0.12f, 0.12f, 0.12f);
        [Tooltip("Use Basis's hover highlight outline on top of the colour change.")]
        public bool useHighlight = true;

        [Tooltip("Master enable - a disabled plate ignores hover/press (mirrors the example button's isEnabled).")]
        public bool isEnabled = true;

        // The owning board wires this to its re-assert method; fired on every flip. Board-agnostic (no hard board ref).
        public System.Action Changed;

        int _propId;

        // Mirror of the example button: this interactable tracks exactly ONE input wrapper at a time (whoever is hovering /
        // pressing it). Kept in sync with the base Inputs list so the pointer system sees it.
        BasisInputWrapper _inputSource;
        BasisInputWrapper _InputSource
        {
            get => _inputSource;
            set
            {
                if (value.Source != null) { Inputs = new(0); Inputs.SetInputByRole(value.Source, value.GetState()); }
                else Inputs = new(0);
                _inputSource = value;
            }
        }

        void Start()
        {
            _InputSource = default;
            if (targetRenderer == null) TryGetComponent(out targetRenderer);
            _propId = Shader.PropertyToID(colorProperty);
            Recolor(false);
        }

        // ---- interactable contract (ported verbatim from the example button, latching instead of momentary) ----

        public override bool CanHover(BasisInput input)
        {
            return _InputSource.GetState() == BasisInteractInputState.NotAdded
                && IsWithinRange(input.transform.position, InteractRange) && isEnabled;
        }

        public override bool CanInteract(BasisInput input)
        {
            if (!_InputSource.IsInput(input)) return false;                         // must be the input already hovering
            if (_InputSource.GetState() == BasisInteractInputState.Interacting) return false; // one flip per press
            return IsWithinRange(input.transform.position, InteractRange) && isEnabled;
        }

        public override void OnHoverStart(BasisInput input)
        {
            if (!BasisInputWrapper.TryNewTracking(input, BasisInteractInputState.Hovering, out BasisInputWrapper wrapper)) return;
            _InputSource = wrapper;
            if (useHighlight) SetHighlight(true);
            Recolor(true);
            base.OnHoverStart(input);
        }

        public override void OnHoverEnd(BasisInput input, bool willInteract)
        {
            if (!_InputSource.IsInput(input)) return;
            if (!willInteract)
            {
                BasisInputWrapper.TryNewTracking(null, BasisInteractInputState.NotAdded, out BasisInputWrapper wrapper);
                _InputSource = wrapper;
                Recolor(false);
                SetHighlight(false);
            }
            base.OnHoverEnd(input, willInteract);
        }

        public override void OnInteractStart(BasisInput input)
        {
            if (_InputSource.IsInput(input) && _InputSource.GetState() == BasisInteractInputState.Hovering)
            {
                var newSource = _InputSource;
                newSource.TrySetState(BasisInteractInputState.Interacting);
                _InputSource = newSource;

                IsOn = !IsOn;              // the flip
                Recolor(true);            // still hovered -> show the new state, brightened
                Changed?.Invoke();        // let the board re-assert its systems
                base.OnInteractStart(input);
            }
        }

        public override void OnInteractEnd(BasisInput input)
        {
            if (!_InputSource.IsInput(input)) return;
            Recolor(false);
            SetHighlight(false);
            BasisInputWrapper.TryNewTracking(null, BasisInteractInputState.NotAdded, out BasisInputWrapper wrapper);
            _InputSource = wrapper;
            base.OnInteractEnd(input);
        }

        public override bool IsInteractingWith(BasisInput input)
            => _InputSource.IsInput(input) && _InputSource.GetState() == BasisInteractInputState.Interacting;

        public override bool IsHoveredBy(BasisInput input)
            => _InputSource.IsInput(input) && _InputSource.GetState() == BasisInteractInputState.Hovering;

        // Tint the plate by state (+ a hover brighten). Colour-property-driven so it works with URP or the OpenSlope unlit shader.
        void Recolor(bool hovered)
        {
            if (targetRenderer == null || targetRenderer.material == null) return;
            Color c = IsOn ? onColor : offColor;
            if (hovered) c += hoverAdd;
            targetRenderer.material.SetColor(_propId, c);
        }

        void SetHighlight(bool on)
        {
            if (targetRenderer != null) BasisHighlightManager.SetHighlight(targetRenderer, on);
        }
    }
}
