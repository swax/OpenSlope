interface Codec {
  ccall(name: string, result: string, types: string[], args: string[]): string;
  FS: {
    writeFile(path: string, bytes: Uint8Array): void;
    readFile(path: string): Uint8Array<ArrayBuffer>;
    unlink(path: string): void;
  };
}
let runtime: Promise<Codec> | undefined;
async function encode(blob: Blob): Promise<Blob> {
  runtime ??= (async () => {
    const assetUrl = (name: string) => new URL(`/iso-importer/${name}?v=36`, self.location.origin).href;
    const factory = (await import(/* @vite-ignore */ assetUrl('openslope_browser_import.js'))) as {
      default(options: { locateFile: (name: string) => string }): Promise<Codec>;
    };
    return factory.default({ locateFile: assetUrl });
  })();
  const codec = await runtime;
  try {
    codec.FS.writeFile('/input.wav', new Uint8Array(await blob.arrayBuffer()));
    const result = JSON.parse(codec.ccall('browser_encode_music', 'string', [], [])) as { error?: string };
    if (result.error) throw new Error(result.error);
    return new Blob([codec.FS.readFile('/output.opus')], { type: 'audio/ogg; codecs=opus' });
  } finally {
    for (const path of ['/input.wav', '/output.opus']) {
      try {
        codec.FS.unlink(path);
      } catch {
        /* A failed conversion may not have produced output. */
      }
    }
  }
}
let serial = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<{ id: number; blob: Blob }>) => {
  serial = serial.then(async () => {
    try {
      self.postMessage({ id: data.id, blob: await encode(data.blob) });
    } catch (error) {
      self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
