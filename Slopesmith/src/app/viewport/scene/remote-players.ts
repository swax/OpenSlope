import * as THREE from 'three';
import type { PlayerMode, PlayerPose, PlayerTransform } from '../../../core/session/player-pose';
import { RemotePlayerMotion } from '../../net/remote-player-motion';
import { OnFootFacing } from '../../ride/on-foot-facing';
import {
  createBoard, DEFAULT_RIDE_GEAR, DEFAULT_SNOWBOARD_STANCE, type BoardModel, type EquipmentAppearance,
  type RideGear, type SnowboardStance,
} from '../../ride/gear';
import { createRider, type Rider, type RiderHandTarget } from '../../ride/rider';
import { riderLookTarget } from '../../ride/pose';
import type { PeerMarks } from './peers';
import type { Stage } from '../stage';

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);   // deck-local nose: the axis a carve rolls about
const DEG = Math.PI / 180;
const CHAT_BUBBLE_SECONDS = 6;
/** A setup/watch camera is deliberately well ahead of the player: they ride into the shot instead of leaving
 * it on the next awareness packet. The selected player's heading points from the camera back up the mountain. */
export const PLAYER_VIEW_DISTANCE = 30;
export const PLAYER_VIEW_HEIGHT = 8;
/** A live local ride joins close enough to follow without putting two boards on the same contact point. */
export const PLAYER_JOIN_DISTANCE = 3;

export interface ActiveMapPlayer {
  sessionId: string;
  userId: string;
  username: string;
  mode: PlayerMode;
}

export interface PlayerNavigationTarget {
  /** The remote player's body/board root. */
  position: THREE.Vector3;
  /** Horizontal direction the player is facing/riding. */
  heading: THREE.Vector3;
  /** Static editor view: ahead and above, looking back at the player with the mountain behind them. */
  eye: THREE.Vector3;
  focus: THREE.Vector3;
  /** Where a local desktop rider should join them. */
  join: THREE.Vector3;
}

/** Derive both meanings of Test ▸ Position ▸ Go to player from the same owner-authoritative pose. */
export function playerNavigationTarget(pose: PlayerPose): PlayerNavigationTarget {
  const position = new THREE.Vector3(...pose.body.p);
  const heading = FORWARD.clone().applyQuaternion(new THREE.Quaternion(...pose.body.q)).setY(0);
  // A switch rider travels off the other end of the deck. Frame and join the direction their body is actually
  // riding, not the snowboard's fixed local nose.
  if (pose.mode === 'ride' && pose.animation?.lead === -1) heading.negate();
  if (heading.lengthSq() < 1e-6) heading.set(pose.velocity[0], 0, pose.velocity[2]);
  if (heading.lengthSq() < 1e-6) heading.copy(FORWARD);
  heading.normalize();
  const focus = pose.head
    ? new THREE.Vector3(...pose.head.p)
    : position.clone().addScaledVector(UP, pose.mode === 'ride' ? 1.25 : 1.65);
  return {
    position,
    heading,
    eye: focus.clone().addScaledVector(heading, PLAYER_VIEW_DISTANCE)
      .addScaledVector(UP, PLAYER_VIEW_HEIGHT),
    focus,
    join: position.clone().addScaledVector(heading, -PLAYER_JOIN_DISTANCE),
  };
}

const equipmentOf = (peer: PeerMarks): EquipmentAppearance => ({
  ...(peer.snowboardTextureUrl ? { snowboardTextureUrl: peer.snowboardTextureUrl } : {}),
  ...(peer.skiTextureUrl ? { skiTextureUrl: peer.skiTextureUrl } : {}),
  ...(peer.equipmentEdgeColor ? { edgeColor: peer.equipmentEdgeColor } : {}),
});
const equipmentKey = (appearance: EquipmentAppearance): string => JSON.stringify(appearance);

interface SmoothedLocalTransform {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  targetPosition: THREE.Vector3;
  targetQuaternion: THREE.Quaternion;
}

const localTransform = (): SmoothedLocalTransform => ({
  position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
  targetPosition: new THREE.Vector3(), targetQuaternion: new THREE.Quaternion(),
});

