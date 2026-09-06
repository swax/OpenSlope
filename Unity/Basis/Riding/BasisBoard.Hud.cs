using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Part of BasisBoard (partial): a lightweight on-screen SCORE READOUT for the local rider, so a solo ride-test SHOWS
    // the run score, gem multiplier, and the live/last trick - instead of only the console (BasisBoard.Score.cs logTricks).
    //
    // It's a DEBUG / dev aid drawn with IMGUI (OnGUI): zero assets, render-pipeline-independent (no URP material / font
    // asset / Canvas to get wrong), and always legible in DESKTOP mode - which is how the board is ride-tested. In VR it
    // simply doesn't draw (OnGUI is 2D screen space); that's harmless.
    //
    // Runs only for the LOCAL rider: OnGUI runs on every board instance, but it early-outs on !_riding, which is only true
    // on the board you're actually on (a remote copy has _riding = false), so you never see other riders' HUDs.
    public partial class BasisBoard
    {
        [Header("Score HUD (on-screen readout while riding - a desktop dev aid)")]
        [Tooltip("Show the run score / multiplier / trick readout on screen while riding (desktop only; harmless in VR).")]
        public bool showScoreHud = true;

        GUIStyle _hudLabel, _hudBig;
        Texture2D _hudBg;

        void OnGUI()
        {
            if (!showScoreHud || !_riding) return;

            if (_hudBg == null)
            {
                _hudBg = new Texture2D(1, 1);
                _hudBg.SetPixel(0, 0, new Color(0f, 0f, 0f, 0.55f));
                _hudBg.Apply();
            }
            int fs = Mathf.Clamp(Screen.height / 34, 14, 40);   // scale the font to the screen
            if (_hudLabel == null) _hudLabel = new GUIStyle();
            if (_hudBig == null) _hudBig = new GUIStyle { fontStyle = FontStyle.Bold };
            _hudLabel.fontSize = fs;
            _hudBig.fontSize = Mathf.RoundToInt(fs * 1.5f);

            float pad = fs * 0.6f;
            float lh = fs * 1.3f;
            float w = fs * 11f;
            float bigH = _hudBig.fontSize + 6f;
            float contentH = bigH + lh * 2f;
            var panel = new Rect(pad, pad, w, contentH + pad * 2f);
            GUI.DrawTexture(panel, _hudBg);

            float cx = pad * 2f, cy = pad * 2f;

            // Run score (big).
            _hudBig.normal.textColor = Color.white;
            GUI.Label(new Rect(cx, cy, w, bigH), $"{RunScore:n0}", _hudBig);
            cy += bigH;

            // Gem multiplier (gold when active).
            _hudLabel.normal.textColor = RunGemMult > 1 ? new Color(1f, 0.85f, 0.2f) : new Color(1f, 1f, 1f, 0.85f);
            GUI.Label(new Rect(cx, cy, w, lh), $"MULT  x{RunGemMult}", _hudLabel);
            cy += lh;

            // Live trick / grind, else the last resolved trick.
            string third;
            if (RunGrinding) third = $"GRIND  {RunGrindTime:0.0}s";
            else if (RunTrickActive) third = $"TRICK  {RunStyleRots:0.0} rot";
            else if (RunLastTrickPts >= 0) third = RunLastBailed ? "LAST  bailed +0" : $"LAST  +{RunLastTrickPts:n0}";
            else third = "ride · grab a gem · spin";
            _hudLabel.normal.textColor = new Color(1f, 1f, 1f, 0.85f);
            GUI.Label(new Rect(cx, cy, w, lh), third, _hudLabel);
        }
    }
}
