import { button, group } from '../components/controls';
import { WATCHING_ICON } from '../components/icons';
import { tooltip } from '../components/tooltip';

export type ObserverControlsDeps = {
  observing: () => { username: string; paused: boolean } | null;
  sharing: () => { watchers: number } | null;
  pauseObserving: () => void;
  continueObserving: () => void;
  stopObserving: () => void;
};

/** Live screen-follow controls sit over the map they affect, rather than consuming space in the top dock. */
export function createObserverControls(deps: ObserverControlsDeps) {
  const { observing, sharing, pauseObserving, continueObserving, stopObserving } = deps;
  const el = group();
  el.className = 'sp-group sp-observe-controls';
  document.getElementById('viewport')!.append(el);

  function refresh(): void {
    const state = observing();
    const shared = sharing();
    el.replaceChildren();
    el.hidden = !state && !shared;
    document.body.classList.toggle('os-screen-status', !!state || !!shared);
    if (shared) {
      const watchers = document.createElement('span');
      watchers.className = 'sp-share-watchers';
      watchers.setAttribute('role', 'status');
      watchers.setAttribute('aria-live', 'polite');
      watchers.innerHTML = WATCHING_ICON;
      watchers.append(`${shared.watchers} watching`);
      tooltip(watchers, `${shared.watchers} ${shared.watchers === 1 ? 'person is' : 'people are'} actively watching your shared screen.`);
      el.append(watchers);
    }
    if (!state) return;
    if (state.paused) {
      el.append(
        button('Continue observing', continueObserving, {
          cls: 'sp-observe-continue', title: `Continue following ${state.username}’s shared screen.`,
        }),
        button('Stop observing', stopObserving, {
          cls: 'sp-observe-stop', title: `Stop following ${state.username}’s shared screen.`,
        }),
      );
    } else {
      el.append(button('Pause observing', pauseObserving, {
        cls: 'sp-observe-pause',
        title: `Pause ${state.username}’s updates. Your view remains fully controllable.`,
      }));
    }
  }

  refresh();
  return { el, refresh };
}

export type ObserverControls = ReturnType<typeof createObserverControls>;
