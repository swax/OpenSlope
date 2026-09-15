using System.Reflection;
using System.Text.Json;

namespace Snowknife.Tests
{
    /// <summary>Execute both production C# scalar implementations against independent instruction-reference fixtures.
    /// This does not simulate a Unity scene or replace Play Mode validation of contact and input wiring.</summary>
    public class CarvingResponseTests
    {
        [Theory]
        [InlineData(typeof(OpenSlope.VrcPlugin.RideableBoard))]
        [InlineData(typeof(OpenSlope.BasisPlugin.BasisBoard))]
        public void ResistanceMatchesInstructionReference(Type implementation)
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(CrossRepoContractTests.Root,
                "Trailmap/specs/data/carving-response-cases-v1.json")));
            foreach (var row in doc.RootElement.GetProperty("cases").EnumerateArray())
            {
                var board = Activator.CreateInstance(implementation)!;
                var surface = row.GetProperty("surface");
                int index = surface.GetProperty("type").GetInt32();
                foreach (var (field, key) in new[] {
                    ("_rideSurfResistanceA", "resistanceA"), ("_rideSurfResistanceB", "resistanceB"),
                    ("_rideSurfResistanceC", "resistanceC"), ("_rideSurfDrag", "drag") })
                {
                    var values = new float[20];
                    values[index] = surface.GetProperty(key).GetSingle();
                    implementation.GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(board, values);
                }
                var tuning = row.GetProperty("tuning");
                foreach (var (field, key) in new[] {
                    ("resistanceLinearStat", "linearStat"), ("resistanceQuadraticStat", "quadraticStat"),
                    ("resistanceSkidStat", "skidStat"), ("resistanceLateralStat", "lateralStat"),
                    ("resistanceLoadRatio", "loadRatio"), ("resistanceSkid", "skid") })
                    implementation.GetField(field)!.SetValue(board, tuning.GetProperty(key).GetSingle());
                foreach (var (field, key) in new[] {
                    ("resistanceMode", "mode"), ("resistanceEdge", "edge"), ("resistancePreferredEdge", "preferredEdge") })
                    implementation.GetField(field)!.SetValue(board, tuning.GetProperty(key).GetInt32());
                float F(string key) => row.GetProperty(key).GetSingle();
                float Call(string method, params object[] args) => (float)implementation.GetMethod(method,
                    BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(board, args)!;
                Check(Call("RideForwardResistance", index, F("u"), F("error"), F("budget"), F("charge"), F("boost")),
                    F("forwardAcceleration"));
                Check(Call("RideLateralResistance", index, F("u"), F("w"), F("lean"), F("boost")),
                    F("lateralAcceleration"));
            }
        }

        [Theory]
        [InlineData(typeof(OpenSlope.VrcPlugin.RideableBoard))]
        [InlineData(typeof(OpenSlope.BasisPlugin.BasisBoard))]
        public void HeadingUsesDirectionalLeanAndBackwardSign(Type implementation)
        {
            var board = Activator.CreateInstance(implementation)!;
            var method = implementation.GetMethod("RideHeadingYaw", BindingFlags.Instance | BindingFlags.NonPublic)!;
            float Yaw(float lean, float lead, float projection, float speed, float forward, float fall) =>
                (float)method.Invoke(board, [lean, lead, projection, speed, forward, fall, 1f / 60f])!;
            Check(Yaw(.9f, .49f, 0, 0, 0, 0), 0);
            Check(Yaw(.9f, .49f, 0, 20, 20, 20), .1047197580f);
            Check(Yaw(.8f, .2f, MathF.Sin(.4f), 20, 20, 20), -.2f * .01004204992f);
            Check(Yaw(0, 0, MathF.Sin(.4f), 20, -20, 20), .4f * .01004204992f);
        }

        static void Check(float actual, float expected) =>
            Assert.True(MathF.Abs(actual - expected) <= 3e-6f * MathF.Max(1, MathF.Abs(expected)),
                $"{actual} != instruction reference {expected}");
    }
}

// Minimal platform shims for the scalar functions only. Scene/input/physics behavior is not stubbed into tests.
namespace UnityEngine
{
    [AttributeUsage(AttributeTargets.Field)]
    internal sealed class RangeAttribute(float minimum, float maximum) : Attribute
    {
        public float Minimum { get; } = minimum;
        public float Maximum { get; } = maximum;
    }
    internal static class Mathf
    {
        public static float Abs(float x) => MathF.Abs(x);
        public static float Min(float x, float y) => MathF.Min(x, y);
        public static float Max(float x, float y) => MathF.Max(x, y);
        public static float Clamp(float x, float a, float b) => Math.Clamp(x, a, b);
        public static float Asin(float x) => MathF.Asin(x);
        public static float Cos(float x) => MathF.Cos(x);
    }
}
namespace OpenSlope.VrcPlugin
{
    public partial class RideableBoard
    {
        private float[] _rideSurfResistanceA = new float[20], _rideSurfResistanceB = new float[20],
            _rideSurfResistanceC = new float[20], _rideSurfDrag = new float[20];
    }
}
namespace OpenSlope.BasisPlugin
{
    public partial class BasisBoard
    {
        private float[] _rideSurfResistanceA = new float[20], _rideSurfResistanceB = new float[20],
            _rideSurfResistanceC = new float[20], _rideSurfDrag = new float[20];
    }
}
