import GUI from 'lil-gui';
import { addReferenceLightDetails, addAuthoredLightDetails } from '../src/app/ui/components/light-details';
import type { AuthoredLight } from '../src/core/doc/types';
import type { RigLight } from '../src/core/reference/lights';

document.body.style.cssText = 'margin:24px;background:#182331;color:white;display:flex;gap:24px;align-items:flex-start';
const reference: RigLight = {
  name: 'Recovered spotlight',
  kind: 'spot',
  category: 'spot',
  negative: false,
  colorHex: '#ffdca0',
  intensity: 2,
  pos: [0, 10, 0],
  dir: [0, -1, 0],
  reach: 50,
  coneCos: Math.cos((85 * Math.PI) / 180),
  coneSource: 'source',
};
const source = new GUI({ autoPlace: false, title: 'Reference light' });
document.body.append(source.domElement);
let edited: AuthoredLight | null = null;
let rebuilds = 0;
addReferenceLightDetails(source, 'SOURCE', reference, 'Mountain', light => {
  edited = light;
  const gui = new GUI({ autoPlace: false, title: 'Editable mountain light' });
  document.body.append(gui.domElement);
  addAuthoredLightDetails(
    gui,
    light,
    0,
    'Mountain',
    () => ++rebuilds,
    () => {},
  );
});
Object.assign(window, {
  lightEditor: {
    value: () => edited,
    source: () => reference,
    rebuilds: () => rebuilds,
  },
});
