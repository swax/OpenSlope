// tier: fast

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rideControlHelp } from '../src/app/ride/control-help';

const mappings = (walking: boolean, firstPerson: boolean) => {
  const help = rideControlHelp(walking, firstPerson);
  return { title: help.title, rows: new Map(help.groups.flat()) };
};

const rideThird = mappings(false, false);
assert.match(rideThird.title, /riding · third person/, 'the panel title names the live ride view');
assert.equal(rideThird.rows.get('E'), 'get off board', 'the riding panel exposes the board dismount key');
assert.equal(rideThird.rows.get('V'), 'switch to first person', 'third person names the view V switches to');
assert.equal(rideThird.rows.get('hold RMB'), 'look', 'third person explains its held mouse-look gesture');
assert.equal(rideThird.rows.get('Wheel / pinch'), 'zoom camera', 'third-person riding advertises boom zoom');
assert.equal(rideThird.rows.get('Esc'), 'release look / exit', 'third person keeps the ride exit mapping visible');
assert.ok(!rideThird.rows.has('Mouse') && !rideThird.rows.has('click'),
  'third person omits first-person capture mappings');

const rideFirst = mappings(false, true);
assert.match(rideFirst.title, /riding · first person/, 'the panel title follows V into first person');
assert.equal(rideFirst.rows.get('E'), 'get off board', 'first-person riding keeps the dismount key');
assert.equal(rideFirst.rows.get('V'), 'switch to third person', 'first person names the view V switches to');
assert.equal(rideFirst.rows.get('Mouse'), 'look', 'first person explains direct captured mouse-look');
assert.equal(rideFirst.rows.get('Esc'), 'release cursor / exit', 'first person explains cursor release and exit');
assert.equal(rideFirst.rows.get('click'), 'recapture cursor', 'first person explains cursor recapture');
assert.ok(!rideFirst.rows.has('hold RMB'), 'first person omits the third-person look mapping');
assert.ok(!rideFirst.rows.has('Wheel / pinch'), 'first person omits the third-person zoom mapping');

const walkThird = mappings(true, false);
assert.match(walkThird.title, /on foot · third person/, 'the panel title follows E onto foot');
assert.equal(walkThird.rows.get('E'), 'recall + get on board', 'the walking panel distinguishes recall from interaction');
assert.equal(walkThird.rows.get('V'), 'switch to first person', 'third-person walking names the V destination');
assert.equal(walkThird.rows.get('LMB'), 'interact · highlighted board: ride',
  'walking maps LMB to the highlighted target\u2019s use action');
assert.equal(walkThird.rows.get('hold RMB'), 'grab highlighted board · otherwise look',
  'third-person walking explains the target-aware grab/look split');
assert.equal(walkThird.rows.get('Esc'), 'release look / exit', 'third-person walking keeps the exit mapping visible');
assert.equal(walkThird.rows.get('Wheel / pinch'), 'zoom camera', 'third-person walking advertises boom zoom');
assert.ok(!walkThird.rows.has('Pad R2 / L2'), 'keyboard help does not advertise gamepad-only trigger zoom');
assert.match(walkThird.rows.get('Space') ?? '', /again or \+ boost to fly · thrust up/,
  'walking help exposes double-jump and Jump + Boost activation plus upward thrust');
assert.match(walkThird.rows.get('W / A / S / D') ?? '', /flight: thrust/,
  'walking help exposes directional flight thrust');
assert.match(walkThird.rows.get('Ctrl') ?? '', /flight: thrust down/,
  'walking help exposes downward thrust');
assert.equal(walkThird.rows.get('Shift / Pad X'), 'boost · with jump: fly',
  'walking help exposes Boost as both the full-speed modifier and Jump chord');
assert.ok(!walkThird.rows.has('Space + LMB'), 'the retired mouse-aim flight chord is no longer advertised');

const walkFirst = mappings(true, true);
assert.match(walkFirst.title, /on foot · first person/, 'the walking panel title follows V');
assert.equal(walkFirst.rows.get('E'), 'recall + get on board', 'first-person walking keeps the recall key');
assert.equal(walkFirst.rows.get('V'), 'switch to third person', 'first-person walking names the V destination');
assert.equal(walkFirst.rows.get('hold RMB'), 'grab highlighted board',
  'first person gives RMB only the held-target action because mouse-look is already direct');
assert.equal(walkFirst.rows.get('Mouse'), 'look', 'first-person walking shows direct mouse-look');
assert.ok(!walkFirst.rows.has('Wheel / pinch'), 'first-person walking omits the third-person zoom mapping');

