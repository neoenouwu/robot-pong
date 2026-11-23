import * as THREE from 'three';
import {
  SENTINEL,
  TABLE,
  type ThreatPhaseConfig,
} from './constants';
import {
  clamp,
  predictBallAtZ,
  type BallState,
  type PaddleState,
  type Vec3,
} from './physics';

interface BgTentacleTrack {
  group: THREE.Object3D;
  segments: THREE.Object3D[];
  claw: THREE.Object3D | null;
  restPositions: THREE.Vector3[];
  phaseOffset: number;
  ampScale: number;
}

export class SentinelController {
  public readonly root: THREE.Object3D;
  public readonly paddleObject: THREE.Object3D;

  private carapace: THREE.Object3D | null = null;
  private mainEye: THREE.Object3D | null = null;
  private paddleArmSegments: THREE.Object3D[] = [];
  private paddleClaw: THREE.Object3D | null = null;
  private bgTentacles: BgTentacleTrack[] = [];

  private eyeMaterials: THREE.MeshStandardMaterial[] = [];
  private eyeLight: THREE.PointLight | null = null;

  // Dynamic AI & animation state
  public paddleState: PaddleState = {
    pos: { x: -0.22, y: TABLE.SURFACE_Y + 0.32, z: SENTINEL.PADDLE_BASE_Z },
    prevPos: { x: -0.22, y: TABLE.SURFACE_Y + 0.32, z: SENTINEL.PADDLE_BASE_Z },
    vel: { x: 0, y: 0, z: 0 },
    smashCharge: 0,
  };

  private targetPaddlePos = new THREE.Vector3(-0.22, TABLE.SURFACE_Y + 0.32, SENTINEL.PADDLE_BASE_Z);
  private swingImpulse = 0; // +1 forward strike punch
  private recoilImpulse = 0; // when player scores a kill shot
  private smashTelegraph = 0; // 0..1 charging crimson smash
  private plannedSmash = false;
  private plannedErrorX = 0;
  private trackedShotId = -1;
  private shotCounter = 0;
  private clock = 0;

  // Reusable math scratch objects (zero per-frame GC churn)
  private readonly _vA = new THREE.Vector3();
  private readonly _vB = new THREE.Vector3();
  private readonly _vC = new THREE.Vector3();
  private readonly _vD = new THREE.Vector3();
  private readonly _p0 = new THREE.Vector3();
  private readonly _p1 = new THREE.Vector3();
  private readonly _p2 = new THREE.Vector3();
  private readonly _p3 = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _mat = new THREE.Matrix4();
  private readonly _invRootMat = new THREE.Matrix4();

  constructor(
    sentinelModel: THREE.Object3D,
    paddleModel: THREE.Object3D,
    eyeLight?: THREE.PointLight
  ) {
    this.root = sentinelModel;
    this.paddleObject = paddleModel;
    this.eyeLight = eyeLight ?? null;

    this.root.position.set(
      SENTINEL.HOME_POS.x,
      SENTINEL.HOME_POS.y,
      SENTINEL.HOME_POS.z
    );

    // Mount the Sentinel's iconic red table tennis paddle at boss scale
    this.paddleObject.scale.setScalar(SENTINEL.PADDLE_SCALE);
    this.paddleObject.position.set(
      this.paddleState.pos.x,
      this.paddleState.pos.y,
      this.paddleState.pos.z
    );

    this.discoverRigNodes();
  }

