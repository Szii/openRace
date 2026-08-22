// Car driving model. Holds geodetic position (radians), heading and speed; the
// caller integrates the ground position each frame from `heading`/`speed`.
//
// This is a kinematic bicycle model with a few dynamics touches that make it
// feel like a real car rather than an arcade go-kart:
//   * an engine torque curve — acceleration falls off as speed rises;
//   * aero drag (∝ v²) + rolling resistance that set a natural top speed;
//   * speed-sensitive steering — less lock at speed so it isn't twitchy;
//   * a lateral grip limit — above it the car understeers (pushes wide)
//     instead of turning on a dime, the way tyres actually saturate.

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
  readonly maxSteer = CesiumMath.toRadians(34); // max front-wheel angle at low speed
  readonly steerRate = CesiumMath.toRadians(110); // how fast the wheels turn, rad/s
  readonly maxSpeed = 60; // m/s (~216 km/h ceiling)
  readonly maxReverse = 12; // m/s
  readonly enginePower = 9.5; // forward accel at full throttle & low speed, m/s^2
  readonly brakePower = 20; // braking decel, m/s^2
  readonly reversePower = 5; // reverse accel, m/s^2
  readonly dragCoeff = 0.0009; // aero drag ∝ v^2 (caps top speed)
  readonly rollResist = 3.5; // rolling resistance when coasting, m/s^2
  readonly gripAccel = 8.5; // max lateral accel (~0.87g) before the tyres let go

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
    // ---- steering: ease toward target; allow less lock the faster we go ----
    // Heading is clockwise-from-north, so a right turn = positive steer/heading.
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const speedFrac = Math.min(Math.abs(this.speed) / this.maxSpeed, 1);
    const steerLimit = this.maxSteer * (1 - 0.55 * speedFrac);
    const target = dir * steerLimit;
    const step = this.steerRate * dt * (dir === 0 ? 1.8 : 1); // recenters faster
    const dSteer = target - this.steer;
    this.steer += Math.abs(dSteer) <= step ? dSteer : Math.sign(dSteer) * step;

    // ---- longitudinal: engine torque curve, brakes, drag, rolling resistance ----
    let accel = 0;
    if (input.throttle) {
      // Force falls off with speed (torque curve), so acceleration tapers.
      accel += this.enginePower * Math.max(0.15, 1 - Math.max(this.speed, 0) / this.maxSpeed);
    }
    if (input.brake) {
      accel -= this.speed > 0.5 ? this.brakePower : this.reversePower; // brake, then reverse
    }
    if (!input.throttle && !input.brake && Math.abs(this.speed) > 0.01) {
      accel -= Math.sign(this.speed) * this.rollResist; // coasting
    }
    accel -= this.dragCoeff * this.speed * Math.abs(this.speed); // aero drag
    this.speed += accel * dt;
    if (!input.throttle && !input.brake && Math.abs(this.speed) < 0.3) this.speed = 0;
    this.speed = Math.max(-this.maxReverse, Math.min(this.maxSpeed, this.speed));

    // ---- heading: bicycle model, limited by lateral grip (understeer) ----
    if (Math.abs(this.speed) > 0.1) {
      // Ideal geometric yaw rate; reversing flips the sense automatically.
      const idealYaw = (this.speed / this.wheelBase) * Math.tan(this.steer);
      const latAccel = this.speed * idealYaw; // lateral accel this turn would need
      let yawRate = idealYaw;
      if (Math.abs(latAccel) > this.gripAccel) {
        // Tyres saturated → can't corner this hard → push wide (understeer).
        yawRate = (Math.sign(idealYaw) * this.gripAccel) / Math.abs(this.speed);
      }
      this.heading += yawRate * dt;
    }
  }
}
