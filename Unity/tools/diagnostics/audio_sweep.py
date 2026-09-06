import os, sys, wave, subprocess, contextlib
from pathlib import Path
import imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()
OUT = str(Path(__file__).resolve().parents[3] / "temp" / "audio_test")
os.makedirs(OUT, exist_ok=True)

def info(path):
    with contextlib.closing(wave.open(path, 'rb')) as w:
        ch, sr, n = w.getnchannels(), w.getframerate(), w.getnframes()
        return ch, sr, n / sr

def enc(inp, name, args, ext):
    out = os.path.join(OUT, name + ext)
    cmd = [FF, "-y", "-hide_banner", "-loglevel", "error", "-i", inp] + args + [out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(out):
        return None
    return os.path.getsize(out)

# (label, ffmpeg args, ext, ships-in-VRChat?)
SETTINGS = [
    ("Vorbis q10 (~Unity 1.0)", ["-c:a","libvorbis","-q:a","10"], ".ogg", "YES"),
    ("Vorbis q6  (~Unity 0.7)", ["-c:a","libvorbis","-q:a","6"],  ".ogg", "YES"),
    ("Vorbis q4  (~Unity 0.5)", ["-c:a","libvorbis","-q:a","4"],  ".ogg", "YES"),
    ("Vorbis q2  (~Unity 0.3)", ["-c:a","libvorbis","-q:a","2"],  ".ogg", "YES"),
    ("Vorbis q4 + MONO",        ["-c:a","libvorbis","-q:a","4","-ac","1"], ".ogg", "YES"),
    ("Vorbis q4 + MONO + 22kHz",["-c:a","libvorbis","-q:a","4","-ac","1","-ar","22050"], ".ogg", "YES"),
    ("ADPCM (adpcm_ms)",        ["-c:a","adpcm_ms"], ".wav", "YES"),
    ("MP3 128k",                ["-c:a","libmp3lame","-b:a","128k"], ".mp3", "no"),
    ("MP3 96k",                 ["-c:a","libmp3lame","-b:a","96k"],  ".mp3", "no"),
    ("Opus 96k",                ["-c:a","libopus","-b:a","96k"], ".opus", "no"),
    ("Opus 64k",                ["-c:a","libopus","-b:a","64k"], ".opus", "no"),
    ("AAC 96k",                 ["-c:a","aac","-b:a","96k"], ".m4a", "no"),
]

for inp in sys.argv[1:]:
    ch, sr, dur = info(inp)
    src = os.path.getsize(inp)
    tag = os.path.basename(os.path.dirname(inp)) + "/" + os.path.basename(inp)
    print(f"\n=== {tag}   {ch}ch {sr}Hz {dur:.2f}s   PCM source {src/1024:.0f} KB ===")
    print(f"{'setting':28s} {'KB':>7} {'kbps':>6} {'vs src':>7}  ships")
    for label, args, ext, ships in SETTINGS:
        safe = label.replace(" ","_").replace("(","").replace(")","").replace("~","").replace("+","").replace("/","")
        size = enc(inp, os.path.splitext(os.path.basename(inp))[0]+"_"+safe, args, ext)
        if size is None:
            print(f"{label:28s} {'n/a':>7}")
            continue
        kbps = size*8/dur/1000
        print(f"{label:28s} {size/1024:7.0f} {kbps:6.0f} {size/src*100:6.0f}%  {ships}")
