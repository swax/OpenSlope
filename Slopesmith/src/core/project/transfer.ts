import type { EditDoc } from '../doc/doc-edit';

/** Custom asset families that can travel with an editable mountain. */
export type BundleAssetKind = 'texture' | 'sound' | 'music' | 'sky' | 'prop';

/** One custom asset named by a mountain, identified by the bytes rather than by a server-local path. */
export interface BundleAsset {
  kind: BundleAssetKind;
  name: string;
  hash: string;
  size: number;
  /** Imported prop placements carry the model number assigned by their source server. */
  model?: number;
}

/** The API representation used while a mountain moves between a browser and a Slopesmith server. */
export const PROJECT_BUNDLE_SCHEMA = 1;
export interface ProjectBundle {
  kind: 'slopesmith-project';
  schema: number;
  name: string;
  revision: number;
  takenAt: string;
  document: EditDoc;
  assets: BundleAsset[];
  missing?: string[];
  /** Asset bytes encoded for the JSON transfer endpoint, keyed by sha256. */
  blobs?: Record<string, string>;
}

/**
 * The manifest stored in an exported mountain ZIP. The editable document and asset bytes are ordinary ZIP
 * entries instead of base64 inside this JSON, so the archive remains inspectable and does not inflate its
 * payload by a third on disk.
 */
export const MOUNTAIN_ARCHIVE_SCHEMA = 1;
export const MOUNTAIN_ARCHIVE_MANIFEST = 'manifest.json';
export interface MountainArchiveAsset extends BundleAsset { file: string }
export interface MountainArchiveManifest {
  kind: 'slopesmith-mountain';
  schema: number;
  name: string;
  revision: number;
  /** When the exported revision was captured; for a checkpoint, when that checkpoint was taken. */
  takenAt: string;
  document: string;
  assets: MountainArchiveAsset[];
  missing?: string[];
}
