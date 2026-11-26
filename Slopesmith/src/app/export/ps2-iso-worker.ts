/// <reference lib="webworker" />
import { DISC_SLOT } from '../../core/export/disc';
import { writableDisc, type DiscFile } from './ps2-iso-disc';

export interface BuildIsoRequest {
  iso: File;
  archive: Blob;
}
export type BuildIsoReply =
  | { type: 'progress'; message: string }
  | { type: 'done'; output: Blob; log: string[] }
  | { type: 'error'; message: string };

interface RuntimeManifest {
  version: string;
  assemblies: string[];
  patches: string[];
}
interface FileAttributes {
  size?: number;
}
interface Stream {
  position: number;
}
interface FsNode {
  node_ops: {
    getattr(node: FsNode): { size: number; blocks: number };
    setattr(node: FsNode, attrs: FileAttributes): void;
  };
  stream_ops: {
    llseek(stream: Stream, offset: number, whence: number): number;
    read(stream: Stream, buffer: Uint8Array, offset: number, length: number, position: number): number;
    write(stream: Stream, buffer: Uint8Array, offset: number, length: number, position: number): number;
  };
}
interface FileSystem {
  lookupPath(path: string): { node: FsNode };
  mkdirTree(path: string): void;
  readFile(path: string): Uint8Array;
  writeFile(path: string, content: Uint8Array): void;
}
interface Runtime {
  Module: { FS: FileSystem };
  runMain(assembly: string, args: string[]): Promise<number>;
}
interface RuntimeBuilder {
  withConfig(config: object): RuntimeBuilder;
  withModuleConfig(config: { print(line: string): void; printErr(line: string): void }): RuntimeBuilder;
  create(): Promise<Runtime>;
}

// The prebuilt Mono browser runtime uses Emscripten's virtual filesystem.
// Adapt only the two multi-gigabyte disc files. The rest are ordinary files.
function mountDisc(fs: FileSystem, path: string, disc: DiscFile) {
  fs.writeFile(path, new Uint8Array());
  const { node } = fs.lookupPath(path);
  const standard = node.node_ops;
  node.node_ops = {
    ...standard,
    getattr(node) {
      const stat = standard.getattr(node);
      stat.size = disc.size();
      stat.blocks = Math.ceil(stat.size / 4096);
      return stat;
    },
    setattr(node, { size, ...metadata }) {
      if (size !== undefined) disc.resize(size);
      standard.setattr(node, metadata);
    },
  };
  node.stream_ops = {
    ...node.stream_ops,
    llseek(stream, offset, whence) {
      return offset + (whence === 2 ? disc.size() : whence === 1 ? stream.position : 0);
    },
    read: (_stream, bytes, offset, count, pos) => disc.read(bytes.subarray(offset, offset + count), pos),
    write: (_stream, bytes, offset, count, pos) => disc.write(bytes.subarray(offset, offset + count), pos),
  };
}

function send(reply: BuildIsoReply) {
  self.postMessage(reply);
}

async function startRuntime(log: string[], errors: string[]) {
  const response = await fetch('/snowknife/manifest.json', { cache: 'no-cache' });
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json'))
    throw new Error('Snowknife is unavailable on this server. The Snowknife ZIP export is available for CLI builds.');
  const manifest = (await response.json()) as RuntimeManifest;
  const assetUrl = (name: string) => new URL(`/snowknife/${manifest.version}/${name}`, self.location.origin).href;
  const { dotnet } = (await import(/* @vite-ignore */ assetUrl('dotnet.js'))) as { dotnet: RuntimeBuilder };
  const resource = (name: string) => ({ name, resolvedUrl: assetUrl(name) });
  const runtime = await dotnet
    .withConfig({
      mainAssemblyName: 'snowknife.dll',
      globalizationMode: 'invariant',
      debugLevel: 0,
      runtimeOptions: [],
      environmentVariables: { NO_COLOR: '1' },
      runtimeConfig: { configProperties: { 'System.Globalization.Invariant': true } },
      resources: {
        assembly: manifest.assemblies.map(name => ({ ...resource(name), virtualPath: name })),
        jsModuleNative: [resource('dotnet.native.js')],
        jsModuleRuntime: [resource('dotnet.runtime.js')],
        wasmNative: [resource('dotnet.native.wasm')],
      },
    })
    .withModuleConfig({
      print: line => log.push(line),
      printErr: line => errors.push(line),
    })
    .create();
  const fs = runtime.Module.FS;
  for (const path of manifest.patches) {
    const patch = await fetch(assetUrl(path));
    if (!patch.ok) throw new Error(`Could not load Snowknife data: ${path}`);
    fs.mkdirTree('/' + path.slice(0, path.lastIndexOf('/')));
    fs.writeFile('/' + path, new Uint8Array(await patch.arrayBuffer()));
  }
  return runtime;
}

async function build({ data: { iso, archive } }: MessageEvent<BuildIsoRequest>) {
  const log: string[] = [];
  const errors: string[] = [];
  const progress = (message: string) => send({ type: 'progress', message });
  try {
    progress('Loading Snowknife…');
    const runtime = await startRuntime(log, errors);
    const fs = runtime.Module.FS;
    const reader = new FileReaderSync();
    const readSlice = (slice: Blob) => new Uint8Array(reader.readAsArrayBuffer(slice));
    const readOnly = () => {
      throw new Error('The source ISO is read-only.');
    };
    const retail = '/input/source.iso';
    const result = '/result.iso';
    const donor = '/Maps/TRICKY_GARI';
    const archivePath = '/input/map.snowknife.zip';
    fs.mkdirTree('/input');
    mountDisc(fs, retail, {
      size: () => iso.size,
      read(bytes, offset) {
        const chunk = readSlice(iso.slice(offset, offset + bytes.length));
        bytes.set(chunk);
        return chunk.length;
      },
      write: readOnly,
      resize: readOnly,
    });

    progress('Checking the source ISO…');
    const assembly = 'snowknife.dll';
    const system = '/input/system.cnf';
    const bootStatus = await runtime.runMain(assembly, ['iso-extract', retail, 'SYSTEM.CNF', system]);
    if (
      bootStatus !== 0 ||
      !/BOOT2\s*=\s*cdrom0:\\?SLUS_203\.26(?:;1)?\b/i.test(new TextDecoder().decode(fs.readFile(system)))
    )
      throw new Error('Choose an SSX Tricky (USA) PlayStation 2 ISO.');
    errors.length = 0;

    async function run(args: string[]) {
      const first = log.length;
      const exitCode = await runtime.runMain(assembly, args);
      if (exitCode !== 0) {
        const reason = [...errors, ...log.slice(first)].find(line => /^\s*ERROR:/i.test(line));
        throw new Error(reason?.trim() || `Snowknife ${args[0]} failed (exit ${exitCode}).`);
      }
    }
    progress('Preparing Garibaldi from the source ISO…');
    await run(['import', retail, DISC_SLOT, donor]);
    log.length = 0;
    errors.length = 0;

    progress('Building the new ISO…');
    const output = writableDisc(iso, readSlice);
    mountDisc(fs, result, output.disc);
    fs.writeFile(archivePath, new Uint8Array(await archive.arrayBuffer()));
    await run([
      'repack',
      retail,
      DISC_SLOT,
      donor,
      archivePath,
      result,
      '--texture-type2',
      '--bare-slot',
      '--no-skycolor',
      '--in-place',
    ]);
    progress('Saving the finished ISO…');
    send({ type: 'done', output: output.output(), log });
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

// Mono checks global onmessage while deciding whether this is its own worker.
self.addEventListener('message', build, { once: true });
