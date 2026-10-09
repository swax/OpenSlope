import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { build, output, root } from './build.mjs';

await build();
const portArg = process.argv.indexOf('--port');
const port = Number(portArg === -1 ? 4173 : process.argv[portArg + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use --port followed by a port from 1 to 65535.');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8' };
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400).end('Invalid URL'); return; }
  const file = resolve(output, '.' + pathname);
  const within = relative(output, file);
  if (within === '..' || within.startsWith('..' + sep) || within.includes(':') || pathname.includes('\0')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory() && !pathname.endsWith('/')) {
      response.writeHead(301, { Location: pathname + '/' }).end();
      return;
    }
    const target = info.isDirectory() ? join(file, 'index.html') : file;
    const data = await readFile(target);
    response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream' });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) console.error(error.message);
    const data = await readFile(join(output, '404.html'));
    response.writeHead(404, { 'Content-Type': types['.html'] });
    response.end(request.method === 'HEAD' ? undefined : data);
  }
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Try npm run dev -- --port 4174.` : error); process.exitCode = 1; for (const watcher of watchers) watcher.close(); });
server.listen(port, '127.0.0.1', () => console.log(`Slopesmith website: http://localhost:${port}\nWatching source files. Refresh your browser after changes. Ctrl+C to stop.`));
let timer;
let rebuilding = Promise.resolve();
const watchers = ['src', 'public', 'media.json', 'image-captions.json'].map(source => watch(join(root, source), { recursive: !source.endsWith('.json') }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => { rebuilding = rebuilding.then(build).catch(error => console.error('Build failed:', error.message)); }, 120);
}));
process.on('SIGINT', () => { for (const watcher of watchers) watcher.close(); server.close(); });
