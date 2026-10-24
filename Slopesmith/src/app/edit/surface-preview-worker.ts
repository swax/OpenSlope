import {
  createSurfacePreviewEvaluator,
  type SurfacePreviewRequest,
  type SurfacePreviewResponse,
} from '../../core/mesh/surface-preview';

const evaluate = createSurfacePreviewEvaluator();
self.onmessage = (event: MessageEvent<SurfacePreviewRequest>) => {
  let response: SurfacePreviewResponse;
  try {
    response = evaluate(event.data);
  } catch (error) {
    response = { epoch: event.data.epoch, kind: 'fallback', error: String(error) };
  }
  const buffers =
    response.kind === 'ready'
      ? [
          response.patches.positions.buffer,
          response.patches.normals.buffer,
          response.patches.rawNormals.buffer,
          response.patches.controls.buffer,
        ]
      : [];
  self.postMessage(response, { transfer: buffers });
};
