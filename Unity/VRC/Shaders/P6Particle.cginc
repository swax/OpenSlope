sampler2D _MainTex;
float4 _MainTex_ST;
float _P6TimeScale, _P6TrailAgeOffset, _P6TrailFade;
float _P6ContactEnabled;
float3 _P6SpawnAxisA, _P6SpawnAxisB;
float3 _P6VelocityBase, _P6VelocityAxisA, _P6VelocityAxisB, _P6VelocityAxisC, _P6Gravity;
float3 _P6ContactOrigin, _P6ContactVelocity;
fixed4 _P6Color0, _P6Color1, _P6Color2, _P6Color3;

struct appdata_p6
{
    float4 vertex : POSITION;
    fixed4 color : COLOR;
    float4 uvAgeLife : TEXCOORD0; // UV.xy, AgePercent.z, InvStartLifetime.w
    float4 stableRandom : TEXCOORD1;
    float4 emitterOrigin : TEXCOORD2; // serialized Custom1 world-space emitter origin
    float3 center : TEXCOORD3; // synthetic CPU culling-envelope center
};

struct v2f_p6
{
    float4 vertex : SV_POSITION;
    float2 uv : TEXCOORD0;
    fixed4 color : COLOR;
};

float p6hash(float4 value, float salt)
{
    return frac(sin(dot(value, float4(12.9898, 78.233, 37.719, 19.913)) + salt) * 43758.5453);
}

fixed4 p6color(float t)
{
    float scaled = saturate(t) * 3.0;
    if (scaled < 1.0) return lerp(_P6Color0, _P6Color1, scaled);
    if (scaled < 2.0) return lerp(_P6Color1, _P6Color2, scaled - 1.0);
    return lerp(_P6Color2, _P6Color3, scaled - 2.0);
}

v2f_p6 vert(appdata_p6 v)
{
    v2f_p6 o;
    float inverseLife = max(v.uvAgeLife.w, 0.000001);
    float life = rcp(inverseLife);
    float age = v.uvAgeLife.z * life;
    float sampleAge = age - _P6TrailAgeOffset;
    float valid = step(0.0, sampleAge) * step(sampleAge, life);

    float spawnA = v.stableRandom.x - 0.5;
    float spawnB = v.stableRandom.y - 0.5;
    float velocityA = v.stableRandom.z - 0.5;
    float velocityB = v.stableRandom.w - 0.5;
    float velocityC = p6hash(v.stableRandom, 11.17) - 0.5;
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
    float3 billboardOffsetWS = v.vertex.xyz - v.center;
    float3 emitterOrigin = lerp(v.emitterOrigin.xyz, _P6ContactOrigin, saturate(_P6ContactEnabled));
    v.vertex.xyz = billboardOffsetWS + emitterOrigin
        + spawn + gravity * internalAge + (gravity - velocity / timeScale) * curve;

    float t = saturate(sampleAge * inverseLife);
    fixed4 color = p6color(t) * v.color;
    float lifeFade = t < 0.08 ? t / 0.08 : (t > 0.9 ? (1.0 - t) / 0.1 : 1.0);
    color.a *= max(0.0, lifeFade) * _P6TrailFade * valid;
    o.vertex = mul(UNITY_MATRIX_VP, float4(v.vertex.xyz, 1.0));
    o.uv = TRANSFORM_TEX(v.uvAgeLife.xy, _MainTex);
    o.color = color;
    return o;
}

fixed4 frag(v2f_p6 i) : SV_Target
{
    clip(i.color.a - 0.0001);
    return tex2D(_MainTex, i.uv) * i.color;
}
