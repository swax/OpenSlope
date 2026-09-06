Shader "OpenSlope/P6ParticleAlpha"
{
    Properties
    {
        _MainTex ("Particle Texture", 2D) = "white" {}
        [HideInInspector] _P6TimeScale ("Time scale", Float) = 1
        [HideInInspector] _P6SpawnAxisA ("Spawn A", Vector) = (0,0,0,0)
        [HideInInspector] _P6SpawnAxisB ("Spawn B", Vector) = (0,0,0,0)
        [HideInInspector] _P6VelocityBase ("Velocity", Vector) = (0,0,0,0)
        [HideInInspector] _P6ContactEnabled ("Contact override", Float) = 0
        [HideInInspector] _P6ContactOrigin ("Contact origin", Vector) = (0,0,0,0)
        [HideInInspector] _P6ContactVelocity ("Contact velocity", Vector) = (0,0,0,0)
        [HideInInspector] _P6VelocityAxisA ("Velocity A", Vector) = (0,0,0,0)
        [HideInInspector] _P6VelocityAxisB ("Velocity B", Vector) = (0,0,0,0)
        [HideInInspector] _P6VelocityAxisC ("Velocity C", Vector) = (0,0,0,0)
        [HideInInspector] _P6Gravity ("Gravity", Vector) = (0,0,0,0)
        [HideInInspector] _P6Color0 ("Color 0", Color) = (1,1,1,1)
        [HideInInspector] _P6Color1 ("Color 1", Color) = (1,1,1,1)
        [HideInInspector] _P6Color2 ("Color 2", Color) = (1,1,1,1)
        [HideInInspector] _P6Color3 ("Color 3", Color) = (1,1,1,1)
        [HideInInspector] _P6TrailAgeOffset ("Trail age", Float) = 0
        [HideInInspector] _P6TrailFade ("Trail fade", Float) = 1
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" "PreviewType"="Plane" "RenderPipeline"="UniversalPipeline" }
        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        Cull Off
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma target 3.0
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "P6Particle.hlsl"
            ENDHLSL
        }
    }
}
