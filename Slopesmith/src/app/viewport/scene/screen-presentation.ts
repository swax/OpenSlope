/** The two independent reasons a video-screen layer may draw: playback and authoring inspection. */
export interface ScreenPresentation {
  layerVisible: boolean;
  panelVisible: boolean;
  inspectionVisible: boolean;
  pickable: boolean;
}

/**
 * Playback owns the picture; Sources owns the editor rigging around it. Keeping those gates separate means a
 * movie can cover every billboard without making dozens of invisible authoring rectangles steal clicks.
 */
export function screenPresentation(sourcesVisible: boolean, videoPlaying: boolean): ScreenPresentation {
  return {
    layerVisible: sourcesVisible || videoPlaying,
    panelVisible: sourcesVisible || videoPlaying,
    inspectionVisible: sourcesVisible,
    pickable: sourcesVisible,
  };
}
