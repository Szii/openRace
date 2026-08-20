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
import { fetchRoads, fetchBuildings } from './osm';
import { buildRoads } from './roads';
import { buildBuildings } from './buildings';
import { Vehicle } from './vehicle';

// ---------------------------------------------------------------------------
// Configuration (all optional — the game runs with no keys at all)
// ---------------------------------------------------------------------------
const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
const googleKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
const hasIon = Boolean(ionToken);
if (hasIon) Ion.defaultAccessToken = ionToken!;

const loadingEl = document.getElementById('loading')!;
const speedEl = document.getElementById('speed')!;
const statusEl = document.getElementById('status')!;

// ---------------------------------------------------------------------------
// Scene
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
viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;

// ---------------------------------------------------------------------------
// Car state
// ---------------------------------------------------------------------------
// Start on a well-mapped street: Times Square, Manhattan.
const START = { lon: -73.9866, lat: 40.7549, headingDeg: 180 };

const vehicle = new Vehicle(
  CesiumMath.toRadians(START.lon),
  CesiumMath.toRadians(START.lat),
  CesiumMath.toRadians(START.headingDeg)
);

const carPos = Cartesian3.fromRadians(vehicle.lon, vehicle.lat, 20);
let modelPitch = 0;
let modelRoll = 0;
let lastGround = 0;
// The translucent drivable-road overlay; toggled with the M key.
let roadOverlay: { show: boolean } | undefined;

// Align the glTF's nose with the travel direction (tweak by ±90/180 if needed).
const MODEL_HEADING_OFFSET = CesiumMath.toRadians(-90);
const CAR_GROUND_OFFSET = 0.2; // metres above sampled ground

// Chase camera placement (metres). Pulled back for a truer sense of scale, but
// kept fairly low so it's less prone to catching overhead structures.
const CAM_DIST = 24;
const CAM_HEIGHT = 7;
const CAM_LOOK_AHEAD = 10;

const carEntity = viewer.entities.add({
  position: new CallbackProperty(() => carPos, false) as any,
  orientation: new CallbackProperty(
    () =>
      Transforms.headingPitchRollQuaternion(
        carPos,
        new HeadingPitchRoll(vehicle.heading + MODEL_HEADING_OFFSET, modelPitch, modelRoll)
      ),
    false
  ) as any,
  model: { uri: '/models/car.glb', scale: 0.9 },
});

