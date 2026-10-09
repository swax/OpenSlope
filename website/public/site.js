document.documentElement.classList.add('js');
const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#site-nav');
menu.hidden = false;
function closeMenu() {
  menu.setAttribute('aria-expanded', 'false');
  navigation.classList.remove('is-open');
}
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('is-open', open);
});
navigation.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); } });

const preview = document.querySelector('#editor-preview');
if (preview) {
  const views = {
    build: { src: '/assets/editor/course-definition-preview.webp', full: '/assets/editor/course-definition.webp', alt: 'Scene Mode with a green course line and editable knots on a snowy mountain.', caption: 'SCENE MODE / THE COURSE LINE', detail: 'Define the route with course knots and settings.', index: '01 / 03' },
    paint: { src: '/assets/editor/map-editing-preview.webp', full: '/assets/editor/map-editing.webp', alt: 'Paint Mode with a mountain in the viewport, a texture palette on the right, and the Texture Library below.', caption: 'PAINT MODE / TEXTURES & PALETTES', detail: 'Choose a tile, preview its orientation, then paint.', index: '02 / 03' },
    ride: { src: '/assets/slopesmith-riding.png', full: '/assets/slopesmith-riding.png', alt: 'A custom rider snowboarding through the original Candyland course in Slopesmith.', caption: 'TEST MODE / RIDE YOUR MOUNTAIN', detail: 'Check the route, stop the run, and refine the next edit.', index: '03 / 03' },
  };
  document.querySelector('.preview-controls').hidden = false;
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    const view = views[button.dataset.view];
    preview.src = view.src;
    preview.alt = view.alt;
    document.querySelector('#preview-caption').textContent = view.caption;
    document.querySelector('#preview-detail').textContent = view.detail;
    document.querySelector('#preview-full').href = view.full;
    document.querySelector('#preview-full').dataset.caption = view.detail;
    document.querySelector('.preview-index').textContent = view.index;
    document.querySelectorAll('[data-view]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));
}

document.querySelectorAll('[data-copy]').forEach(button => {
  button.hidden = false;
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy).textContent;
    const status = button.closest('.code-block').querySelector('[role="status"]');
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Commands copied.';
      button.textContent = 'Copied';
    } catch {
      status.textContent = 'Select and copy the commands below.';
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById(button.dataset.copy));
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 2200);
  });
});

const imageDialog = document.querySelector('.image-dialog');
const dialogImage = imageDialog.querySelector('.image-dialog-content');
document.querySelectorAll('[data-lightbox]').forEach(link => link.addEventListener('click', event => {
  // Preserve standard link behavior when opening in a new tab or without dialog support.
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || typeof imageDialog.showModal !== 'function') return;
  event.preventDefault();
  const thumbnail = link.querySelector('img');
  dialogImage.src = link.href;
  dialogImage.alt = thumbnail?.alt ?? 'Slopesmith editor screenshot';
  document.querySelector('#image-dialog-caption').textContent = link.dataset.caption ?? thumbnail?.alt ?? '';
  imageDialog.querySelector('.image-original').href = link.href;
  imageDialog.showModal();
}));
imageDialog.querySelector('.dialog-close').addEventListener('click', () => imageDialog.close());
imageDialog.addEventListener('click', event => { if (event.target === imageDialog) {
  const box = imageDialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) imageDialog.close();
} });

document.querySelectorAll('[data-video]').forEach(button => {
  button.hidden = false;
  button.addEventListener('click', () => {
    const player = document.createElement('iframe');
    player.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(button.dataset.video)}?rel=0`;
    player.title = 'Making Slopesmith — development montage';
    player.allow = 'encrypted-media; picture-in-picture; fullscreen';
    player.allowFullscreen = true;
    player.referrerPolicy = 'strict-origin-when-cross-origin';
    document.querySelector('#development-player').replaceChildren(player);
    player.focus();
  }, { once: true });
});
