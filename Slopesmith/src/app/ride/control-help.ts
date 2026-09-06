export type RideControlRow = [key: string, description: string];

export interface RideControlHelp {
  title: string;
  groups: RideControlRow[][];
}

/** Key mappings for the standard lower-left command sheet during a desktop Test session. */
export function rideControlHelp(walking: boolean, firstPerson: boolean): RideControlHelp {
  const escape: RideControlRow = ['Esc', firstPerson ? 'release cursor / exit' : 'release look / exit'];
  const zoom: RideControlRow = ['Wheel / pinch', 'zoom camera'];
  const view: RideControlRow[] = firstPerson
    ? [['Mouse', 'look'], escape, ['click', 'recapture cursor']]
    : [['hold RMB', 'look'], zoom, escape];
  const switchView: RideControlRow = ['V', `switch to ${firstPerson ? 'third' : 'first'} person`];
  if (walking) {
    return {
      title: `Test Mode — on foot · ${firstPerson ? 'first' : 'third'} person`,
      groups: [
        [
          ['W / A / S / D', 'walk · flight: thrust'],
          ['Ctrl', 'crouch · flight: thrust down'],
          ['Space', 'jump · again or + boost to fly · thrust up'],
          ['Shift / Pad X', 'boost · with jump: fly'],
        ],
        [
          ['LMB', 'interact · highlighted board: ride'],
          ['hold RMB', firstPerson ? 'grab highlighted board' : 'grab highlighted board · otherwise look'],
          ...(firstPerson ? view : [zoom, escape]),
          ['E', 'recall + get on board'],
          switchView,
        ],
        [['R', 'reset'], ['P', 'pause']],
      ],
    };
  }
  return {
    title: `Test Mode — riding · ${firstPerson ? 'first' : 'third'} person`,
    groups: [
      [
        ['A / D', 'carve · air: spin'],
        ['W / S', 'tuck / brake · air: flip'],
        ['Shift', 'boost · air: view aim'],
        ['Space', 'ollie · hold to charge'],
      ],
      [['E', 'get off board'], switchView, ...view],
      [['R', 'respawn'], ['P', 'pause'], ['M / F8', 'mark / record']],
    ],
  };
}
