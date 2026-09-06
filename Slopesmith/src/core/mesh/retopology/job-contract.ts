import type { QuadMeshDoc } from '../../doc/types';
import type { DistributionSummary, RetopologyIntegrationReport } from './integrate';
import type { MetricSummary } from './metrics';

/** Product-facing topology scopes: global flow around every lock, or one captured connected patch region. */
export type RetopologyScope = 'whole-unlocked' | 'selected-region';

/** Candidate generation strategies: the native QuadWild solver, or the built-in contour-flow sweep whose
 * rows follow graded elevation lines with columns up the gradient. */
export type RetopologyStrategy = 'quadwild' | 'contour-flow';

export interface RetopologyJobOptions {
  scope: RetopologyScope;
  strategy: RetopologyStrategy;
  /** Additional source-patch rings included around a selected region before its frozen boundary is formed. */
  influenceRings: number;
  targetPatchSizeM: number;
  quadWildScale: number;
  maximumSurfaceDeviationM: number;
  qualityResolution: number;
  preserveSurfacePaint: boolean;
}

export const DEFAULT_RETOPOLOGY_OPTIONS: RetopologyJobOptions = {
  scope: 'whole-unlocked',
  strategy: 'quadwild',
  influenceRings: 2,
  targetPatchSizeM: 25,
  quadWildScale: 1.6,
  maximumSurfaceDeviationM: 25,
  qualityResolution: 4,
  preserveSurfacePaint: true,
};

export interface RetopologyStrategyCapability {
  id: RetopologyStrategy;
  available: boolean;
  reason?: string;
  scopes: RetopologyScope[];
}

export type RetopologyJobPhase =
  | 'queued' | 'preparing' | 'quadwild-prep' | 'quadrangulating'
  | 'integrating' | 'validating' | 'complete' | 'failed' | 'cancelled';

export interface RetopologyResultSummary {
  scope: RetopologyScope;
  sourcePatches: number;
  remeshedSourcePatches: number;
  lockedPatches: number;
  protectedPatches: number;
  generatedPatches: number;
  totalPatches: number;
  connectedComponents: number;
  interfaceEdges: { protected: number; generated: number };
  tJunctions: number;
  invertedPatches: number;
  protectedControlDeviationM: number;
  cageEdgeLengthM: DistributionSummary;
  cageAspectRatio: DistributionSummary;
  surfaceDeviationM: {
    sourceToResult: MetricSummary;
    resultToSource: MetricSummary;
    symmetricMax: number | null;
  };
}

export interface RetopologyJobStatus {
  id: string;
  phase: RetopologyJobPhase;
  progress: number;
  detail: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  queuePosition?: number;
  summary?: RetopologyResultSummary;
}

export interface RetopologyJobRequest {
  document: QuadMeshDoc;
  options?: Partial<RetopologyJobOptions>;
  /** Stable patch ids captured when Selected region is opened. */
  selectedQuadIds?: string[];
}

export interface RetopologyJobResult {
  document: QuadMeshDoc;
  summary: RetopologyResultSummary;
  integration: RetopologyIntegrationReport;
}

export interface RetopologyCapabilities {
  /** True when at least one strategy can run on this server. */
  available: boolean;
  reason?: string;
  scopes: RetopologyScope[];
  strategies: RetopologyStrategyCapability[];
  defaults: RetopologyJobOptions;
  engine: 'quadwild-bimdf';
  concurrency: number;
}
