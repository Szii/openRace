import {
  Ion,
  Viewer,
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  Terrain,
  createOsmBuildingsAsync,
  createGooglePhotorealistic3DTileset,
  HeadingPitchRoll,
  Transforms,
  Matrix4,
  CallbackProperty,
  OpenStreetMapImageryProvider,
} from 'cesium';

// ---------------------------------------------------------------------------
// Configuration (all optional — the game runs with no keys at all)
//   VITE_CESIUM_ION_TOKEN     -> free token from https://ion.cesium.com
//                                enables world terrain + OSM 3D buildings.
//   VITE_GOOGLE_MAPS_API_KEY  -> paid Google "Map Tiles API" key, enables
//                                Google Photorealistic 3D Tiles.
// ---------------------------------------------------------------------------
const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
const googleKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const hasIon = Boolean(ionToken);

if (hasIon) {
  Ion.defaultAccessToken = ionToken!;
}

const loadingEl = document.getElementById('loading')!;
const speedEl = document.getElementById('speed')!;

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------
const viewer = new Viewer('cesiumContainer', {
  terrain: hasIon ? Terrain.fromWorldTerrain() : undefined,
  baseLayer: hasIon ? undefined : false,
  animation: false,
  timeline: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  baseLayerPicker: hasIon,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});

viewer.scene.globe.depthTestAgainstTerrain = true;
// Cesium's default green atmosphere/ground fog kept; nicer for a game feel.
viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;

async function loadWorld(): Promise<void> {
  // Without an ion token, fall back to raw OpenStreetMap raster street tiles
  // draped on a flat ellipsoid. Still fully drivable, just no 3D buildings.
  if (!hasIon) {
    viewer.imageryLayers.addImageryProvider(
      new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
    );
  }

  // Google Photorealistic 3D Tiles (the "Google Earth" data) — optional.
  if (googleKey) {
    try {
      const google = await (createGooglePhotorealistic3DTileset as any)({ key: googleKey });
      viewer.scene.primitives.add(google);
      // Google tiles already contain terrain + buildings; hide the base globe.
      viewer.scene.globe.show = false;
    } catch (err) {
      console.warn('Google 3D Tiles failed to load, continuing without them.', err);
    }
  } else if (hasIon) {
    // Cesium OSM Buildings: textured 3D buildings worldwide, from OpenStreetMap.
    try {
      const osmBuildings = await createOsmBuildingsAsync();
      viewer.scene.primitives.add(osmBuildings);
    } catch (err) {
      console.warn('OSM Buildings failed to load.', err);
    }
  }

  loadingEl.classList.add('hidden');
  setTimeout(() => loadingEl.remove(), 700);
}

// ---------------------------------------------------------------------------
// Car state
// ---------------------------------------------------------------------------
// Start on a well-mapped street: Times Square, Manhattan.
const START = {
  lon: CesiumMath.toRadians(-73.9866),
  lat: CesiumMath.toRadians(40.7549),
  heading: CesiumMath.toRadians(180), // facing south, down 7th Ave
};

const carPos = Cartesian3.fromRadians(START.lon, START.lat, 20);
let carHeading = START.heading;
let speed = 0; // metres / second (negative = reverse)

// Driving feel (tweak freely).
const MAX_FORWARD = 45; // m/s ≈ 162 km/h
const MAX_REVERSE = 10;
const ACCEL = 12;
const BRAKE = 26;
const FRICTION = 6;
const TURN_RATE = 1.7; // rad/s at full lock

// The glTF's nose does not necessarily point along +Y, so rotate the model to
// line its nose up with the travel direction. Tweak by ±90°/180° if the car
// looks sideways or backwards.
const MODEL_HEADING_OFFSET = CesiumMath.toRadians(-90);
const CAR_GROUND_OFFSET = 0.2; // metres the model sits above the sampled ground

// Chase camera placement (metres), computed explicitly to avoid convention bugs.
const CAM_DIST = 18; // how far behind the car
const CAM_HEIGHT = 7; // how high above the car
const CAM_LOOK_AHEAD = 8; // aim point ahead of the car

function resetCar(): void {
  Cartesian3.fromRadians(START.lon, START.lat, 20, undefined, carPos);
  carHeading = START.heading;
  speed = 0;
}

