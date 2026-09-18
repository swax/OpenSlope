// Run as a Unity editor command in a fresh ClientSim Play session with a built start gate.
// Exercises compiled Udon, not the C# proxy. Exit Play afterwards to discard test-only poses/owners.
// SDK serialization callbacks are injected: this is a protocol regression check, not a two-client transport test.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UdonSharpEditor;
using OpenSlope.VrcPlugin;
using VRC.SDKBase;
using VRC.SDK3.ClientSim;
using VRC.Udon;
using VRC.Udon.Common;

public class EditorCommand
{
    public static object Execute()
    {
        if (!EditorApplication.isPlaying) throw new Exception("Start ClientSim first.");
        var manager = UnityEngine.Object.FindObjectOfType<BoardManager>();
        if (manager == null || manager.boards.Any(b => b.IsRiding))
            throw new Exception("Requires an idle start gate with no local rider.");
        var players = new VRCPlayerApi[VRCPlayerApi.GetPlayerCount()];
        VRCPlayerApi.GetPlayers(players);
        var remote = players.FirstOrDefault(p => p != null && !p.isLocal);
        if (remote == null)
        {
            ClientSimMain.SpawnRemotePlayer("Board network regression remote");
            return "Remote created; rerun after ClientSim initializes it on the next frame.";
        }
        var checks = new List<string>();
        Action<bool, string> check = (ok, label) => {
            if (!ok) throw new Exception("FAILED: " + label);
            checks.Add(label);
        };
        var board = manager.boards.First(b => b.gameObject.activeSelf);
        var udon = UdonSharpEditorUtility.GetBackingUdonBehaviour(board);
        var origin = board.transform.position;
        int requests = 0;
        Action<UdonBehaviour> observe = u => { if (u == udon) requests++; };
        UdonBehaviour.RequestSerializationHook += observe;
        try
        {
            // Reproduce a native activation reset AFTER the dispenser's transform write, including while asleep.
            int corrections = (int)udon.GetProgramVariable("NetGateCorrections");
            board.transform.position = origin - Vector3.up;
            udon.SetProgramVariable("_asleep", true);
            udon.RunProgram("_postLateUpdate");
            check(Vector3.Distance(board.transform.position, origin) < 0.001f &&
                  (int)udon.GetProgramVariable("NetGateCorrections") == corrections + 1,
                  "Parked gate pose recovers from a late activation reset");

            // A failed final send must survive simulation sleep and be retried.
            udon.SetProgramVariable("_asleep", true);
            udon.SetProgramVariable("_poseSendPending", false);
            int failures = (int)udon.GetProgramVariable("NetSendFailures");
            udon.OnPostSerialization(new SerializationResult(false, 0));
            udon.SetProgramVariable("_nextSendTime", 0d);
            udon.RunProgram("_postLateUpdate");
            check(requests > 0 && (bool)udon.GetProgramVariable("_poseSendPending") &&
                  (int)udon.GetProgramVariable("NetSendFailures") == failures + 1,
                  "Failed parked send retries while asleep");

            // Delivery was deferred after RequestSerialization: the actual packet must use the new pose/time.
            udon.SetProgramVariable("atGate", false); // boards taken off a post must be free to move
            board.transform.position = origin + Vector3.right * 2f;
            udon.SetProgramVariable("_netSendTime", -100d);
            udon.OnPreSerialization();
            check(Vector3.Distance((Vector3)udon.GetProgramVariable("_netPos"), board.transform.position) < 0.001f &&
                  (double)udon.GetProgramVariable("_netSendTime") >= 0d,
                  "Deferred serialization captures current pose and timestamp");
            udon.OnPostSerialization(new SerializationResult(true, 100));
            requests = 0;
            udon.SetProgramVariable("_nextSendTime", 0d);
            udon.RunProgram("_postLateUpdate");
            check(requests == 0 && !(bool)udon.GetProgramVariable("_poseSendPending"),
                  "Confirmed sleeping board stops sending");

            // An older completion must not acknowledge a newer dispense/wake.
            udon.OnPreSerialization();
            udon.SendCustomEvent("WakeUp");
            udon.OnPostSerialization(new SerializationResult(true, 100));
            check((bool)udon.GetProgramVariable("_poseSendPending"),
                  "Old completion cannot clear a newer pose revision");
            board.transform.position = origin;
            udon.SetProgramVariable("atGate", true);
            udon.OnPreSerialization();
            udon.OnPostSerialization(new SerializationResult(true, 100));

            // ClientSim delivers ownership synchronously. The first click must consume the pending mount.
            var mount = board;
            var mu = UdonSharpEditorUtility.GetBackingUdonBehaviour(mount);
            Networking.SetOwner(remote, mount.gameObject);
            mu.Interact();
            check(Networking.IsOwner(mount.gameObject) && !(bool)mu.GetProgramVariable("_pendingMount"),
                  "First click handles synchronous ownership callback");
            mount.station.ExitStation(Networking.LocalPlayer);
            check(!(bool)mu.GetProgramVariable("_riding"), "Test rider exits before remote-follow checks");

            // Apply a remote packet through the actual compiled follow path, including a short gate teleport.
            Networking.SetOwner(remote, mount.gameObject);
            Vector3 target = mount.transform.position + Vector3.right * 3f;
            mu.SetProgramVariable("_netPos", target);
            mu.SetProgramVariable("_netRot", Quaternion.identity);
            mu.SetProgramVariable("_netVel", Vector3.zero);
            mu.SetProgramVariable("_netTeleport", (int)mu.GetProgramVariable("_netTeleport") + 1);
            mu.OnDeserialization(new DeserializationResult());
            mu.RunProgram("_update");
            check(Vector3.Distance(mount.transform.position, target) < 0.001f &&
                  (int)mu.GetProgramVariable("NetReceiveCount") > 0,
                  "Remote board applies a short teleport packet");
            mu.SetProgramVariable("_netPos", target + Vector3.right * 5f);
            mu.SetProgramVariable("_netVel", Vector3.right * 10f);
            mu.SetProgramVariable("_netSendTime", Networking.GetServerTimeInSeconds());
            mu.OnDeserialization(new DeserializationResult());
            for (int i = 0; i < 20; i++) mu.RunProgram("_update");
            check(Vector3.Distance(mount.transform.position, target) > 0.1f,
                  "Remote riding packets keep moving the board between teleports");
            Networking.SetOwner(Networking.LocalPlayer, mount.gameObject);
            mount.transform.position = origin;
            mu.SetProgramVariable("occupied", false);

            // Real post interactions must replace exactly one board at the corresponding anchor.
            var posts = UnityEngine.Object.FindObjectsOfType<BoardSpawner>();
            foreach (var post in posts)
            {
                UdonSharpEditorUtility.GetBackingUdonBehaviour(post).Interact();
                var active = manager.boards.Where(b => b.gameObject.activeSelf).ToArray();
                check(active.Length == manager.anchors.Length && manager.anchors.All(a =>
                    active.Count(b => Vector3.Distance(b.transform.position, a.position) < 0.01f) == 1),
                    "Post " + post.postIndex + " replaces its board without clustering");
            }
        }
        finally { UdonBehaviour.RequestSerializationHook -= observe; }
        return new { passed = checks.Count, checks = checks.ToArray(), transportTest = "Requires two VRChat clients" };
    }
}
