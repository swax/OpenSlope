// Minimal MIPS R5900 disassembler over the EE RAM dump. Usage: node dis.mjs <hexaddr> [count]
import fs from 'node:fs';
const ee = fs.readFileSync(new URL('./ee.bin', import.meta.url));
const R = ['zero','at','v0','v1','a0','a1','a2','a3','t0','t1','t2','t3','t4','t5','t6','t7',
           's0','s1','s2','s3','s4','s5','s6','s7','t8','t9','k0','k1','gp','sp','fp','ra'];
const F = i => `f${i}`;
const s16 = v => (v & 0x8000) ? v - 0x10000 : v;
const hx = v => (v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16));

const SPECIAL = {
  0x00:'sll',0x02:'srl',0x03:'sra',0x04:'sllv',0x06:'srlv',0x07:'srav',0x08:'jr',0x09:'jalr',
  0x0a:'movz',0x0b:'movn',0x0c:'syscall',0x0d:'break',0x0f:'sync',0x10:'mfhi',0x11:'mthi',
  0x12:'mflo',0x13:'mtlo',0x14:'dsllv',0x16:'dsrlv',0x17:'dsrav',0x18:'mult',0x19:'multu',
  0x1a:'div',0x1b:'divu',0x1c:'dmult',0x1d:'dmultu',0x1e:'ddiv',0x1f:'ddivu',
  0x20:'add',0x21:'addu',0x22:'sub',0x23:'subu',0x24:'and',0x25:'or',0x26:'xor',0x27:'nor',
  0x2a:'slt',0x2b:'sltu',0x2c:'dadd',0x2d:'daddu',0x2e:'dsub',0x2f:'dsubu',
  0x38:'dsll',0x3a:'dsrl',0x3b:'dsra',0x3c:'dsll32',0x3e:'dsrl32',0x3f:'dsra32',
};
const OPS = {
  0x02:'j',0x03:'jal',0x04:'beq',0x05:'bne',0x06:'blez',0x07:'bgtz',0x08:'addi',0x09:'addiu',
  0x0a:'slti',0x0b:'sltiu',0x0c:'andi',0x0d:'ori',0x0e:'xori',0x0f:'lui',
  0x14:'beql',0x15:'bnel',0x16:'blezl',0x17:'bgtzl',0x18:'daddi',0x19:'daddiu',
  0x1a:'ldl',0x1b:'ldr',0x1e:'lq',0x1f:'sq',
  0x20:'lb',0x21:'lh',0x22:'lwl',0x23:'lw',0x24:'lbu',0x25:'lhu',0x26:'lwr',0x27:'lwu',
  0x28:'sb',0x29:'sh',0x2a:'swl',0x2b:'sw',0x2c:'sdl',0x2d:'sdr',0x2e:'swr',0x2f:'cache',
  0x31:'lwc1',0x36:'ldc2',0x37:'ld',0x39:'swc1',0x3e:'sdc2',0x3f:'sd',
};
const COP1 = {0x00:'add.s',0x01:'sub.s',0x02:'mul.s',0x03:'div.s',0x04:'sqrt.s',0x05:'abs.s',
  0x06:'mov.s',0x07:'neg.s',0x16:'rsqrt.s',0x18:'adda.s',0x19:'suba.s',0x1a:'mula.s',
  0x1c:'madd.s',0x1d:'msub.s',0x1e:'madda.s',0x1f:'msuba.s',0x24:'cvt.w.s',
  0x28:'max.s',0x29:'min.s',0x30:'c.f.s',0x32:'c.eq.s',0x34:'c.lt.s',0x36:'c.le.s'};