class RemoteAvatar {
  readonly userId: string;
  private rider: Rider;
  private avatarId: string;
  private gear: RideGear;
  private stance: SnowboardStance;
  private board: BoardModel;
  private appearanceKey: string;
  private readonly motion = new RemotePlayerMotion();
  /** Equipment is its own world object: once loose it must not inherit the walking body's prediction. */
  private readonly equipmentMotion = new RemotePlayerMotion();
  private readonly label: THREE.Sprite;
  private latest: PlayerPose;
  private firstPose = true;
  private readonly head = localTransform();
  private readonly hands = [localTransform(), localTransform()] as const;
  private headPresent = false;
  private handPresent: [boolean, boolean] = [false, false];
  private equipmentPresent = false;
  /** The owner publishes a snowboard's deck quaternion with its carve roll already in it, and a pair of skis'
   *  with only their facing — a pair does not roll as a unit. `animation.bank` is what puts the roll back on
   *  each ski here, exactly as the VRChat world re-edges a remote skier's (Unity docs/vrchat/017). */
  private readonly rolledQuaternion = new THREE.Quaternion();
  private readonly bankQuaternion = new THREE.Quaternion();
  private readonly ankleA = new THREE.Vector3();
  private readonly ankleB = new THREE.Vector3();
  private readonly soleUp = new THREE.Vector3();
  private readonly rideForward = new THREE.Vector3();
  private readonly lookForward = new THREE.Vector3();
  private readonly lookTurnScratch = new THREE.Vector3();
  private readonly handA: RiderHandTarget = {
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
  };
  private readonly handB: RiderHandTarget = {
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
  };
  private readonly headWorldPosition = new THREE.Vector3();
  private readonly headWorldQuaternion = new THREE.Quaternion();
  private readonly onFootFacing = new OnFootFacing();
  private walkPhase = 0;
  private walkWeight = 0;
  private turnWeight = 0;
  private turnDirection = 1;
  private readonly pointActive: Record<'left' | 'right', boolean> = { left: false, right: false };
  private readonly pointDirections: Record<'left' | 'right', THREE.Vector3> = {
    left: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(0, 0, 1),
  };
  private readonly pointTargets: Record<'left' | 'right', THREE.Vector3> = {
    left: new THREE.Vector3(), right: new THREE.Vector3(),
  };
  private readonly pointHasTarget: Record<'left' | 'right', boolean> = { left: false, right: false };
  private readonly heldEquipmentDirection = new THREE.Vector3();
  private chatBubble: THREE.Sprite | null = null;
  private chatBubbleUntil = 0;

  constructor(private readonly scene: THREE.Object3D, peer: PeerMarks, sampleAt: number) {
    this.userId = peer.userId;
    this.latest = peer.player!;
    this.avatarId = this.latest.avatar;
    this.gear = this.latest.gear ?? DEFAULT_RIDE_GEAR;
    this.stance = this.latest.stance ?? DEFAULT_SNOWBOARD_STANCE;
    const appearance = equipmentOf(peer);
    this.appearanceKey = equipmentKey(appearance);
    this.board = createBoard(this.gear, this.stance, appearance);
    this.rider = createRider(this.avatarId, undefined, this.gear, this.stance);
    this.label = makeLabel(peer.username, peer.color);
    this.addBody();
    scene.add(this.label);
    this.receive(peer, sampleAt);
  }

  navigationTarget(): PlayerNavigationTarget { return playerNavigationTarget(this.latest); }

  /** The close conversational framing used by the server-wide Users action. */
  frontView(): { eye: THREE.Vector3; target: THREE.Vector3 } {
    const navigation = this.navigationTarget();
    return { eye: navigation.focus.clone().addScaledVector(navigation.heading, 4), target: navigation.focus };
  }

  showChat(text: string): void {
    this.clearChatBubble();
    if (!text.trim()) return;
    this.chatBubble = makeChatBubble(text);
    this.chatBubbleUntil = performance.now() / 1000 + CHAT_BUBBLE_SECONDS;
    this.scene.add(this.chatBubble);
  }

