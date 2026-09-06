// tier: fast

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import {
  CUSTOM_ASSET_CACHE_CONTROL, referenceAssetCacheControl, REFERENCE_ASSET_CACHE_CONTROL,
  UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL,
} from '../src/server/api/common';

const apache = await readFile(new URL('../deploy/apache-slopesmith.conf.example', import.meta.url), 'utf8');
const caddy = await readFile(new URL('../deploy/Caddyfile.example', import.meta.url), 'utf8');

assert.match(apache, /<VirtualHost \*:443>[\s\S]*?\bProtocols h2 http\/1\.1\b/,
  'the Apache TLS vhost advertises HTTP/2 with an HTTP/1.1 fallback');
assert.match(apache, /<Location \/characters\/>[\s\S]*?max-age=31536000, immutable/,
  'Apache permanently caches revisioned built-in characters');
assert.match(caddy, /@immutable path \/assets\/\* \/characters\/\*/,
  'Caddy permanently caches both fingerprinted static asset families');
assert.equal(CUSTOM_ASSET_CACHE_CONTROL, 'private, max-age=31536000, immutable',
  'authenticated immutable API assets stay in one member browser and skip revalidation for one year');
assert.equal(UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, 'private, max-age=3600',
  'protected reference images and audio remain private while retaining bounded browser caching');
assert.equal(REFERENCE_ASSET_CACHE_CONTROL({ url: '/asset?v=right' } as IncomingMessage, '"right"'),
  CUSTOM_ASSET_CACHE_CONTROL, 'a matching content revision makes a reference URL immutable');
assert.equal(REFERENCE_ASSET_CACHE_CONTROL({ url: '/asset?v=stale' } as IncomingMessage, '"right"'),
  UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, 'a stale content revision cannot pin new bytes under its old URL');
assert.equal(REFERENCE_ASSET_CACHE_CONTROL({ url: '/asset' } as IncomingMessage, '"right"'),
  UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL, 'an older unversioned client keeps bounded, revalidatable caching');
assert.equal(referenceAssetCacheControl('source-revision')(
  { url: '/asset?v=source-revision' } as IncomingMessage, '"derived-response-revision"'),
  CUSTOM_ASSET_CACHE_CONTROL, 'a deterministic derived asset is versioned by its complete source digest');

console.log('DELIVERY CACHE PASS');
