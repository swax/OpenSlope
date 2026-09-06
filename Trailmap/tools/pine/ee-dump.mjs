// ee-dump.mjs — snapshot all 32 MB of PS2 EE RAM over PINE into ee.bin. READ-ONLY (opcode 3 only).
import fs from 'node:fs';
import { Pine } from './pinelib.mjs';
export async function snapshot(port = 28011, out = new URL('./ee.bin', import.meta.url)) {
  const p = await new Pine(port).connect();
  const info = await p.info();
  const parts = [];
  for (let a = 0; a < 0x02000000; a += 0x100000) parts.push(await p.readBlock(a, 0x100000, 40000));
  p.close();
  const buf = Buffer.concat(parts);
  fs.writeFileSync(out, buf);
  return info;
}
if (process.argv[1]?.endsWith('ee-dump.mjs')) {
  const t = Date.now();
  console.log(await snapshot(Number(process.argv[2] ?? 28011)), `${Date.now() - t} ms`);
}
