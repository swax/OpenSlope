#!/usr/bin/env python3
"""Live capture of SSX Tricky (PAL SLES-50545) board-FX state over PINE — read-only.

The five board snow-spray buffers live in one container reached from the registry singleton; this reads the
whole container, the boarder, the boarder's state-machine object, the render driver's VU constant packets AND
VU1 data memory (mapped at EE 0x1100C000, readable over PINE) in one frame-fenced snapshot, then decodes every
ring slot. It is how `research/spray-systems.md`'s 2026-08-24 live section was measured.

  python tools/instrumentation/board_fx_probe.py chain            print the pointer chain
  python tools/instrumentation/board_fx_probe.py watch [seconds]  ~15 Hz summary of rider + ring occupancy
  python tools/instrumentation/board_fx_probe.py snap <label>     frame-fenced snapshot (temp/board-fx/)
  python tools/instrumentation/board_fx_probe.py decode <bin>     decode a saved snapshot

Steering/jumping the rider for a capture uses the autotest caves (`tools/autotest/steer.py`, `pad_drive.py`);
those write the executable image and are deliberately not wrapped here.
"""
import json, struct, sys, time, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pine_hooks import Pine  # noqa

REG = 0x00338E58
OUT = Path(__file__).resolve().parents[2] / 'temp' / 'board-fx'
PS_SIZE = 0xC400
BOARDER_SIZE = 0x5B00
SM_SIZE = 0x500
DRV_A, DRV_A_SIZE = 0x480, 0x1C0
VU1_DATA = 0x1100C000
DRV_B, DRV_B_SIZE = 0x1730, 0xA0


def f32(b, off):
    return struct.unpack_from('<f', b, off)[0]


def u32(b, off):
    return struct.unpack_from('<I', b, off)[0]


def vec(b, off, n=4):
    return [round(f32(b, off + 4 * i), 3) for i in range(n)]


def chain(p):
    reg = p.r32(REG)
    world = p.r32(reg + 0x730)
    boarder = p.r32(world + 0xA4)
    sm = p.r32(boarder + 0x5AE0)
    ps = p.r32(sm + 0x3E0)
    drv = p.r32(reg + 0x724)
    clock = p.r32(world + 0x1C)
    return dict(reg=reg, world=world, boarder=boarder, sm=sm, ps=ps, drv=drv, clock=clock)


def read_block(p, addr, size):
    n = (size + 7) // 8
    vals = []
    step = 4000
    for i in range(0, n, step):
        vals += p.r64_many(addr + 8 * j for j in range(i, min(n, i + step)))
    return struct.pack(f'<{len(vals)}Q', *vals)[:size]


def frame(p, c):
    return p.r32(c['clock'] + 0x18)


def summary_line(p, c):
    b = c['boarder']; ps = c['ps']
    addrs = [b + 0x424, b + 0x290, b + 0x2E0, b + 0x214, b + 0x1FC, b + 0x1B4,
             b + 0x150, b + 0x154, b + 0x158,
             ps + 0x1C10,                 # sys1 count
             ps + 0x1C20 + 0x50,          # sys2 count
             ps + 0x4B60 + 0x04, ps + 0x4B60 + 0x08, ps + 0x4B60 + 0x0C,  # 40-slot count/head/burst
             ps + 0x99B0 + 0x960, ps + 0x99B0 + 0x96C,  # sys4 count, A
             ps + 0xB600 + 0xD50,         # sys5 count
             c['clock'] + 0x18]
    w = p.r32_many(addrs)
    fl = lambda x: struct.unpack('<f', struct.pack('<I', x))[0]
    vel = (fl(w[6]), fl(w[7]), fl(w[8]))
    speed = math.sqrt(sum(v * v for v in vel))
    return (f"fr {w[17]:7d} st {w[0]} sub {w[2]} surf {w[1]:2d} spd {speed/100:5.2f} m/s lean {fl(w[3]):+.3f} "
            f"slip {fl(w[4]):+.3f} edge {w[5]} | s1 {w[9]:2d} s2 {w[10]:2d} ring {w[11]:2d}/{w[12]:2d} "
            f"burst {fl(w[13]):5.1f} s4 {w[14]:2d} A {fl(w[15]):.2f} s5 {w[16]:2d}")


