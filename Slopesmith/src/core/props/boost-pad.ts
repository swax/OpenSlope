import { EFFECT_TEMPLATES } from '../effects/authoring-catalogue';
import { NATIVE_COLLISION_MODE } from '../collision/native';
import type { StampBehaviour } from './defaults';
import type { PropEffectTemplate } from './effect-defaults';

export type BoostPadKind = 'speed' | 'trick';

/** A visible pad uses ordinary prop placement and ordinary editable effect graphs. */
export function boostPadPreset(kind: BoostPadKind, defaults: StampBehaviour): {
  behaviour: StampBehaviour; effect: PropEffectTemplate;
} {
  const boost = EFFECT_TEMPLATES.find(template => template.id === `${kind}-boost`)!;
  const scroll = EFFECT_TEMPLATES.find(template => template.id === 'uv-scroll')!;
  return {
    behaviour: {
      ...structuredClone(defaults),
      modePresence: undefined,
      nativeCollision: {
        mode: NATIVE_COLLISION_MODE.boundingBox, playerCollision: true,
        responseMass: 0, playerBounce: false, bounceAmount: 0,
      },
    },
    effect: {
      key: `boost-pad:${kind}`,
      circumstances: {
        collision: structuredClone([...boost.nodes!]),
        persistent: structuredClone([...scroll.nodes!]),
      },
    },
  };
}