  private clearChatBubble(): void {
    if (!this.chatBubble) return;
    this.chatBubble.removeFromParent();
    this.chatBubble.material.map?.dispose();
    this.chatBubble.material.dispose();
    this.chatBubble = null;
    this.chatBubbleUntil = 0;
  }

  /** Put this peer's body and kit into the scene. Neither may ever answer a ground pick. */
  private addBody() {
    for (const object of [this.rider.group, this.board.group]) {
      object.traverse(child => { child.raycast = () => {}; });
      this.scene.add(object);
    }
  }

  private removeBody() {
    this.rider.group.removeFromParent();
    this.board.group.removeFromParent();
  }

  receive(peer: PeerMarks, sampleAt: number): void {
    const frame = peer.player;
    if (!frame || !this.motion.push(frame, sampleAt)) return;
    if (frame.mode !== this.latest.mode) this.onFootFacing.clear();
    this.latest = frame;
    this.pointActive.left = this.pointActive.right = false;
    const points = frame.gestures ?? (frame.gesture ? [frame.gesture] : []);
    for (const point of points) {
      this.pointActive[point.hand] = true;
      this.pointDirections[point.hand].set(...point.direction).normalize();
      this.pointHasTarget[point.hand] = !!point.target;
      if (point.target) this.pointTargets[point.hand].set(...point.target);
    }
    // A character swap keeps the kit; a gear swap rebuilds the body with it, because a skier is not a
    // snowboarder holding something else (`rider.ts`). Both start the peer's pose over from scratch.
    const gear = frame.gear ?? DEFAULT_RIDE_GEAR;
    const stance = frame.stance ?? DEFAULT_SNOWBOARD_STANCE;
    const appearance = equipmentOf(peer);
    const nextAppearanceKey = equipmentKey(appearance);
    if (frame.avatar !== this.avatarId || gear !== this.gear || stance !== this.stance) {
      const previousRider = this.rider, previousBoard = this.board;
      const rebuildGear = gear !== this.gear || stance !== this.stance;
      this.avatarId = frame.avatar;
      this.gear = gear;
      this.stance = stance;
      this.removeBody();
      this.rider = createRider(this.avatarId, undefined, gear, stance);
      if (rebuildGear) this.board = createBoard(gear, stance, appearance);
      this.addBody();
      previousRider.dispose();
      if (rebuildGear) previousBoard.dispose();
      this.firstPose = true;
    }
    if (nextAppearanceKey !== this.appearanceKey) {
      this.appearanceKey = nextAppearanceKey;
      this.board.setAppearance(appearance);
    }
    this.captureLocal(frame.head, this.head, 'head');
    this.captureLocal(frame.hands?.[0] ?? undefined, this.hands[0], 0);
    this.captureLocal(frame.hands?.[1] ?? undefined, this.hands[1], 1);
    this.captureEquipment(frame, sampleAt);
  }

  private captureLocal(value: PlayerTransform | undefined, out: SmoothedLocalTransform, slot: 'head' | 0 | 1) {
    const present = !!value;
    if (slot === 'head') this.headPresent = present;
    else this.handPresent[slot] = present;
    if (!value) return;
    const bodyQ = new THREE.Quaternion(...this.latest.body.q).normalize();
    out.targetPosition.set(...value.p).sub(new THREE.Vector3(...this.latest.body.p)).applyQuaternion(bodyQ.clone().invert());
    out.targetQuaternion.set(...value.q).premultiply(bodyQ.clone().invert()).normalize();
    if (this.firstPose) {
      out.position.copy(out.targetPosition);
      out.quaternion.copy(out.targetQuaternion);
    }
  }

  private captureEquipment(frame: PlayerPose, sampleAt: number) {
    const equipment = frame.equipment;
    this.equipmentPresent = !!equipment;
    if (equipment) this.equipmentMotion.pushTransform(
      frame.seq, equipment.teleport, equipment.transform, equipment.velocity, sampleAt,
    );
  }