def snap(p, c, label, tries=6):
    OUT.mkdir(exist_ok=True)
    for attempt in range(tries):
        f0 = frame(p, c)
        ps = read_block(p, c['ps'], PS_SIZE)
        bo = read_block(p, c['boarder'], BOARDER_SIZE)
        sm = read_block(p, c['sm'], SM_SIZE)
        da = read_block(p, c['drv'] + DRV_A, DRV_A_SIZE)
        db = read_block(p, c['drv'] + DRV_B, DRV_B_SIZE)
        f1 = frame(p, c)
        if f0 == f1:
            break
        print(f'  snapshot straddled frames {f0}->{f1}, retrying')
    try:
        vu = read_block(p, VU1_DATA, 0x100)
    except Exception as e:  # noqa
        print('  VU1 data memory not readable over PINE:', e)
        vu = b''
    name = f'{label}-{f0}'
    (OUT / f'{name}.bin').write_bytes(ps + bo + sm + da + db + vu)
    layout = dict(ps=[0, PS_SIZE], boarder=[PS_SIZE, BOARDER_SIZE], sm=[PS_SIZE + BOARDER_SIZE, SM_SIZE],
                  drvA=[PS_SIZE + BOARDER_SIZE + SM_SIZE, DRV_A_SIZE],
                  drvB=[PS_SIZE + BOARDER_SIZE + SM_SIZE + DRV_A_SIZE, DRV_B_SIZE])
    if vu:
        layout['vu'] = [PS_SIZE + BOARDER_SIZE + SM_SIZE + DRV_A_SIZE + DRV_B_SIZE, len(vu)]
    meta = dict(label=label, frame=f0, chain={k: hex(v) for k, v in c.items()}, layout=layout, fenced=(f0 == f1))
    (OUT / f'{name}.json').write_text(json.dumps(meta, indent=1))
    print(f'wrote {OUT / name}.bin frame {f0} fenced={f0 == f1}')
    return OUT / f'{name}.bin'


