import { assetDefinitionHash, propAssetDefinition, sha256 } from './asset-hash';
import type { AssetMigrationReference } from './asset-migration';
import type { ReferenceAsset } from './asset-manifest';
import type { PropsPayload } from './props';

/** Read the old reference through the same transport as the editor, not through the proposed identity. */
export function createAssetMigrationVerifier(reader: {
  texture(level: string, name: string): Promise<Uint8Array>;
  props(level: string): Promise<PropsPayload>;
}) {
  const textures = new Map<string, Promise<string>>();
  const props = new Map<string, Promise<PropsPayload>>();
  function textureHash(level: string, name: string) {
    const key = JSON.stringify([level, name]);
    let pending = textures.get(key);
    if (!pending) {
      pending = reader.texture(level, name).then(sha256);
      textures.set(key, pending);
    }
    return pending;
  }
  return async (reference: AssetMigrationReference, asset: ReferenceAsset): Promise<boolean | undefined> => {
    try {
      if (reference.kind !== asset.kind || reference.key.toLowerCase() !== asset.key.toLowerCase()) return false;
      if (asset.kind === 'texture') return (await textureHash(reference.level, reference.key)) === asset.hash;
      // Older manifest implementations may not supply a hash of the decoded definition.
      if (!asset.payloadHash) return undefined;
      let pending = props.get(reference.level);
      if (!pending) {
        pending = reader.props(reference.level);
        props.set(reference.level, pending);
      }
      const payload = await pending;
      const definition =
        asset.kind === 'prop'
          ? propAssetDefinition(payload, reference.key)
          : payload.physicsBodies?.find(body => String(body.id) === reference.key);
      if (!definition) return undefined;
      if ((await assetDefinitionHash(definition, {})) !== asset.payloadHash) return false;
      const files = new Map(Object.entries(asset.files).map(([path, hash]) => [path.toLowerCase(), hash]));
      if (asset.kind === 'prop') {
        const model = payload.models.find(model => String(model.id) === reference.key)!;
        const names = payload.materials
          .filter(material => model.subs.some(sub => sub.mat === material.id))
          .flatMap(material => [material.tex, ...(material.frames ?? [])].filter(Boolean));
        if (names.some(name => !files.has(`textures/${name}`.toLowerCase()))) return undefined;
      }
      for (const [path, hash] of files) {
        if (!path.startsWith('textures/')) return undefined;
        if ((await textureHash(reference.level, path.slice('textures/'.length))) !== hash) return false;
      }
      return true;
    } catch {
      // Unavailable bytes are not evidence of either a match or a mismatch.
      return undefined;
    }
  };
}
