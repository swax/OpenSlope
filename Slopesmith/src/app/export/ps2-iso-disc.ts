export interface DiscFile {
  size(): number;
  read(buffer: Uint8Array, position: number): number;
  write(buffer: Uint8Array, position: number): number;
  resize(size: number): void;
}

// Keep reads bounded and hold only dirty pages in memory. Unchanged ranges of
// the original File become Blob slices when the browser saves the new disc.
export function writableDisc(source: Blob, readSlice: (slice: Blob) => Uint8Array) {
  const pageSize = 64 * 1024;
  const pages = new Map<number, Uint8Array<ArrayBuffer>>();
  let length = source.size;
  let originalEnd = source.size;
  const original = (position: number, count: number) =>
    readSlice(source.slice(position, Math.min(originalEnd, position + count)));

  const disc: DiscFile = {
    size: () => length,
    read(buffer, position) {
      const count = Math.max(0, Math.min(buffer.length, length - position));
      for (let n = 0; n < count;) {
        const start = Math.floor((position + n) / pageSize) * pageSize;
        const offset = position + n - start;
        const size = Math.min(pageSize - offset, count - n);
        const page = pages.get(start);
        const destination = buffer.subarray(n, n + size);
        if (page) destination.set(page.subarray(offset, offset + size));
        else {
          destination.fill(0);
          destination.set(original(position + n, size));
        }
        n += size;
      }
      return count;
    },
    write(buffer, position) {
      for (let n = 0; n < buffer.length;) {
        const start = Math.floor((position + n) / pageSize) * pageSize;
        const offset = position + n - start;
        const size = Math.min(pageSize - offset, buffer.length - n);
        let page = pages.get(start);
        if (!page) {
          page = new Uint8Array(pageSize);
          page.set(original(start, pageSize));
          pages.set(start, page);
        }
        page.set(buffer.subarray(n, n + size), offset);
        n += size;
      }
      if (buffer.length) length = Math.max(length, position + buffer.length);
      return buffer.length;
    },
    resize(size) {
      if (size < length) {
        originalEnd = Math.min(originalEnd, size);
        for (const [start, page] of pages) {
          if (start >= size) pages.delete(start);
          else if (start + pageSize > size) page.fill(0, size - start);
        }
      }
      length = size;
    },
  };
  function output() {
    const parts: BlobPart[] = [];
    const zeros = new Uint8Array(pageSize);
    function appendUnchanged(from: number, to: number) {
      if (from < originalEnd && from < to) parts.push(source.slice(from, Math.min(to, originalEnd)));
      for (let remaining = to - Math.max(from, originalEnd); remaining > 0; remaining -= pageSize) {
        parts.push(zeros.subarray(0, Math.min(remaining, pageSize)));
      }
    }
    let end = 0;
    for (const [start, page] of [...pages].sort(([a], [b]) => a - b)) {
      appendUnchanged(end, start);
      end = Math.min(length, start + pageSize);
      parts.push(page.subarray(0, end - start));
    }
    appendUnchanged(end, length);
    return new Blob(parts, { type: 'application/octet-stream' });
  }
  return { disc, output };
}