def decode(path):
    meta = json.loads(Path(str(path).replace('.bin', '.json')).read_text())
    data = Path(path).read_bytes()
    L = meta['layout']
    ps = data[L['ps'][0]:L['ps'][0] + L['ps'][1]]
    bo = data[L['boarder'][0]:L['boarder'][0] + L['boarder'][1]]
    sm = data[L['sm'][0]:L['sm'][0] + L['sm'][1]]
    da = data[L['drvA'][0]:L['drvA'][0] + L['drvA'][1]]
    db = data[L['drvB'][0]:L['drvB'][0] + L['drvB'][1]]
    print(f"== {meta['label']} frame {meta['frame']} fenced={meta['fenced']}")
    print('boarder: pos', vec(bo, 0x140, 3), 'vel', vec(bo, 0x150, 3), '|v|', round(math.sqrt(sum(x * x for x in vec(bo, 0x150, 3))), 1))
    print('  state', u32(bo, 0x424), 'sub', u32(bo, 0x2E0), 'surf', u32(bo, 0x290), 'lean', round(f32(bo, 0x214), 3),
          'slip', round(f32(bo, 0x1FC), 3), 'edge', u32(bo, 0x1B4), 'dig', round(f32(bo, 0x160), 3))
    print('  normal+2a0', vec(bo, 0x2A0), 'contact+2d0', vec(bo, 0x2D0), 'tangent+2b0', vec(bo, 0x2B0), '+2c0', vec(bo, 0x2C0))
    print('  +1a0 basis', vec(bo, 0x1A0), vec(bo, 0x1B0), vec(bo, 0x1C0), vec(bo, 0x1D0))
    for off in (0x4A60, 0x4A70, 0x4A80, 0x4A90, 0x4AA0):
        print(f'  boarder+{off:x}', vec(bo, off))
    print('  sm+470 color', vec(sm, 0x470), 'sm+3e0 ps', hex(u32(sm, 0x3E0)))
    print('driver P6 packet rows0-3 (+490):', [vec(da, 0x10 + 0x10 * i) for i in range(4)])
    print('driver P6 consts qw4..7 (+4d0):', vec(da, 0x50), vec(da, 0x60), vec(da, 0x70), vec(da, 0x80))
    print('driver packet2 (+510):', [vec(da, 0x90 + 0x10 * i) for i in range(8)])
    print('driver packet3 (+5b0):', [vec(da, 0x130 + 0x10 * i) for i in range(8)])
    vu = data[L['vu'][0]:L['vu'][0] + L['vu'][1]] if 'vu' in L else b''
    if vu:
        print('VU1 data mem rows 0-7:', [vec(vu, 0x10 * i) for i in range(8)])
    print('  proj rows +1730:', [vec(db, 0x10 * i) for i in range(4)])
    print('  viewproj +1770:', [vec(db, 0x40 + 0x10 * i) for i in range(4)])
    print('  +17b0..:', vec(db, 0x80), vec(db, 0x90))

    # 40-slot ring
    base = 0x4B60
    count, head, latch, burst = u32(ps, base), u32(ps, base + 4), u32(ps, base + 8), f32(ps, base + 0xC)
    print(f'-- 40-slot ring: count {count} head {head} latch {latch:#x} burst {burst:.3f}')
    order = [(head + i) % 40 for i in range(count)]
    for k, i in enumerate(order[-10:] if count > 10 else order):
        s = base + 0x40 + i * 0x150
        print(f'  slot[{i:2d}] n={u32(ps, s)} inner={u32(ps, s+4)} age={f32(ps, s+8):.3f} w={f32(ps, s+0xc):.4f} '
              f'qw1={vec(ps, s+0x10)} qw2={vec(ps, s+0x20)} r={f32(ps, s+0x3c):.1f}')
        print(f'      qw5 grav={vec(ps, s+0x50)} qw6={vec(ps, s+0x60)} qw7={vec(ps, s+0x70)} qw8={vec(ps, s+0x80)} qw9={vec(ps, s+0x90)}')
        print(f'      qw10 pos={vec(ps, s+0xa0)} qw11={vec(ps, s+0xb0)} qw12={vec(ps, s+0xc0)} qw13={vec(ps, s+0xd0)}')
        print(f'      qw14 col={vec(ps, s+0xe0)} qw15={vec(ps, s+0xf0)} qw16={vec(ps, s+0x100)} qw17={vec(ps, s+0x110)} tex={u32(ps, s+0x140):#x} blend={u32(ps, s+0x144)}')
    # sys5
    b5 = 0xB600
    c5, h5 = u32(ps, b5 + 0xD50), u32(ps, b5 + 0xD54)
    print(f'-- sys5 powder: count {c5} head {h5} origin {vec(ps, b5)} travel {vec(ps, b5+0x10)} side {vec(ps, b5+0x20)} normal {vec(ps, b5+0x30)} color {vec(ps, b5+0x40)}')
    for k in range(min(c5, 6)):
        i = (h5 + c5 - 1 - k) % 64
        s = b5 + 0x50 + i * 52
        print(f'  slot[{i:2d}] age {f32(ps, s):.3f} uv {vec(ps, s+4)} scat {f32(ps, s+0x14):+.1f},{f32(ps, s+0x18):+.1f} var {u32(ps, s+0x1c)} '
              f'alpha {f32(ps, s+0x20):.3f} knee {f32(ps, s+0x24):.2f} life {f32(ps, s+0x28):.3f} maxsz {f32(ps, s+0x2c):.1f} grow {f32(ps, s+0x30):.1f}')
    # sys1
    c1, h1 = u32(ps, 0x1C10), u32(ps, 0x1C14)
    print(f'-- sys1 plume: count {c1} head {h1} ref {vec(ps, 0)}')
    for k in range(min(c1, 5)):
        i = (h1 + c1 - 1 - k) % 64
        s = 0x10 + i * 112
        print(f'  slot[{i:2d}] age {f32(ps, s):.3f} uv {vec(ps, s+4)} pos {vec(ps, s+0x20)} basis {vec(ps, s+0x30)} spr {u32(ps, s+0x40)} '
              f'peak {f32(ps, s+0x44):.3f} col {vec(ps, s+0x48)} knee {f32(ps, s+0x58):.2f} life {f32(ps, s+0x5c):.2f} floor {f32(ps, s+0x60):.1f} grow {f32(ps, s+0x64):.1f}')
    # sys4
    b4 = 0x99B0
    c4, h4 = u32(ps, b4 + 0x960), u32(ps, b4 + 0x964)
    print(f'-- sys4: count {c4} head {h4} B {f32(ps, b4+0x968):.3f} A {f32(ps, b4+0x96c):.3f}')
    for k in range(min(c4, 5)):
        i = (h4 + c4 - 1 - k) % 30
        s = b4 + i * 80
        print(f'  slot[{i:2d}] pos {vec(ps, s)} dir {vec(ps, s+0x10)} col {vec(ps, s+0x20)} uv {vec(ps, s+0x30)} {vec(ps, s+0x38, 2)} age {f32(ps, s+0x40):.3f} spr {u32(ps, s+0x44)} W {f32(ps, s+0x48):.4f}')
    # sys2
    b2 = 0x1C20
    c2, h2 = u32(ps, b2 + 0x50), u32(ps, b2 + 0x54)
    print(f'-- sys2 (75x160): armed {u32(ps, b2)} count {c2} head {h2} +30 {f32(ps, b2+0x30):.3f} +34 {f32(ps, b2+0x34):.3f} +38 {f32(ps, b2+0x38):.3f}')
    print(f'   ring +10 {vec(ps, b2+0x10)} +20 {vec(ps, b2+0x20)} +40 {vec(ps, b2+0x40)}')
    for k in list(range(min(c2, 6))) + ([c2 - 1] if c2 > 8 else []):
        i = (h2 + k) % 75          # newest at head, older at head+1, ...
        s = b2 + 0x60 + i * 160
        print(f'  slot[{i:2d}] age {f32(ps, s+0x94):.3f} p0 {vec(ps, s, 3)} p1 {vec(ps, s+0x10, 3)} p2 {vec(ps, s+0x20, 3)} p3 {vec(ps, s+0x30, 3)}')
        print(f'      +40 {vec(ps, s+0x40)} v1 {vec(ps, s+0x50)} v2 {vec(ps, s+0x60)} v3 {vec(ps, s+0x70)} uv/a +80 {vec(ps, s+0x80)} +90 {vec(ps, s+0x90)}')
    # wake header
    print(f'-- wake hdr +1940: {[u32(ps, 0x1940 + 4*i) for i in range(6)]}')


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'chain'
    if cmd == 'decode':
        decode(sys.argv[2]); return
    p = Pine()
    c = chain(p)
    if cmd == 'chain':
        print({k: hex(v) for k, v in c.items()}); return
    if cmd == 'watch':
        secs = float(sys.argv[2]) if len(sys.argv) > 2 else 10
        t0 = time.monotonic()
        while time.monotonic() - t0 < secs:
            print(summary_line(p, c), flush=True)
            time.sleep(0.066)
        return
    if cmd == 'snap':
        label = sys.argv[2] if len(sys.argv) > 2 else 'snap'
        print(summary_line(p, c))
        path = snap(p, c, label)
        decode(path)
        return


if __name__ == '__main__':
    main()