  step(dt: number, now: number): void {
    if (this.chatBubble && now >= this.chatBubbleUntil) this.clearChatBubble();
    this.motion.step(dt, now);
    if (this.equipmentPresent) this.equipmentMotion.step(dt, now);
    const follow = 1 - Math.exp(-18 * Math.max(0, dt));
    for (const item of [this.head, ...this.hands]) {
      item.position.lerp(item.targetPosition, follow);
      item.quaternion.slerp(item.targetQuaternion, follow);
    }
    this.board.group.visible = this.equipmentPresent;

    const headTarget = this.headPresent ? {
      position: this.worldPosition(this.head, this.headWorldPosition),
      quaternion: this.worldQuaternion(this.head, this.headWorldQuaternion),
      exactPosition: this.latest.vr,
    } : null;
    const horizontalSpeed = Math.hypot(this.motion.velocity.x, this.motion.velocity.z);
    const walking = this.latest.mode === 'walk';
    const flying = walking && this.latest.animation?.flying === true;
    const targetWalk = walking && !flying ? THREE.MathUtils.clamp(horizontalSpeed / 1.2, 0, 1) : 0;
    this.walkWeight += (targetWalk - this.walkWeight) * (1 - Math.exp(-10 * Math.max(0, dt)));
    if (walking && horizontalSpeed > 0.05) {
      // Cadence rises with speed but stays human-readable at FPS-controller velocities. Phase is observer-local:
      // dropped awareness packets cannot make feet pop backward, while velocity prediction keeps it in tempo.
      this.walkPhase += dt * Math.PI * 2 * (1.2 + Math.min(horizontalSpeed, 7) * 0.22);
      if (this.walkPhase > Math.PI * 2) this.walkPhase %= Math.PI * 2;
    }
    const facing = this.onFootFacing.step(dt, this.motion.quaternion, headTarget?.quaternion ?? null,
      horizontalSpeed);
    const turnDelta = this.onFootFacing.turnDelta;
    if (Math.abs(turnDelta) > 1e-6) this.turnDirection = Math.sign(turnDelta);
    this.turnWeight += (Number(walking && Math.abs(turnDelta) > 1e-6) - this.turnWeight)
      * (1 - Math.exp(-16 * Math.max(0, dt)));
    if (walking && horizontalSpeed <= 0.05 && this.turnWeight > 0.01) {
      this.walkPhase += dt * Math.PI * 2 * 2.2;
      if (this.walkPhase > Math.PI * 2) this.walkPhase %= Math.PI * 2;
    }

    // Both walking and riding use the selected character and the production IK solver. On foot the body root
    // supplies a stable invisible pair of feet while the independently predicted equipment may be metres away;
    // mounted, those anchors come directly from the visible kit's bindings.
    //
    // A snowboard's published quaternion is already rolled, so the two frames coincide; a pair of skis'
    // carries facing only, and the roll goes back on from the animation bank. Seating it is the gear's own
    // job either way, which is what keeps a remote skier's two skis flat to each other and both on the snow.
    const mounted = this.latest.equipment?.state === 'mounted';
    const bank = mounted ? this.latest.animation?.bank ?? 0 : 0;
    this.rolledQuaternion.copy(this.equipmentMotion.quaternion);
    if (mounted && this.gear === 'skis' && bank !== 0) {
      this.rolledQuaternion.multiply(this.bankQuaternion.setFromAxisAngle(FORWARD, -bank * DEG));
    }
    if (this.equipmentPresent) this.board.seat(
      this.equipmentMotion.position, this.equipmentMotion.quaternion, this.rolledQuaternion,
      this.ankleA, this.ankleB,
    );
    const riderFrame = mounted ? this.rolledQuaternion : this.motion.quaternion;
    if (!mounted) {
      // Preserve the former on-foot anchor law without using the now-visible loose kit as the feet frame.
      this.ankleA.copy(this.board.ankleFront).applyQuaternion(riderFrame).add(this.motion.position);
      this.ankleB.copy(this.board.ankleRear).applyQuaternion(riderFrame).add(this.motion.position);
    }
    this.soleUp.copy(UP).applyQuaternion(riderFrame).normalize();
    const bothHands = this.handPresent[0] && this.handPresent[1];
    let handTargets: { a: RiderHandTarget; b: RiderHandTarget } | null = null;
    if (bothHands) {
      this.worldPosition(this.hands[0], this.handA.position);
      this.worldQuaternion(this.hands[0], this.handA.quaternion);
      this.worldPosition(this.hands[1], this.handB.position);
      this.worldQuaternion(this.hands[1], this.handB.quaternion);
      handTargets = { a: this.handA, b: this.handB };
    }
    const pointTargets: Array<{
      hand: 'left' | 'right'; direction: THREE.Vector3; weight: number; target?: THREE.Vector3;
    }> = this.latest.mode === 'ride' ? [] : (['left', 'right'] as const).flatMap(hand => {
      if (!this.pointActive[hand]) return [];
      return [{
        hand, direction: this.pointDirections[hand], weight: 1,
        ...(this.pointHasTarget[hand] ? { target: this.pointTargets[hand] } : {}),
      }];
    });
    // Desktop has no tracked wrist packet, but its held-equipment state is enough to keep the carrying arm on
    // the visible deck instead of leaving it swinging through the walk cycle like a telekinetic grab.
    if (!this.latest.vr && this.latest.equipment?.state === 'held' && !this.pointActive.right) {
      this.heldEquipmentDirection.copy(this.equipmentMotion.position)
        .sub(headTarget?.position ?? this.motion.position).normalize();
      pointTargets.push({
        hand: 'right', direction: this.heldEquipmentDirection,
        target: this.equipmentMotion.position, weight: 1,
      });
    }
    const stanceSign = this.gear === 'snowboard' && this.stance === 'standard' ? -1 : 1;
    const grounded = this.latest.animation?.grounded ?? this.latest.mode !== 'ride';
    const lean = this.latest.animation?.lean ?? 0;
    this.rideForward.set(0, 0, 1).applyQuaternion(riderFrame)
      .multiplyScalar(this.latest.animation?.lead ?? 1);
    riderLookTarget(
      { grounded, lean, landEta: Infinity }, this.motion.velocity, this.rideForward, this.soleUp,
      this.lookForward, this.lookTurnScratch,
    );
    const input = {
      ankleFront: this.ankleA, ankleRear: this.ankleB,
      deckUp: this.soleUp, soleUp: this.soleUp, bank: bank * stanceSign,
      rideForward: this.rideForward, lookForward: this.lookForward,
      vel: this.motion.velocity, accel: this.motion.acceleration,
      grounded,
      dt, crouch: this.latest.animation?.crouch ?? 0,
      lean: lean * stanceSign,
      locomotion: this.latest.mode === 'ride' ? null : {
        phase: this.walkPhase, weight: this.walkWeight, facing,
        turn: this.turnDirection * this.turnWeight,
        flying,
      },
      pointTargets: pointTargets.length ? pointTargets : null,
      handTargets, headTarget,
    };
    if (this.firstPose) { this.rider.reset(input); this.firstPose = false; }
    else this.rider.pose(input);
    const labelAt = headTarget?.position ?? this.motion.position;
    this.label.position.set(labelAt.x, labelAt.y + (headTarget ? 0.3 : 1.95), labelAt.z);
    if (this.chatBubble) {
      this.chatBubble.position.set(labelAt.x, labelAt.y + (headTarget ? 1.65 : 3.3), labelAt.z);
    }
  }