// ---------------------------------------------------------------------------
// World: imagery / buildings / roads
// ---------------------------------------------------------------------------
async function loadWorld(): Promise<void> {
  if (!hasIon) {
    viewer.imageryLayers.addImageryProvider(
      new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
    );
  }

  let buildingStatus = '';
  if (googleKey) {
    try {
      const google = await (createGooglePhotorealistic3DTileset as any)({ key: googleKey });
      viewer.scene.primitives.add(google);
      viewer.scene.globe.show = false;
      buildingStatus = 'Google 3D';
    } catch (err) {
      console.warn('Google 3D Tiles failed to load, continuing without them.', err);
    }
  } else if (hasIon) {
    try {
      viewer.scene.primitives.add(await createOsmBuildingsAsync());
      buildingStatus = 'ion buildings';
    } catch (err) {
      console.warn('OSM Buildings failed to load.', err);
    }
  } else {
    // No keys: extrude a 3D city ourselves from OSM building footprints.
    loadingEl.textContent = 'Loading buildings…';
    try {
      const buildings = await fetchBuildings(START.lat, START.lon, 700);
      const n = buildBuildings(viewer.scene, buildings);
      buildingStatus = `${n.toLocaleString()} buildings`;
    } catch (err) {
      console.warn('Buildings failed to load (Overpass).', err);
      buildingStatus = 'buildings failed';
    }
  }

  // Real OSM road network as 3D geometry (draped roads + floating bridges).
  loadingEl.textContent = 'Loading streets…';
  let roadStatus = '';
  try {
    const roads = await fetchRoads(START.lat, START.lon, 1200);
    const result = await buildRoads(viewer.scene, viewer.terrainProvider, roads);
    console.log(
      `Roads: ${result.total} segments (${result.ground} ground, ${result.bridges} bridges).`
    );
    // With photorealistic imagery the real roads already show, so hide the
    // opaque overlay by default; press M to toggle it back on. Bridges (which
    // imagery can't represent as elevated geometry) always stay visible.
    roadOverlay = result.groundPrimitive;
    if (roadOverlay) roadOverlay.show = !hasIon;
    roadStatus = `${result.total.toLocaleString()} roads`;
  } catch (err) {
    console.warn('Road network failed to load (Overpass).', err);
    roadStatus = 'roads failed';
  }

  statusEl.textContent = [buildingStatus, roadStatus].filter(Boolean).join(' · ');

  loadingEl.classList.add('hidden');
  setTimeout(() => loadingEl.remove(), 700);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set<string>();
let chaseCam = true;

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'r') vehicle.reset();
  if (k === 'm' && roadOverlay) roadOverlay.show = !roadOverlay.show;
  if (k === 'c') {
    chaseCam = !chaseCam;
    if (!chaseCam) viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  }
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// Sample terrain height at a local (east, north) offset from the car, in metres.
function groundHeightAt(base: Cartesian3, east: number, north: number): number {
  const enu = Transforms.eastNorthUpToFixedFrame(base);
  const offset = Matrix4.multiplyByPointAsVector(enu, new Cartesian3(east, north, 0), new Cartesian3());
  const p = Cartesian3.add(base, offset, new Cartesian3());
  const h = viewer.scene.globe.getHeight(Cartographic.fromCartesian(p));
  return h ?? lastGround;
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------
let lastTime = performance.now();

viewer.scene.preRender.addEventListener(() => {
  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.1) dt = 0.1;

  vehicle.update(dt, {
    throttle: keys.has('w') || keys.has('arrowup'),
    brake: keys.has('s') || keys.has('arrowdown'),
    left: keys.has('a') || keys.has('arrowleft'),
    right: keys.has('d') || keys.has('arrowright'),
  });

  // Integrate ground position along the current heading in the local ENU frame.
  const p = Cartesian3.fromRadians(vehicle.lon, vehicle.lat, 0);
  const enu = Transforms.eastNorthUpToFixedFrame(p);
  const localForward = new Cartesian3(Math.sin(vehicle.heading), Math.cos(vehicle.heading), 0);
  const worldForward = Matrix4.multiplyByPointAsVector(enu, localForward, new Cartesian3());
  Cartesian3.normalize(worldForward, worldForward);
  Cartesian3.add(
    p,
    Cartesian3.multiplyByScalar(worldForward, vehicle.speed * dt, new Cartesian3()),
    p
  );
  const carto = Cartographic.fromCartesian(p);
  vehicle.lon = carto.longitude;
  vehicle.lat = carto.latitude;

  // Clamp to the terrain surface.
  const ground = viewer.scene.globe.getHeight(carto);
  if (ground !== undefined) lastGround = ground;
  Cartesian3.fromRadians(vehicle.lon, vehicle.lat, lastGround + CAR_GROUND_OFFSET, undefined, carPos);

  // Pitch/roll the car to match the ground slope (nose up on hills, tilt in turns
  // that cross a camber). Sampled with small finite differences, then smoothed.
  const step = 3;
  const fx = Math.sin(vehicle.heading);
  const fy = Math.cos(vehicle.heading);
  const rx = Math.cos(vehicle.heading); // right = heading + 90°
  const ry = -Math.sin(vehicle.heading);
  const hF = groundHeightAt(carPos, fx * step, fy * step);
  const hB = groundHeightAt(carPos, -fx * step, -fy * step);
  const hR = groundHeightAt(carPos, rx * step, ry * step);
  const hL = groundHeightAt(carPos, -rx * step, -ry * step);
  const targetPitch = Math.atan2(hF - hB, 2 * step);
  const targetRoll = Math.atan2(hR - hL, 2 * step);
  modelPitch += (targetPitch - modelPitch) * 0.15;
  modelRoll += (targetRoll - modelRoll) * 0.15;

  // HUD
  speedEl.textContent = `${Math.round(Math.abs(vehicle.speed) * 3.6)} km/h`;

  // Chase camera — explicit world vectors so "forward" is always into the screen.
  if (chaseCam) {
    const up = Matrix4.multiplyByPointAsVector(
      Transforms.eastNorthUpToFixedFrame(carPos),
      new Cartesian3(0, 0, 1),
      new Cartesian3()
    );
    Cartesian3.normalize(up, up);

    const camPos = Cartesian3.clone(carPos, new Cartesian3());
    Cartesian3.add(
      camPos,
      Cartesian3.multiplyByScalar(worldForward, -CAM_DIST, new Cartesian3()),
      camPos
    );
    Cartesian3.add(camPos, Cartesian3.multiplyByScalar(up, CAM_HEIGHT, new Cartesian3()), camPos);

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
