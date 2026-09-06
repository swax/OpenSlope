TEXTURE2D(_MainTex);
SAMPLER(sampler_MainTex);

CBUFFER_START(UnityPerMaterial)
float4 _MainTex_ST;
float _P6TimeScale, _P6TrailAgeOffset, _P6TrailFade;
float _P6ContactEnabled;
float3 _P6SpawnAxisA, _P6SpawnAxisB;
float3 _P6VelocityBase, _P6VelocityAxisA, _P6VelocityAxisB, _P6VelocityAxisC, _P6Gravity;
float3 _P6ContactOrigin, _P6ContactVelocity;
half4 _P6Color0, _P6Color1, _P6Color2, _P6Color3;
CBUFFER_END

struct AttributesP6
{
    float4 positionOS : POSITION;
    half4 color : COLOR;
    float4 uvAgeLife : TEXCOORD0;
    float4 stableRandom : TEXCOORD1;
    float4 emitterOrigin : TEXCOORD2; // serialized Custom1 world-space emitter origin
    float3 center : TEXCOORD3; // synthetic CPU culling-envelope center
};

struct VaryingsP6
{
    float4 positionCS : SV_POSITION;
    float2 uv : TEXCOORD0;
    half4 color : COLOR;
};

float P6Hash(float4 value, float salt)
{
    return frac(sin(dot(value, float4(12.9898, 78.233, 37.719, 19.913)) + salt) * 43758.5453);
}

half4 P6Color(float t)
{
    float scaled = saturate(t) * 3.0;
    if (scaled < 1.0) return lerp(_P6Color0, _P6Color1, scaled);
    if (scaled < 2.0) return lerp(_P6Color1, _P6Color2, scaled - 1.0);
    return lerp(_P6Color2, _P6Color3, scaled - 2.0);
}

VaryingsP6 vert(AttributesP6 input)
{
    VaryingsP6 output;
    float inverseLife = max(input.uvAgeLife.w, 0.000001);
    float life = rcp(inverseLife);
    float age = input.uvAgeLife.z * life;
    float sampleAge = age - _P6TrailAgeOffset;
    float valid = step(0.0, sampleAge) * step(sampleAge, life);

    float spawnA = input.stableRandom.x - 0.5;
    float spawnB = input.stableRandom.y - 0.5;
    float velocityA = input.stableRandom.z - 0.5;
    float velocityB = input.stableRandom.w - 0.5;
    float velocityC = P6Hash(input.stableRandom, 11.17) - 0.5;
    float3 spawn = _P6SpawnAxisA * spawnA + _P6SpawnAxisB * spawnB;
    float3 velocityBase = lerp(_P6VelocityBase, _P6ContactVelocity, saturate(_P6ContactEnabled));
    float3 velocity = velocityBase + _P6VelocityAxisA * velocityA
        + _P6VelocityAxisB * velocityB + _P6VelocityAxisC * velocityC;

    float timeScale = abs(_P6TimeScale) < 0.000001 ? 1.0 : _P6TimeScale;
    float internalAge = max(0.0, sampleAge) * timeScale;
    float curvedAge = min(2.7, internalAge);
    float curve = -0.73 * curvedAge + 0.113 * curvedAge * curvedAge;
    float3 gravity = _P6Gravity / (timeScale * timeScale);
    // CPU particles are deliberately spread over a conservative sphere so Unity's serialized runtime bounds cover
    // the shader-only trajectory. Remove that synthetic center while preserving the billboard corner offset, then
    // place the quad at its authentic P6 position.
    float3 billboardOffsetWS = input.positionOS.xyz - input.center;
    float3 emitterOrigin = lerp(input.emitterOrigin.xyz, _P6ContactOrigin, saturate(_P6ContactEnabled));
    float3 positionWS = billboardOffsetWS + emitterOrigin
        + spawn + gravity * internalAge + (gravity - velocity / timeScale) * curve;

    float t = saturate(sampleAge * inverseLife);
    half4 color = P6Color(t) * input.color;
    float lifeFade = t < 0.08 ? t / 0.08 : (t > 0.9 ? (1.0 - t) / 0.1 : 1.0);
    color.a *= max(0.0, lifeFade) * _P6TrailFade * valid;
    output.positionCS = TransformWorldToHClip(positionWS);
    output.uv = TRANSFORM_TEX(input.uvAgeLife.xy, _MainTex);
    output.color = color;
    return output;
}

half4 frag(VaryingsP6 input) : SV_Target
{
    clip(input.color.a - 0.0001);
    return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, input.uv) * input.color;
}