  private worldPosition(local: SmoothedLocalTransform, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(local.position).applyQuaternion(this.motion.quaternion).add(this.motion.position);
  }

  private worldQuaternion(local: SmoothedLocalTransform, out: THREE.Quaternion): THREE.Quaternion {
    return out.copy(this.motion.quaternion).multiply(local.quaternion).normalize();
  }

  dispose() {
    this.clearChatBubble();
    this.removeBody();
    this.label.removeFromParent();
    this.rider.dispose();
    this.board.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
  }
}

function makeLabel(name: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 72;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 36px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(name, 256, 36);
  ctx.fillStyle = color; ctx.fillText(name, 256, 36);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true,
  }));
  sprite.scale.set(10, 1.4, 1); sprite.center.set(0.5, 0); sprite.renderOrder = 12;
  return sprite;
}

function bubbleLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  let remaining = text.replace(/\s+/g, ' ').trim();
  const lines: string[] = [];
  while (remaining && lines.length < maxLines) {
    let take = remaining.length;
    while (take > 1 && ctx.measureText(remaining.slice(0, take)).width > maxWidth) take--;
    if (take < remaining.length) {
      const space = remaining.lastIndexOf(' ', take);
      if (space > 0) take = space;
    }
    lines.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trim();
  }
  if (remaining && lines.length) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines.length ? lines : [''];
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number,
  radius: number): void {
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
}