  private discoverRigNodes(): void {
    this.carapace = this.root.getObjectByName('Carapace') ?? null;
    this.mainEye = this.root.getObjectByName('MainEyeCore') ?? null;
    this.paddleClaw = this.root.getObjectByName('PaddleClaw') ?? null;

    // Collect PaddleArm_Seg_00 .. PaddleArm_Seg_15 in strict index order
    for (let i = 0; i < 24; i++) {
      const idxStr = String(i).padStart(2, '0');
      const seg = this.root.getObjectByName(`PaddleArm_Seg_${idxStr}`);
      if (seg) {
        this.paddleArmSegments.push(seg);
      }
    }

    // Collect BgTentacle_0 .. BgTentacle_5
    for (let t = 0; t < 8; t++) {
      const grp = this.root.getObjectByName(`BgTentacle_${t}`);
      if (!grp) continue;
      const segs: THREE.Object3D[] = [];
      const restPositions: THREE.Vector3[] = [];
      for (let s = 0; s < 20; s++) {
        const sStr = String(s).padStart(2, '0');
        const seg = grp.getObjectByName(`BgTentacle_${t}_Seg_${sStr}`);
        if (seg) {
          segs.push(seg);
          restPositions.push(seg.position.clone());
        }
      }
      const claw = grp.getObjectByName(`BgTentacle_${t}_Claw`) ?? null;
      if (claw) {
        restPositions.push(claw.position.clone());
      }
      this.bgTentacles.push({
        group: grp,
        segments: segs,
        claw,
        restPositions,
        phaseOffset: t * 1.17,
        ampScale: 0.055 + (t % 3) * 0.02,
      });
    }

    // Gather emissive red eye materials for pulsing / threat phase glow
    this.root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          const std = m as THREE.MeshStandardMaterial;
          if (std && std.emissive && std.emissive.r > 0.4 && std.emissive.g < 0.35) {
            if (!this.eyeMaterials.includes(std)) {
              this.eyeMaterials.push(std);
            }
          }
        }
      }
    });
  }

  public notifyPlayerHit(): void {
    this.shotCounter += 1;
  }

  public triggerSwing(isSmash: boolean): void {
    this.swingImpulse = isSmash ? 1.35 : 0.85;
    this.smashTelegraph = 0;
    this.plannedSmash = false;
  }

  public triggerRecoil(): void {
    this.recoilImpulse = 1.0;
    this.smashTelegraph = 0;
    this.plannedSmash = false;
  }

  public getSmashTelegraph(): number {
    return this.smashTelegraph;
  }

  public getMainEyeWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    if (this.mainEye) {
      this.mainEye.getWorldPosition(out);
    } else {
      out.copy(this.root.position).add(new THREE.Vector3(0, -0.05, 0.85));
    }
    return out;
  }

  /**
   * Called by physics when the Sentinel's paddle strikes the ball.
   */
  public planReturnShot(
    _ball: BallState,
    hitPos: Vec3,
    phase: ThreatPhaseConfig,
    rallyCount: number
  ): {
    targetX: number;
    targetZ: number;
    flightTime: number;
    spin: Vec3;
    isSmash: boolean;
  } {
    const isSmash = this.plannedSmash;
    // Escalate gently within long rallies while keeping returns exciting & returnable
    const rallyBoost = Math.min(0.14, rallyCount * 0.008);

    // Choose smart corner placement biased away from current ball X
    const preferOpposite = Math.random() < 0.72;
    const rawSide = preferOpposite ? -Math.sign(hitPos.x || 1) : Math.sign(hitPos.x || 1);
    const spread = 0.22 + Math.random() * (isSmash ? 0.38 : 0.44);
    const targetX = clamp(
      rawSide * spread + (Math.random() - 0.5) * 0.16,
      -TABLE.HALF_WIDTH + 0.12,
      TABLE.HALF_WIDTH - 0.12
    );
    const targetZ = clamp(
      (isSmash ? 1.02 : 0.78) + (Math.random() - 0.5) * 0.34,
      0.42,
      TABLE.HALF_LENGTH - 0.16
    );

    const baseFlight = clamp(2.85 / phase.returnSpeed - rallyBoost, 0.36, 0.74);
    const flightTime = isSmash ? clamp(baseFlight * 0.74, 0.31, 0.46) : baseFlight;

    const spinDir = Math.random() < 0.5 ? -1 : 1;
    const spinY =
      (isSmash ? 0.55 : 1.0) *
      spinDir *
      phase.spinIntensity *
      (0.35 + Math.random() * 0.65);
    const spinX = isSmash ? -22 : -10 - Math.random() * 8;

    this.triggerSwing(isSmash);

    return {
      targetX,
      targetZ,
      flightTime,
      spin: { x: spinX, y: spinY, z: 0 },
      isSmash,
    };
  }

  /**
   * Updates AI paddle tracking, Sentinel hover/eye tracking, and real-time 3D tentacle spline IK.
   */
  public update(
    dt: number,
    ball: BallState,
    phase: ThreatPhaseConfig,
    isPlaying: boolean,
    onSmashTelegraphStart?: () => void
  ): void {
    this.clock += dt;
    this.swingImpulse = Math.max(0, this.swingImpulse - dt * 4.2);
    this.recoilImpulse = Math.max(0, this.recoilImpulse - dt * 2.4);

    // Save previous paddle pos for swept physics collision
    this.paddleState.prevPos.x = this.paddleState.pos.x;
    this.paddleState.prevPos.y = this.paddleState.pos.y;
    this.paddleState.prevPos.z = this.paddleState.pos.z;

    const incoming = isPlaying && ball.active && ball.vel.z < -0.15;

    if (incoming) {
      if (this.trackedShotId !== this.shotCounter) {
        this.trackedShotId = this.shotCounter;
        // Pick a slight deterministic-for-this-shot imperfection so skillful corners beat it
        const speedFactor = clamp(Math.hypot(ball.vel.x, ball.vel.z) / 8.5, 0.5, 1.5);
        this.plannedErrorX = (Math.random() - 0.5) * 2 * phase.errorMargin * speedFactor;

        // Decide whether this return will be a telegraphed Crimson Smash
        const highBall = ball.pos.y > TABLE.SURFACE_Y + 0.18;
        this.plannedSmash = highBall && Math.random() < phase.smashChance;
        if (this.plannedSmash && onSmashTelegraphStart) {
          onSmashTelegraphStart();
        }
      }

      const pred = predictBallAtZ(ball, SENTINEL.PADDLE_BASE_Z);
      if (pred.willReach) {
        const aimX = clamp(
          pred.x + this.plannedErrorX,
          -TABLE.HALF_WIDTH - 0.25,
          TABLE.HALF_WIDTH + 0.25
        );
        const aimY = clamp(pred.y, TABLE.SURFACE_Y + 0.14, 1.55);

        // Wind up slightly back before punching forward right at contact
        const windUpZ = pred.time < 0.22 ? 0.12 * (1 - pred.time / 0.22) : -0.14;
        this.targetPaddlePos.set(aimX, aimY, SENTINEL.PADDLE_BASE_Z + windUpZ);

        if (this.plannedSmash && pred.time < 0.65) {
          this.smashTelegraph = clamp(1 - pred.time / 0.65, 0.15, 1);
        } else {
          this.smashTelegraph = Math.max(0, this.smashTelegraph - dt * 3);
        }
      }
    } else {
      // Menacing ready stance matching the iconic reference artwork (paddle held left-center!)
      this.smashTelegraph = Math.max(0, this.smashTelegraph - dt * 3.5);
      const idleX = isPlaying ? Math.sin(this.clock * 1.15) * 0.22 - 0.18 : -0.26 + Math.sin(this.clock * 0.9) * 0.08;
      const idleY = TABLE.SURFACE_Y + 0.34 + Math.sin(this.clock * 1.7) * 0.05;
      const idleZ = SENTINEL.PADDLE_BASE_Z + Math.cos(this.clock * 1.1) * 0.04;
      this.targetPaddlePos.set(idleX, idleY, idleZ);
    }

    // Smooth velocity-limited lateral movement (fair, non-teleporting boss AI)
    const maxMove = phase.sentinelSpeed * dt;
    const dx = this.targetPaddlePos.x - this.paddleState.pos.x;
    const dy = this.targetPaddlePos.y - this.paddleState.pos.y;
    const dz = this.targetPaddlePos.z - this.paddleState.pos.z;

    const stepX = clamp(dx, -maxMove, maxMove);
    const stepY = clamp(dy, -maxMove * 0.95, maxMove * 0.95);
    const stepZ = clamp(dz, -maxMove * 1.15, maxMove * 1.15);

    this.paddleState.pos.x += stepX;
    this.paddleState.pos.y += stepY;
    this.paddleState.pos.z += stepZ;

    if (dt > 1e-4) {
      this.paddleState.vel.x = stepX / dt;
      this.paddleState.vel.y = stepY / dt;
      this.paddleState.vel.z = stepZ / dt;
    }

    // Visual paddle position (includes dynamic strike punch & tilt)
    const punchZ = this.swingImpulse * 0.22;
    this.paddleObject.position.set(
      this.paddleState.pos.x,
      this.paddleState.pos.y,
      this.paddleState.pos.z + punchZ
    );
    // Slight natural racket pitch & roll matching the iconic diagonal grip in the artwork
    const paddleRoll = clamp(-this.paddleState.pos.x * 0.28 + 0.22, -0.55, 0.55);
    const paddlePitch = -0.1 + this.swingImpulse * 0.32;
    const paddleYaw = clamp(-this.paddleState.pos.x * 0.22, -0.35, 0.35);
    this.paddleObject.rotation.set(paddlePitch, paddleYaw, paddleRoll);

    // Animate Sentinel body hover, menace lean, and ball eye-tracking
    const hoverY = Math.sin(this.clock * 1.45) * 0.085;
    const hoverX =
      Math.sin(this.clock * 0.72) * 0.09 +
      clamp(this.paddleState.pos.x * 0.32, -0.42, 0.42);
    const recoilZ = -this.recoilImpulse * 0.38;
    const leanZ = this.smashTelegraph * 0.24 + this.swingImpulse * 0.18 + recoilZ;

    this.root.position.set(
      SENTINEL.HOME_POS.x + hoverX,
      SENTINEL.HOME_POS.y + hoverY + this.recoilImpulse * 0.14,
      SENTINEL.HOME_POS.z + leanZ
    );

    // Carapace subtly tracks ball position so the red optical array locks onto the player/ball
    const lookTargetX = ball.active ? ball.pos.x : 0;
    const lookTargetY = ball.active ? ball.pos.y : TABLE.SURFACE_Y + 0.3;
    const desiredYaw = clamp((lookTargetX - this.root.position.x) * 0.18, -0.36, 0.36);
    const desiredPitch = clamp(
      -(lookTargetY - this.root.position.y) * 0.12 - this.recoilImpulse * 0.18,
      -0.24,
      0.34
    );
    this.root.rotation.y += (desiredYaw - this.root.rotation.y) * Math.min(1, dt * 5);
    this.root.rotation.x += (desiredPitch - this.root.rotation.x) * Math.min(1, dt * 5);
    this.root.rotation.z =
      Math.sin(this.clock * 0.9) * 0.035 + this.recoilImpulse * Math.sin(this.clock * 32) * 0.06;

    if (this.carapace) {
      this.carapace.rotation.x = Math.sin(this.clock * 1.8) * 0.025 + this.smashTelegraph * 0.06;
    }

    this.root.updateMatrixWorld(true);

    // Pulse crimson optical sensors & eye light by Threat Phase and Smash Telegraph
    const eyePulse =
      3.4 +
      (phase.phase - 1) * 0.75 +
      Math.sin(this.clock * (3.2 + phase.phase * 1.2)) * 0.55 +
      this.smashTelegraph * 4.5;
    for (const mat of this.eyeMaterials) {
      mat.emissive.setHex(phase.eyeColor);
      mat.emissiveIntensity = eyePulse;
    }
    if (this.eyeLight) {
      this.getMainEyeWorldPosition(this._vA);
      this.eyeLight.position.copy(this._vA);
      this.eyeLight.color.setHex(phase.eyeColor);
      this.eyeLight.intensity = 6.5 + (phase.phase - 1) * 2.2 + this.smashTelegraph * 11.0;
    }

    // Update real-time 3D articulated Paddle Arm spline IK
    this.updatePaddleArmIK(phase);

    // Animate 6 flanking background tentacles
    this.updateBackgroundTentacles(phase);
  }

  private updatePaddleArmIK(phase: ThreatPhaseConfig): void {
    const count = this.paddleArmSegments.length;
    if (count < 2) return;

    // Convert paddle handle grip world point into SentinelRoot local space
    // Paddle handle center is at (0, -0.125 * scale, 0) in paddleObject local space
    this.paddleObject.updateMatrixWorld(true);
    this._vA.set(0, -0.13, -0.015).applyMatrix4(this.paddleObject.matrixWorld);
    this._invRootMat.copy(this.root.matrixWorld).invert();
    this._p3.copy(this._vA).applyMatrix4(this._invRootMat);

    // Shoulder socket on Sentinel's left-front rim (-X in world space, matching reference artwork!)
    this._p0.set(-0.62, -0.08, 0.25);

    // Dramatic sweeping left-side coil arc (matching the iconic massive curved arm in the photo)
    const energy = 0.05 + this.smashTelegraph * 0.14 + (phase.phase - 1) * 0.015;
    const waveX = Math.sin(this.clock * 2.2) * energy;
    const waveY = Math.cos(this.clock * 1.9) * energy;

    this._p1.set(
      Math.min(-1.42, this._p3.x - 0.72) + waveX,
      0.34 + waveY + this.smashTelegraph * 0.22,
      0.58
    );
    this._p2.set(
      Math.min(-1.05, this._p3.x - 0.44) - waveX * 0.7,
      this._p3.y - 0.12 + waveY * 0.6,
      this._p3.z - 0.34
    );

    // Evaluate cubic Bezier curve directly (zero allocations!)
    const evalCubic = (t: number, out: THREE.Vector3) => {
      const u = 1 - t;
      const tt = t * t;
      const uu = u * u;
      const uuu = uu * u;
      const ttt = tt * t;
      out
        .set(0, 0, 0)
        .addScaledVector(this._p0, uuu)
        .addScaledVector(this._p1, 3 * uu * t)
        .addScaledVector(this._p2, 3 * u * tt)
        .addScaledVector(this._p3, ttt);
    };

    for (let i = 0; i < count; i++) {
      const t = (i / count) * 0.93;
      const tNext = Math.min(1, t + 0.06);
      evalCubic(t, this._vB);
      evalCubic(tNext, this._vC);

      const seg = this.paddleArmSegments[i];
      seg.position.copy(this._vB);
      this._mat.lookAt(this._vC, this._vB, this._up);
      seg.quaternion.setFromRotationMatrix(this._mat);
    }

    // Align PaddleClaw so its 4 fingers (extending +0.14m along local +Z) wrap directly around the wooden handle!
    if (this.paddleClaw) {
      evalCubic(0.92, this._vB);
      evalCubic(1.0, this._vC);
      // Tangent pointing from wrist into handle grip
      this._vD.copy(this._vC).sub(this._vB).normalize();
      // Place claw wrist 0.14m back along the tangent so PaddleSocket (local z=+0.14) lands squarely on the handle
      this.paddleClaw.position.copy(this._vC).addScaledVector(this._vD, -0.14);
      this._vA.copy(this.paddleClaw.position).add(this._vD);
      this._mat.lookAt(this._vA, this.paddleClaw.position, this._up);
      this.paddleClaw.quaternion.setFromRotationMatrix(this._mat);
    }
  }

  private updateBackgroundTentacles(phase: ThreatPhaseConfig): void {
    const speed = 1.4 + (phase.phase - 1) * 0.42 + this.smashTelegraph * 2.1;
    const flare = 1.0 + (phase.phase - 1) * 0.14 + this.smashTelegraph * 0.38;

    for (const track of this.bgTentacles) {
      const n = track.segments.length;
      if (n < 2) continue;

      for (let i = 0; i < n; i++) {
        const seg = track.segments[i];
        const rest = track.restPositions[i];
        const u = i / Math.max(1, n - 1);
        const weight = u * u * track.ampScale * flare;
        const w1 = Math.sin(this.clock * speed + track.phaseOffset - u * 3.1);
        const w2 = Math.cos(this.clock * speed * 0.8 + track.phaseOffset + u * 2.4);

        seg.position.set(
          rest.x + w1 * weight * 2.2,
          rest.y + w2 * weight * 1.4,
          rest.z + w1 * weight * 0.9
        );
      }

      // Orient each segment smoothly toward its next segment along local +Z
      for (let i = 0; i < n; i++) {
        const seg = track.segments[i];
        const target =
          i < n - 1
            ? track.segments[i + 1].position
            : track.claw
              ? track.claw.position
              : null;
        if (target) {
          this._mat.lookAt(target, seg.position, this._up);
          seg.quaternion.setFromRotationMatrix(this._mat);
        }
      }

      if (track.claw && track.restPositions.length > n) {
        const restClaw = track.restPositions[n];
        const weight = track.ampScale * flare * 1.15;
        const w1 = Math.sin(this.clock * speed + track.phaseOffset - 3.3);
        const w2 = Math.cos(this.clock * speed * 0.8 + track.phaseOffset + 2.6);
        track.claw.position.set(
          restClaw.x + w1 * weight * 2.2,
          restClaw.y + w2 * weight * 1.4,
          restClaw.z + w1 * weight * 0.9
        );
        const prevPos = track.segments[n - 1].position;
        this._vD.copy(track.claw.position).multiplyScalar(2).sub(prevPos);
        this._mat.lookAt(this._vD, track.claw.position, this._up);
        track.claw.quaternion.setFromRotationMatrix(this._mat);
      }
    }
  }
}
