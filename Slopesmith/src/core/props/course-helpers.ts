/** OpenSlope playtest policies [Trailmap: 524, 525]; original controller activation is unresolved. */
export const isOnTourBoundaryHelper = (source: string, ...names: (string | undefined)[]): boolean =>
  (source === 'ssx-on-tour' || /^SSXOT_/i.test(source)) &&
  names.some(
    name => typeof name === 'string' && /^mdl_[a-z]{2}[0-9]_impassable(?:left|right)(?:_[0-9]+)?$/i.test(name),
  );

export const isOnTourEffectTrigger = (source: string, ...names: (string | undefined)[]): boolean =>
  (source === 'ssx-on-tour' || /^SSXOT_/i.test(source)) &&
  names.some(
    name =>
      typeof name === 'string' &&
      /^mdl_[a-z]{2}[0-9]_trg_fw_(?:archlights|start|finish(?:_final)?)(?:_[0-9]+)*$/i.test(name),
  );

export const isOnTourCourseHelper = (source: string, ...names: (string | undefined)[]): boolean =>
  isOnTourBoundaryHelper(source, ...names) || isOnTourEffectTrigger(source, ...names);

export interface BoundarySourceInstance {
  InstanceName?: string;
  ModelID?: number;
  Visable?: boolean;
  PlayerCollision?: boolean;
  EffectSlotIndex?: number;
  PlayerBounce?: boolean;
  U0?: number;
  SurfaceType?: number;
  CollsionMode?: number;
  CollsionModelPaths?: string[] | null;
  PhysicsIndex?: number;
}

/** Copy matching rows only. Stored ISO caches, authored profiles and source geometry remain intact. */
export function prepareOnTourCourseHelpers<T extends BoundarySourceInstance>(
  source: string,
  instances: readonly T[],
  modelName: (id: number) => string | undefined,
): T[] {
  return instances.map(row =>
    isOnTourCourseHelper(source, row.InstanceName, modelName(row.ModelID ?? -1))
      ? {
          ...row,
          Visable: false,
          PlayerCollision:
            row.CollsionMode === 2 ||
            (row.CollsionMode === 1 && !!row.CollsionModelPaths?.length) ||
            (row.CollsionMode === 3 && typeof row.PhysicsIndex === 'number' && row.PhysicsIndex >= 0),
          PlayerBounce: false,
          U0: 0,
          SurfaceType: -1,
        }
      : row,
  );
}