const hud = readFileSync(resolve(process.cwd(), 'src/app/ride/hud.ts'), 'utf8');
const faceStart = hud.indexOf('data-face-actions');
assert.ok(faceStart >= 0, 'touch controls include the face-button diamond');
const faces = hud.slice(faceStart, hud.indexOf('// Top-right', faceStart));
assert.doesNotMatch(hud, /data-l1|data-l2|data-r1|data-r2/,
  'the touch diagram has no shoulder buttons');
assert.match(faces, /data-y[\s\S]*data-x[\s\S]*data-b[\s\S]*data-a/,
  'Y/X/B/A form the standard north/west/east/south face-button diamond');
assert.match(faces, /data-y[\s\S]*buttonCopy\('Y', 'BOARD'\)/,
  'Y gets on or off the board');
assert.match(faces, /data-x[\s\S]*buttonCopy\('X', 'BOOST'\)/,
  'X boosts');
assert.match(faces, /data-b[\s\S]*buttonCopy\('B', 'RESPAWN'\)/,
  'B respawns');
const topActionsStart = hud.indexOf('data-fs');
const topActions = hud.slice(topActionsStart, hud.indexOf('o.container.appendChild(el)', topActionsStart));
assert.match(topActions, /data-view/,
  'the hideable touch diagram retains its manual 1ST/3RD camera button');
assert.doesNotMatch(topActions, /data-exit/,
  'Stop does not live inside the diagram that gamepad mode or a headset-panel ride can hide');
