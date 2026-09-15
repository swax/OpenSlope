"""Check algebra against an independent interpreter of the two PAL leaf functions.

Finite normal inputs only: this checks scalar control flow and formulas, not PS2
floating-point exception/denormal behavior or a complete live ground tick.
Run from the repository root with:
python -B Trailmap/tools/analysis/verify_carving_response.py --elf <locally extracted PAL ELF>
Use --write-cases <path> to regenerate the small synthetic interoperability fixtures.
"""
import argparse
import json
import random
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'Trailmap/tools/analysis'))
from ssx_analyze import Elf

def f32(x):
    return struct.unpack('<f', struct.pack('<f', x))[0]

def bits(x):
    return struct.unpack('<I', struct.pack('<f', x))[0]

def number(x):
    return struct.unpack('<f', struct.pack('<I', x & 0xffffffff))[0]

def C(x):
    return number(int(x, 16))

def signed(x, width=32):
    return x - (1 << width) if x & (1 << (width - 1)) else x

def stance_factor(p):
    if p['edge'] == p['preferred'] or p['mode'] == 1:
        return 1.0
    return C('3f599887') if p['mode'] == 0 else C('3f332b3a')

def tangent_formula(p):
    u, q = p['u'], max(1.0, p['loadRatio'])
    norm = C('3b808081')
    k = stance_factor(p)
    r_a = ((C('3f35280e') + C('be9a9d02') * p['b0e'] * norm)
           if p['mode'] == 2 else
           (C('3f885156') + C('be9dedd8') * p['b0e'] * norm)) * k
    r_c = (C('3fa474ac') + C('be94a934') * p['b19'] * norm) * k
    r_slip = (C('3f1d7729') + C('3f6b0db3') * p['b11'] * norm) * k
    x = abs(u) * C('3a83126f')
    depth = 0.5 - p['error'] / p['budget'] if p['surface'] in (3, 4) else 1.0
    return -u * depth * (
        q * p['a'] * r_a
        + (1 - p['charge']) * C('3dd88842')
        + (1 + p['boost'] * C('3f9b9134')) * C('3fe02ad9') * p['rawSlip']**2 * r_slip
        + x * (q * p['b'] + x * q * p['c'] * r_c)
    )

def lateral_formula(p):
    u = abs(p['u'])
    if u < C('440ae38e'):
        gain = C('3e4ddca7') + u * C('3a694d0d')
    elif u < C('44ad9c71'):
        gain = C('3f320a14') + (u - C('440ae38e')) * C('39bd6c97')
    else:
        gain = C('3f7f1dc3') + (u - C('44ad9c71')) * C('b8daf865')
    lean_gain = max(1.0, abs(p['lean']) * C('3f8004dd'))
    rider_gain = (C('3a83126f') + p['b13'] * C('3f92136a') * C('3b808081')) * stance_factor(p)
    boost_gain = 1 / (1 + C('405fffe9') * p['boost']) if p['boost'] > 0 else 1.0
    return -p['w'] * gain * lean_gain * p['drag'] * rider_gain * boost_gain

