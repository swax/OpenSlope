/** Drag-and-drop MIME types shared between the Texture Library (drag source) and the Palette (drop target). */
export const DRAG_TILE = 'application/x-ss-tile'; // a Library tile being staged: JSON { ref, surface }
export const DRAG_CELL = 'application/x-ss-cell'; // a Palette cell being reordered: its source index as a string
