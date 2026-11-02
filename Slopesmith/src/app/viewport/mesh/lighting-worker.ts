import { bakeTerrainParts } from '../../../core/lighting/terrain-bake';
import type { TerrainBakeRequest, TerrainBakeResponse } from './lighting-client';

self.onmessage = (event: MessageEvent<TerrainBakeRequest>) => {
  let response: TerrainBakeResponse;
  try {
    response = { result: bakeTerrainParts(event.data.input, event.data.parts) };
  } catch (error) {
    response = { error: String(error) };
  }
  const transfer =
    'result' in response ? Object.values(response.result).map(values => values.buffer as ArrayBuffer) : [];
  self.postMessage(response, { transfer });
};