function makeChatBubble(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  const measuring = canvas.getContext('2d')!;
  measuring.font = '600 30px system-ui, sans-serif';
  const lines = bubbleLines(measuring, text, 448, 4);
  const lineHeight = 38, paddingY = 17, tailHeight = 19;
  canvas.height = paddingY * 2 + lineHeight * lines.length + tailHeight + 6;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '600 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4;
  ctx.fillStyle = 'rgba(10, 22, 32, 0.94)';
  ctx.strokeStyle = '#7fc3ef';
  const boxX = 8, boxY = 4, boxWidth = canvas.width - 16;
  const boxHeight = canvas.height - tailHeight - 8;
  ctx.beginPath();
  roundedRect(ctx, boxX, boxY, boxWidth, boxHeight, 23);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(236, boxY + boxHeight - 1);
  ctx.lineTo(256, canvas.height - 3);
  ctx.lineTo(276, boxY + boxHeight - 1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#edf7ff';
  lines.forEach((line, index) => ctx.fillText(line, 256, boxY + paddingY + lineHeight * (index + 0.5)));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, depthTest: false, transparent: true,
  }));
  sprite.scale.set(7, 7 * canvas.height / canvas.width, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 13;
  return sprite;
}

export function createRemotePlayersLayer(stage: Stage) {
  const avatars = new Map<string, RemoteAvatar>();
  let activePlayers: ActiveMapPlayer[] = [];
  function setPeers(peers: readonly PeerMarks[], serverNow: number) {
    activePlayers = peers.flatMap(peer => peer.player ? [{
      sessionId: peer.sessionId, userId: peer.userId, username: peer.username, mode: peer.player.mode,
    }] : []);
    const here = new Set(peers.filter(peer => peer.player).map(peer => peer.sessionId));
    for (const [id, avatar] of avatars) if (!here.has(id)) { avatar.dispose(); avatars.delete(id); }
    const localNow = performance.now() / 1000;
    for (const peer of peers) {
      if (!peer.player) continue;
      // Convert a server-clock sample to local monotonic time while retaining its age (both network legs).
      const sampleAt = localNow - Math.max(0, serverNow - peer.player.sampleAt) / 1000;
      const held = avatars.get(peer.sessionId);
      if (held) held.receive(peer, sampleAt);
      else avatars.set(peer.sessionId, new RemoteAvatar(stage.scene, peer, sampleAt));
    }
  }
  return {
    setPeers,
    step(dt: number) { const now = performance.now() / 1000; for (const avatar of avatars.values()) avatar.step(dt, now); },
    players(): readonly ActiveMapPlayer[] { return activePlayers; },
    navigationTarget(sessionId: string): PlayerNavigationTarget | null {
      return avatars.get(sessionId)?.navigationTarget() ?? null;
    },
    frontView(userId: string) {
      for (const avatar of avatars.values()) if (avatar.userId === userId) return avatar.frontView();
      return null;
    },
    showChat(userId: string, text: string) {
      for (const avatar of avatars.values()) {
        if (avatar.userId !== userId) continue;
        avatar.showChat(text);
        break;
      }
    },
    dispose() { for (const avatar of avatars.values()) avatar.dispose(); avatars.clear(); activePlayers = []; },
  };
}

export type RemotePlayersLayer = ReturnType<typeof createRemotePlayersLayer>;