export function dis(a, w) {
  const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31,
        sa = (w >>> 6) & 31, fn = w & 63, imm = w & 0xffff, si = s16(imm);
  const tgt = a + 4 + si * 4;
  if (w === 0) return 'nop';
  if (op === 0) {
    const m = SPECIAL[fn]; if (!m) return `.word 0x${w.toString(16)}`;
    if (['sll','srl','sra','dsll','dsrl','dsra','dsll32','dsrl32','dsra32'].includes(m)) return `${m} ${R[rd]},${R[rt]},${sa}`;
    if (m === 'jr') return `jr ${R[rs]}`;
    if (m === 'jalr') return `jalr ${R[rd]},${R[rs]}`;
    if (['mfhi','mflo'].includes(m)) return `${m} ${R[rd]}`;
    if (['mthi','mtlo'].includes(m)) return `${m} ${R[rs]}`;
    if (['mult','multu','div','divu','dmult','dmultu','ddiv','ddivu'].includes(m)) return `${m} ${R[rs]},${R[rt]}`;
    return `${m} ${R[rd]},${R[rs]},${R[rt]}`;
  }
  if (op === 1) { const b = {0:'bltz',1:'bgez',2:'bltzl',3:'bgezl',16:'bltzal',17:'bgezal'}[rt] ?? `regimm${rt}`;
    return `${b} ${R[rs]},0x${tgt.toString(16)}`; }
  if (op === 0x11) { // COP1
    if (rs === 0) return `mfc1 ${R[rt]},${F(rd)}`;
    if (rs === 4) return `mtc1 ${R[rt]},${F(rd)}`;
    if (rs === 2) return `cfc1 ${R[rt]},${rd}`;
    if (rs === 6) return `ctc1 ${R[rt]},${rd}`;
    if (rs === 8) return `${rt & 1 ? 'bc1t' : 'bc1f'}${rt & 2 ? 'l' : ''} 0x${tgt.toString(16)}`;
    if (rs === 16) { const m = COP1[fn] ?? `cop1.${fn.toString(16)}`;
      if (m === 'cvt.w.s') return `cvt.w.s ${F(sa)},${F(rd)}`;
      if (m.startsWith('c.')) return `${m} ${F(rd)},${F(rt)}`;
      if (['sqrt.s','abs.s','mov.s','neg.s','rsqrt.s','cvt.s.w'].includes(m)) return `${m} ${F(sa)},${F(rd)}`;
      if (['adda.s','suba.s','mula.s','madda.s','msuba.s'].includes(m)) return `${m} ${F(rd)},${F(rt)}`;
      return `${m} ${F(sa)},${F(rd)},${F(rt)}`; }
    if (rs === 20) return `cvt.s.w ${F(sa)},${F(rd)}`;
    return `cop1 0x${w.toString(16)}`;
  }
  if (op === 0x12) return `cop2 0x${w.toString(16)}`;
  if (op === 0x1c) { // MMI
    if (fn === 0x18) return `mult1 ${R[rd]},${R[rs]},${R[rt]}`;
    if (fn === 0x1b) return `divu1 ${R[rs]},${R[rt]}`;
    if (fn === 0x12) return `mflo1 ${R[rd]}`;
    if (fn === 0x10) return `mfhi1 ${R[rd]}`;
    return `mmi 0x${w.toString(16)}`;
  }
  const m = OPS[op]; if (!m) return `.word 0x${w.toString(16)}`;
  if (m === 'lui') return `lui ${R[rt]},0x${imm.toString(16)}`;
  if (['j','jal'].includes(m)) return `${m} 0x${(((a + 4) & 0xf0000000) | ((w & 0x3ffffff) << 2)).toString(16)}`;
  if (['beq','bne','beql','bnel'].includes(m)) return `${m} ${R[rs]},${R[rt]},0x${tgt.toString(16)}`;
  if (['blez','bgtz','blezl','bgtzl'].includes(m)) return `${m} ${R[rs]},0x${tgt.toString(16)}`;
  if (['lwc1','swc1'].includes(m)) return `${m} ${F(rt)},${hx(si)}(${R[rs]})`;
  if (['ldc2','sdc2'].includes(m)) return `${m} vf${rt},${hx(si)}(${R[rs]})`;
  if (OPS[op] && op >= 0x20) return `${m} ${R[rt]},${hx(si)}(${R[rs]})`;
  if (['lq','sq'].includes(m)) return `${m} ${R[rt]},${hx(si)}(${R[rs]})`;
  return `${m} ${R[rt]},${R[rs]},${hx(si)}`;
}

if (process.argv[1] && process.argv[1].endsWith('dis.mjs')) {
  const a0 = parseInt(process.argv[2], 16);
  const n = parseInt(process.argv[3] ?? '60', 10);
  for (let i = 0; i < n; i++) {
    const a = a0 + i * 4, w = ee.readUInt32LE(a);
    console.log(`${a.toString(16).padStart(8, '0')}: ${w.toString(16).padStart(8, '0')}  ${dis(a, w)}`);
  }
}
