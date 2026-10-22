import type { Account } from '../net/account';
import { preferredAvatar, saveAvatar } from '../net/avatar-preference';
import { BUILTIN_CHARACTERS, DEFAULT_CHARACTER_MODEL_ID, builtinCharacter } from '../../core/characters/builtins';
import { ensureRiderModelCatalog, type RiderModelOption } from '../ride/rider-models';
import { menu, type MenuItem } from '../ui/components/controls';
import { toast } from '../ui/components/toast';
import { publicGlyph } from './presentation';

/**
 * The play page's rider chooser: the built-in characters for everybody, plus the server's character library
 * for a member (the library needs a session to load). The choice is shared with the editor and, for a member,
 * kept on their account — see net/avatar-preference.ts.
 */
export function publicAvatarPicker(account: Account, onChange: (id: string) => void) {
  const builtIns: RiderModelOption[] = BUILTIN_CHARACTERS.map(character => ({ ...character }));
  let library: RiderModelOption[] = [];
  let current = DEFAULT_CHARACTER_MODEL_ID;
  const nameOf = (id: string) =>
    builtinCharacter(id)?.label ?? library.find(option => option.id === id)?.label ?? id.replace(/\.glb$/i, '');
  const items = (): MenuItem[] => [
    ...builtIns.map(option => ({
      label: option.label, detail: option.blurb, checked: option.id === current, group: 'Riders',
      onClick: () => choose(option.id),
    })),
    ...library.map(option => ({
      label: option.label, checked: option.id === current, group: 'This server',
      onClick: () => choose(option.id),
    })),
  ];
  const picker = menu('Avatar', items);
  picker.el.classList.add('public-avatar-picker');
  picker.el.type = 'button';
  picker.el.prepend(publicGlyph('rider'));
  const show = () => {
    picker.setLabel(nameOf(current));
    picker.el.title = `Riding as ${nameOf(current)}. Choose your rider`;
    picker.el.setAttribute('aria-label', `Avatar: ${nameOf(current)}`);
  };
  let chosen = false;
  function choose(id: string) {
    chosen = true;
    if (id === current) return;
    current = id; show(); onChange(id);
    void saveAvatar(id).catch(error => {
      toast(`Your rider changed here but was not saved to your account: ${error instanceof Error ? error.message : error}`, 'warn');
    });
  }
  show();
  void preferredAvatar().then(id => {
    if (chosen) return;                               // a pick made while this loaded wins
    current = id; show(); onChange(id);
  });
  const member = 'user' in account || (account.accounts === 'open' && !account.offline);
  if (member) {
    void ensureRiderModelCatalog().then(options => {
      library = options.filter(option => option.file && !builtinCharacter(option.id));
      show();
    });
  }
  return { el: picker.el, current: () => current };
}