class LeafInterpreter:
    def __init__(self, elf, p, lateral):
        self.elf, self.g, self.f, self.mem = elf, [0]*32, [0]*32, {}
        self.condition = False
        self.seen = set()
        ctx, board, rider, surface = 0x1000000, 0x1001000, 0x1002000, 0x1003000
        self.g[4], self.g[5], self.g[31] = ctx, surface, 0
        self.word(ctx + 12, board)
        self.word(board + 0x464, rider)
        for offset, key in [(0x420, 'mode'), (0x1b4, 'edge'), (0x290, 'surface')]:
            self.word(board + offset, p[key])
        self.word(rider + 0x40, p['preferred'])
        for offset, key in [(0x0e,'b0e'), (0x11,'b11'), (0x13,'b13'), (0x19,'b19')]:
            self.mem[rider + offset] = p[key]
        for offset, key in [(0x130,'boost'), (0x1fc,'rawSlip'), (0x208,'charge'), (0x1bc,'error'), (0x298,'budget')]:
            self.word(board + offset, bits(p[key]))
        for offset, key in [(4,'a'), (8,'b'), (12,'c'), (16,'drag')]:
            self.word(surface + offset, bits(p[key]))
        self.f[12] = bits(p['w'] if lateral else p['u'])
        self.f[13] = bits(p['u'] if lateral else p['loadRatio'])
        self.f[14] = bits(p['lean'])

    def word(self, addr, value):
        for i in range(4):
            self.mem[addr+i] = (value >> (8*i)) & 255

    def read(self, addr):
        return sum(self.mem[addr+i] << (8*i) for i in range(4))

    def step(self, pc):
        self.seen.add(pc)
        ins = self.elf.u32_addr(pc)
        op, rs, rt, rd = ins >> 26, (ins >> 21)&31, (ins >> 16)&31, (ins >> 11)&31
        imm, fn = signed(ins & 65535, 16), ins & 63
        g, f = self.g, self.f
        flow = None
        if ins == 0:
            pass
        elif op == 0:
            if fn == 0x2d: g[rd] = g[rs] + g[rt]
            elif fn == 8: flow = (g[rs], False)
            else: raise ValueError(hex(ins))
        elif op == 15: g[rt] = (ins & 65535) << 16
        elif op == 13: g[rt] = g[rs] | (ins & 65535)
        elif op == 9: g[rt] = (g[rs] + imm) & 0xffffffff
        elif op == 11: g[rt] = int((g[rs] & 0xffffffff) < (imm & 0xffffffff))
        elif op == 35: g[rt] = self.read(g[rs] + imm)
        elif op == 36: g[rt] = self.mem[g[rs] + imm]
        elif op == 49: f[rt] = self.read(g[rs] + imm)
        elif op in (4,5,20,21):
            take = (g[rs] == g[rt]) if op in (4,20) else (g[rs] != g[rt])
            flow = (pc + 4 + imm*4 if take else pc + 8, op in (20,21) and not take)
        elif op == 17:
            if rs == 4: f[rd] = g[rt] & 0xffffffff
            elif rs == 8:
                take = self.condition == bool(rt & 1)
                flow = (pc + 4 + imm*4 if take else pc + 8, bool(rt & 2) and not take)
            elif rs == 20 and fn == 32: f[(ins >> 6)&31] = bits(float(signed(f[rd])))
            elif rs == 16:
                fs, ft, fd = rd, rt, (ins >> 6)&31
                a, b = number(f[fs]), number(f[ft])
                if fn == 0: out = a + b
                elif fn == 1: out = a - b
                elif fn == 2: out = a * b
                elif fn == 3: out = a / b
                elif fn == 5: out = abs(a)
                elif fn == 6: out = a
                elif fn == 7: out = -a
                elif fn == 52: self.condition = a < b; return flow
                elif fn == 50: self.condition = a == b; return flow
                else: raise ValueError(hex(ins))
                f[fd] = bits(out)
            else: raise ValueError(hex(ins))
        else: raise ValueError(hex(ins))
        g[0] = 0
        return flow

    def run(self, pc):
        for _ in range(400):
            flow = self.step(pc)
            if flow is None:
                pc += 4
            else:
                target, annul = flow
                if not annul:
                    assert self.step(pc+4) is None
                if target == 0: return number(self.f[0])
                pc = target
        raise RuntimeError('instruction bound exceeded')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--elf', type=Path, default=ROOT / 'Trailmap/extracted/SLES_505.45')
    parser.add_argument('--write-cases', type=Path)
    args = parser.parse_args()
    elf = Elf(args.elf)
    cases = []
    rng = random.Random(330)
    coverage = [set(), set()]
    max_error = [0.0, 0.0]
    for i in range(3000):
        p = dict(u=rng.uniform(-4500,4500), w=rng.uniform(-2500,2500),
                 loadRatio=rng.uniform(-2,4), lean=rng.uniform(-1.2,1.2),
                 mode=i%4, edge=i%2, preferred=(i//4)%2, surface=i%20,
                 b0e=rng.randrange(256), b11=rng.randrange(256), b13=rng.randrange(256), b19=rng.randrange(256),
                 boost=rng.choice([0, rng.uniform(-.1,1)]), rawSlip=rng.uniform(-1,1),
                 charge=rng.random(), error=rng.uniform(-40,2), budget=rng.uniform(1,40),
                 a=rng.uniform(0,.15), b=rng.uniform(0,.15), c=rng.uniform(0,.05), drag=rng.uniform(0,3.5))
        # Include both signs, zero and the piecewise boundaries explicitly.
        if i < 12:
            p['u'] = [0, C('440ae38e'), C('44ad9c71'), -C('440ae38e'), -C('44ad9c71'), 1500][i%6]
        p = {k: f32(v) if isinstance(v,float) else v for k,v in p.items()}
        expected_outputs = []
        for j, (addr, formula) in enumerate([(0x109cb8,tangent_formula), (0x109ef8,lateral_formula)]):
            vm = LeafInterpreter(elf,p,j==1)
            actual, expected = vm.run(addr), formula(p)
            error = abs(actual-expected) / max(1,abs(actual),abs(expected))
            assert error < 2e-6, (i, hex(addr), actual, expected, p)
            max_error[j] = max(max_error[j],error)
            coverage[j].update(vm.seen)
            expected_outputs.append(actual / 100)
        if i < 60:
            cases.append({
                'surface': {'type':p['surface'], 'resistanceA':p['a'], 'resistanceB':p['b'],
                            'resistanceC':p['c'], 'drag':p['drag']},
                'u':p['u']/100, 'w':p['w']/100, 'error':p['error']/100, 'budget':p['budget']/100,
                'lean':p['lean'], 'charge':p['charge'], 'boost':p['boost'],
                'tuning': {'linearStat':p['b0e']/255, 'quadraticStat':p['b19']/255,
                           'skidStat':p['b11']/255, 'lateralStat':p['b13']/255,
                           'mode':p['mode'], 'edge':p['edge'], 'preferredEdge':p['preferred'],
                           'loadRatio':p['loadRatio'], 'skid':p['rawSlip']},
                'forwardAcceleration':expected_outputs[0], 'lateralAcceleration':expected_outputs[1],
            })
    for j,(start,end) in enumerate([(0x109cb8,0x109ef8),(0x109ef8,0x10a0d4)]):
        missing = set(range(start,end,4)) - coverage[j]
        assert not missing, sorted(map(hex,missing))
    print('PASS: 3000 input cases per helper; every instruction covered, including branch-likely delay slots.')
    print('Maximum relative/scaled errors:',max_error)
    if args.write_cases:
        args.write_cases.write_text(json.dumps({'schema':'carving-response-cases/v1',
            'source':'Synthetic inputs evaluated by an independent scalar interpreter; [Trailmap: 330-resistance, 330-lateral].',
            'cases':cases}, indent=2) + '\n', encoding='utf-8')
    print('Limitation: an independent scalar interpreter, not a live PS2 execution or a whole-ground-tick test.')

if __name__ == '__main__':
    main()
