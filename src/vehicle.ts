// A kinematic bicycle model for the car. Holds geodetic position (radians),
// heading, and speed; the caller integrates the ground position each frame from
// `heading`/`speed` and feeds terrain height/slope back in for display.

import { Math as CesiumMath } from 'cesium';

export interface DriveInput {
  throttle: boolean;
  brake: boolean;
  left: boolean;
  right: boolean;
}

export class Vehicle {
  lon: number; // radians
  lat: number; // radians
  heading: number; // radians, 0 = north, clockwise positive
  speed = 0; // m/s (negative = reverse)
  steer = 0; // current front-wheel angle, radians

  // --- tunable characteristics ---
  readonly wheelBase = 2.8; // m — distance between axles; sets the turning circle
  readonly maxSteer = CesiumMath.toRadians(32); // max front-wheel angle
  readonly steerRate = CesiumMath.toRadians(90); // how fast the wheels turn, rad/s
  readonly maxSpeed = 55; // m/s (~200 km/h)
  readonly maxReverse = 12; // m/s
  readonly enginePower = 8.5; // forward accel at full throttle, m/s^2
  readonly brakePower = 22; // braking decel, m/s^2
  readonly dragCoeff = 0.0011; // aero drag ∝ v^2 (caps top speed naturally)
  readonly rollResist = 4.0; // rolling resistance when coasting, m/s^2

  private readonly start: { lon: number; lat: number; heading: number };

  constructor(lon: number, lat: number, heading: number) {
    this.lon = lon;
    this.lat = lat;
    this.heading = heading;
    this.start = { lon, lat, heading };
  }

  reset(): void {
    this.lon = this.start.lon;
    this.lat = this.start.lat;
    this.heading = this.start.heading;
    this.speed = 0;
    this.steer = 0;
  }

  /** Advance speed, steering and heading. Position is integrated by the caller. */
  update(dt: number, input: DriveInput): void {
    // ---- steering: ease toward target, and reduce lock at high speed ----
    // Heading is clockwise-from-north, so a right turn = positive steer/heading.
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const speedFactor = 1 - Math.min(Math.abs(this.speed) / this.maxSpeed, 0.75);
    const targetSteer = dir * this.maxSteer * speedFactor;
    const maxStep = this.steerRate * dt * (dir === 0 ? 1.6 : 1); // recenters faster
    const delta = targetSteer - this.steer;
    this.steer += Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep;

    // ---- longitudinal forces ----
    if (input.throttle) this.speed += this.enginePower * dt;
    if (input.brake) {
      if (this.speed > 0.4) this.speed -= this.brakePower * dt; // braking
      else this.speed -= this.enginePower * 0.55 * dt; // reverse
    }
    if (!input.throttle && !input.brake) {
      // coasting: rolling resistance pulls speed toward zero
      const rr = this.rollResist * dt;
      this.speed = Math.abs(this.speed) <= rr ? 0 : this.speed - Math.sign(this.speed) * rr;
    }
    this.speed -= this.dragCoeff * this.speed * Math.abs(this.speed) * dt; // aero drag
    this.speed = Math.max(-this.maxReverse, Math.min(this.maxSpeed, this.speed));

    // ---- heading from the bicycle model ----
    // yawRate = v / L * tan(steer); reversing flips the sense automatically.
    if (Math.abs(this.speed) > 0.05) {
      const yawRate = (this.speed / this.wheelBase) * Math.tan(this.steer);
      this.heading += yawRate * dt;
    }
  }
}