assert.match(hud,
  /function buildPersistentExit\(\)[\s\S]*className = 'os-ride-stop'[\s\S]*addEventListener\('click',[\s\S]*o\.exit\(\)/,
  'a normal DOM Stop action remains independent of touch capture and the hideable diagram');
assert.doesNotMatch(hud, /data-padhint|updatePadHint/,
  'gamepad mode uses the same temporary labelled diagram instead of a separate text legend');
assert.match(hud, /performance\.now\(\) - lastTouchAt < TOUCH_LINGER_MS[\s\S]*setInputMode\('pad'\)/,
  'gamepad activity auto-hides the diagram only after screen touches have gone quiet');
assert.match(hud, /touchRidePosture\(vertical, stick\.x\)[\s\S]*setHold\('touch', 'tuck'[\s\S]*setHold\('touch', 'brake'/,
  'the vertical touch stick continues to drive tuck and brake without L2/R2 buttons');
assert.match(hud, /walking \? o\.setWalkHold\('touch', 'boost', true\) : o\.setHold\('touch', 'boost', true\)/,
  'the touch X button remains the full-speed boost modifier while flying on foot');
const responsive = readFileSync(resolve(process.cwd(), 'src/app/styles/responsive.css'), 'utf8');
assert.match(responsive,
  /body\.os-riding\.os-touch-riding \{ --ride-hud-top: calc\(env\(safe-area-inset-top, 0px\) \+ 8px\);[\s\S]*--ride-hud-bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ 2px\); \}/,
  'only an actual direct-touch ride seats the HUD against the screen safe areas');
assert.match(responsive,
  /body\.os-riding\.os-touch-riding #dock-top[\s\S]*body\.os-riding\.os-touch-riding #dock-right/,
  'coarse-pointer flat Play keeps the editor Stop/toolbox unless touch input explicitly owns the ride');
assert.match(hud,
  /touchControlsAllowed && lastRidePointerWasTouch\(\)[\s\S]*showTouchUi\(\)/,
  'the phone diagram is revealed by actual pointer modality rather than pointer accuracy');
assert.match(hud,
  /function showTouchUi\(\)[\s\S]*document\.body\.classList\.add\('os-touch-riding'\)/,
  'revealing direct-touch controls is the single owner of the touch-only chrome state');
assert.match(hud, /bottom:var\(--ride-hud-bottom, 16px\)/,
  'mobile riding can seat the footer lower while desktop retains its original inset');
assert.ok((hud.match(/top:var\(--ride-hud-top/g) ?? []).length >= 3,
  'the performance chip, run clock, and touch action row share the mobile-aware top inset');
assert.match(hud, /font:700 18px\/1\.1 ui-monospace[\s\S]*data-clockmode style="font:650 9px\/1/,
  'the run timer and mode label use a compact one-line scale');
assert.match(hud, /clockEl\.style\.display = clock \? 'inline-flex' : 'none'/,
  'the Showoff/Race label sits inline with its timer');
assert.match(hud,
  /scoreEl\.style\.display = clock\.mode === 'showoff' \? 'inline' : 'none';[\s\S]*clock\.mode === 'showoff'[\s\S]*clock\.score/,
  'desktop and mobile keep points out of Race while retaining the Showoff total');
assert.match(hud,
  /data-clocktrick[\s\S]*data-trickpoints[\s\S]*data-trickdetail[\s\S]*trick\.state === 'landed'[\s\S]*trick\.kind === 'grind'/,
  'the desktop/mobile run chip renders Unity\'s live and held itemized trick block');
assert.match(hud, /data-boost-meter[\s\S]*data-boost-dots[\s\S]*RIDE_BOOST_METER_SEGMENTS/,
  'desktop and mobile carry the fifteen-dot boost meter at the bottom of the HUD stack');
assert.match(hud, /boostMeterSegments\(meter\)[\s\S]*Math\.floor\(i \/ 3\)/,
  'the meter lights whole dots through Unity\'s five three-dot colour stages');
const session = readFileSync(resolve(process.cwd(), 'src/app/ride/session.ts'), 'utf8');
assert.match(session, /persistentExit: !this\.inVr/,
  'ordinary browser rides get the persistent Stop while an immersive mirror does not');
assert.match(session,
  /if \(this\.runActive\) this\.scorer\.stepBoost\(rideDt, this\.input\.keys\.boost\);[\s\S]*this\.model\.step\(rideDt\)/,
  'held boost spends a meter only during an active timed/scored run, before the board receives the frame');
assert.match(session, /heldBoostAvailable: \(\) => !this\.runActive \|\| this\.scorer\.hasBoost/,
  'free rides and no-clock remounts bypass stale scorer energy and retain unlimited boost');
assert.match(session, /automaticRespawnAvailable: \(\) => this\.runActive/,
  'world-driven recovery is enabled only while a timed/scored run is active');
assert.match(session, /respawn: \(\) => this\.manualRespawn\(\)/,
  'every desktop manual input reaches the locomotion-aware carry-back');
assert.match(session,
  /private manualRespawn\(\)[\s\S]*?if \(this\.onFootFlag && this\.walker\)[\s\S]*?this\.model\.resetToCourse\(this\.walker\.position\(\)\)[\s\S]*?this\.walker\.placeAt\(this\.model\.st\.pos\)[\s\S]*?if \(this\.canControl\) this\.model\.resetToCourse\(\)/,
  'manual recovery remains unconditional and moves the player in either mounted or walking locomotion');
assert.match(session, /onFell: \(\) => \{ if \(this\.runActive\) this\.resetWalker\(\); \}/,
  'desktop off-board falls also auto-recover only while scoring is active');
assert.match(session, /case 'reset': if \(this\.runActive\) this\.model\.resetToCourse\(\); break/,
  'authored object/volume reset actions obey the same active-score boundary');
assert.match(session,
  /if \(this\.hud\.lookStick\.active\) \{[\s\S]*this\.onFootFlag \? WALK_LOOK_STICK_PIXELS_PER_SECOND : RIDE_LOOK_STICK_PIXELS_PER_SECOND;[\s\S]*this\.orbitCamera/,
  'the physical right stick drives the camera in both walking and riding modes');
assert.match(hud,
  /pauseControlsVisible = paused;[\s\S]*if \(paused\) showTouchUi\(\);[\s\S]*inputMode === 'pad'[\s\S]*touchUi\.style\.display = 'none'/,
  'pause reveals the controls without changing their post-resume input mode');
assert.match(hud, /function notePadPresent\(\) \{\s*if \(pauseControlsVisible\) return;/,
  'a detected gamepad cannot auto-hide the controls while paused');
assert.match(hud,
  /data-clockbelow style="position:absolute;left:50%;top:calc\(100% \+ 4px\)[\s\S]*data-timebonus style="display:none[\s\S]*color:#ffd34d;[\s\S]*font:750 11px/,
  'the time bonus is a small yellow notification directly beneath the run clock');
assert.match(session, /this\.showRunClock\(\);\s*this\.hud\.showTimeBonus\(`TIME BONUS/,
  'checkpoint time uses the compact clock notification instead of the centre-screen countdown');
assert.doesNotMatch(session, /setCountdown\(`TIME BONUS/,
  'time bonuses no longer take over the large countdown surface');
assert.match(hud,
  /\.os-pad-code\{display:none;[\s\S]*\[data-gamepad\] \.os-pad-code\{display:inline\}[\s\S]*toggleAttribute\('data-gamepad', !!p\)/,
  'controller letters appear only while a physical gamepad is detected');
assert.match(faces, /data-a[\s\S]*width:\$\{tap\(88, 70\)\}px;height:\$\{tap\(88, 70\)\}px/,
  'the bottom-centre Ollie/Jump touch target fills more of the face-button gap');

console.log('ride control-help checks passed');
