import assert from 'node:assert/strict';
import { writableDisc } from '../src/app/export/ps2-iso-disc';

const readSlice = (slice: Blob) => (slice as ByteBlob).data;
// Supply a disc-sized address space with a few bytes materialized at a time.
class ByteBlob extends Blob {
  constructor(
    readonly data: Uint8Array<ArrayBuffer>,
    readonly virtualSize = data.length,
  ) {
    super([data]);
  }
  override get size() {
    return this.virtualSize;
  }
  override slice(start = 0, end = this.size) {
    const limit = Math.max(start, Math.min(end, this.size));
    const bytes = this.data.length
      ? this.data.slice(start, limit)
      : Uint8Array.from({ length: limit - start }, (_, index) => (start + index) % 251);
    return new ByteBlob(bytes);
  }
}

const high = 2 ** 31 - 1;
const large = writableDisc(new ByteBlob(new Uint8Array(), 2_902_425_600), readSlice).disc;
const bytes = new Uint8Array(6);
assert.equal(large.write(Uint8Array.of(101, 102, 103), high), 3);
assert.equal(large.read(bytes, high - 1), bytes.length);
assert.deepEqual([...bytes], [(high - 1) % 251, 101, 102, 103, (high + 3) % 251, (high + 4) % 251]);
assert.equal(large.size(), 2_902_425_600);

const source = new ByteBlob(Uint8Array.of(1, 2, 3, 4, 5));
const { disc, output } = writableDisc(source, readSlice);
disc.write(Uint8Array.of(11, 12), 2);
disc.resize(3);
disc.resize(7);
disc.write(Uint8Array.of(9), 8);
assert.deepEqual([...new Uint8Array(await output().arrayBuffer())], [1, 2, 11, 0, 0, 0, 0, 0, 9]);
assert.deepEqual([...new Uint8Array(await source.arrayBuffer())], [1, 2, 3, 4, 5]);
