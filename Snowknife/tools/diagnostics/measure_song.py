import os, sys, glob, wave, contextlib, subprocess
from pathlib import Path
import imageio_ffmpeg
FF = imageio_ffmpeg.get_ffmpeg_exe()
TMP = str(Path(__file__).resolve().parents[3] / "temp" / "song_enc")
os.makedirs(TMP, exist_ok=True)

def dur(path):
    try:
        with contextlib.closing(wave.open(path,'rb')) as w:
            return w.getnframes()/w.getframerate(), w.getnchannels()
    except Exception:
        return 0.0, 0

for song in sys.argv[1:]:
    wavs = sorted(glob.glob(os.path.join(song, "chunk_*.wav")))
    if not wavs:
        print(f"{song}: no chunks"); continue
    raw = sum(os.path.getsize(w) for w in wavs)
    total_dur = 0.0; ch = 0
    comp = 0
    for i, w in enumerate(wavs):
        d, c = dur(w); total_dur += d; ch = c or ch
        out = os.path.join(TMP, f"c{i}.ogg")
        # Vorbis ~q4 (~Unity quality 0.5), keep stereo (music)
        r = subprocess.run([FF,"-y","-hide_banner","-loglevel","error","-i",w,
                            "-c:a","libvorbis","-q:a","4",out], capture_output=True)
        if r.returncode == 0 and os.path.exists(out):
            comp += os.path.getsize(out)
    name = os.path.basename(song.rstrip("/\\"))
    print(f"{name:14s} {len(wavs):3d} chunks  {ch}ch  {total_dur:6.1f}s   raw {raw/1024/1024:7.2f} MB   "
          f"-> Vorbis q4 stereo {comp/1024/1024:6.2f} MB")
