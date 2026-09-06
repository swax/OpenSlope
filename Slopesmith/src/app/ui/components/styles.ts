/** Install component CSS once even when a panel/controller is reconstructed. */
export function installStyles(id: string, css: string): void {
  const styleId = `slopesmith-style-${id}`;
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.dataset.slopesmithStyle = id;
  style.textContent = css;
  document.head.appendChild(style);
}