// The car: a glTF model, positioned and oriented from the driving state.
viewer.entities.add({
  position: new CallbackProperty(() => carPos, false) as any,
  orientation: new CallbackProperty(
    () =>
      Transforms.headingPitchRollQuaternion(
        carPos,
        new HeadingPitchRoll(carHeading + MODEL_HEADING_OFFSET, 0, 0)
      ),
    false
  ) as any,
  model: {
    uri: '/models/car.glb',
    minimumPixelSize: 48,
    maximumScale: 40,
    scale: 1.0,
  },
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set<string>();
let chaseCam = true;

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'r') resetCar();
  if (k === 'c') {
    chaseCam = !chaseCam;
    if (!chaseCam) viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  }
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) {
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// ---------------------------------------------------------------------------
// Game loop — runs every rendered frame
// ---------------------------------------------------------------------------
let lastTime = performance.now();

viewer.scene.preRender.addEventListener(() => {
  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.1) dt = 0.1; // clamp after tab-switches / hitches

  const throttle = keys.has('w') || keys.has('arrowup');
  const brake = keys.has('s') || keys.has('arrowdown');
  const left = keys.has('a') || keys.has('arrowleft');
  const right = keys.has('d') || keys.has('arrowright');

  // Longitudinal physics
  if (throttle) {
    speed += ACCEL * dt;
  } else if (brake) {
    speed -= BRAKE * dt;
  } else {
    const f = FRICTION * dt;
    if (speed > f) speed -= f;
    else if (speed < -f) speed += f;
    else speed = 0;
  }
  speed = Math.max(-MAX_REVERSE, Math.min(MAX_FORWARD, speed));

  // Steering — scales with speed, and flips when reversing (like a real car).
  const steer = (left ? 1 : 0) - (right ? 1 : 0);
  if (steer !== 0 && speed !== 0) {
    const grip = Math.min(Math.abs(speed) / 8, 1) * Math.sign(speed);
    carHeading -= steer * TURN_RATE * dt * grip;
  }

  // Move along the current heading in the local East-North-Up frame.
  const enu = Transforms.eastNorthUpToFixedFrame(carPos);
  const localForward = new Cartesian3(Math.sin(carHeading), Math.cos(carHeading), 0);
  const worldForward = Matrix4.multiplyByPointAsVector(enu, localForward, new Cartesian3());
  Cartesian3.normalize(worldForward, worldForward);
  Cartesian3.add(
    carPos,
    Cartesian3.multiplyByScalar(worldForward, speed * dt, new Cartesian3()),
    carPos
  );

  // Clamp the car to the ground so it hugs the terrain.
  const carto = Cartographic.fromCartesian(carPos);
  const ground = viewer.scene.globe.getHeight(carto);
  const h = (ground !== undefined ? ground : carto.height) + CAR_GROUND_OFFSET;
  Cartesian3.fromRadians(carto.longitude, carto.latitude, h, undefined, carPos);

  // HUD
  speedEl.textContent = `${Math.round(Math.abs(speed) * 3.6)} km/h`;

  // Chase camera: sit behind and above the car, aimed just ahead of it.
  // Built from explicit world vectors so "forward" is always into the screen.
  if (chaseCam) {
    const up = Matrix4.multiplyByPointAsVector(
      Transforms.eastNorthUpToFixedFrame(carPos),
      new Cartesian3(0, 0, 1),
      new Cartesian3()
    );
    Cartesian3.normalize(up, up);

    // camPos = carPos - forward * CAM_DIST + up * CAM_HEIGHT
    const camPos = Cartesian3.clone(carPos, new Cartesian3());
    Cartesian3.add(
      camPos,
      Cartesian3.multiplyByScalar(worldForward, -CAM_DIST, new Cartesian3()),
      camPos
    );
    Cartesian3.add(camPos, Cartesian3.multiplyByScalar(up, CAM_HEIGHT, new Cartesian3()), camPos);

    // Look at a point a little ahead of the car.
    const target = Cartesian3.add(
      carPos,
      Cartesian3.multiplyByScalar(worldForward, CAM_LOOK_AHEAD, new Cartesian3()),
      new Cartesian3()
    );
    const direction = Cartesian3.subtract(target, camPos, new Cartesian3());
    Cartesian3.normalize(direction, direction);

    viewer.camera.setView({ destination: camPos, orientation: { direction, up } });
  }
});

loadWorld();
