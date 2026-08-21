import {
  Ion,
  Viewer,
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  Terrain,
  Cesium3DTileset,
  createOsmBuildingsAsync,
  createGooglePhotorealistic3DTileset,
  HeadingPitchRoll,
  Transforms,
  Matrix4,
  Ray,
  CallbackProperty,
  OpenStreetMapImageryProvider,
} from 'cesium';
import { fetchRoads, fetchBuildings } from './osm';
import { buildRoads } from './roads';
import { buildBuildings } from './buildings';
import { buildTunnels } from './tunnels';
import { buildSurfaceIndex, type SurfaceIndex } from './surface';
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
// Chase views drive the camera directly, so disable Cesium's own mouse camera
// control (re-enabled only in the Free view).
viewer.scene.screenSpaceCameraController.enableInputs = false;

// ---------------------------------------------------------------------------
// Car state
// ---------------------------------------------------------------------------
// Start in the Presidio, San Francisco (on land), near the Presidio Parkway
// viaducts and the MacArthur / Presidio Parkway tunnels, with the Golden Gate
// Bridge to the west. Low building density. Matches public/data/start-roads.json.
const START = { lon: -122.4665, lat: 37.7995, headingDeg: 290 };

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
// Carved tunnel bits; toggled with the T key.
let tunnelClip: { enabled: boolean } | undefined;
let tunnelPrimitive: { show: boolean } | undefined;
let tunnelsEnabled = false;
// Drivable-surface index: lets the car ramp onto bridge decks / into tunnels.
let surfaceIndex: SurfaceIndex | undefined;
let carHeight = NaN; // smoothed height the car sits at

// Real 3D world (Google Photorealistic 3D Tiles). When active, the car drives
// on the actual mesh surface instead of terrain + synthetic roads.
const GOOGLE_P3DT_ASSET = 2275207; // Google Photorealistic 3D Tiles on Cesium ion
let use3DTiles = false;
let sampled3DHeight = NaN; // height of the 3D mesh under the car (sampled off-render)

// Align the glTF's nose with the travel direction (tweak by ±90/180 if needed).
const MODEL_HEADING_OFFSET = CesiumMath.toRadians(-90);
const CAR_GROUND_OFFSET = 0.2; // metres above sampled ground

// Camera views (cycle with C). dist = behind the car, height = above it,
// lookAhead = how far ahead it aims. The last entry is a free/orbit camera.
const CAM_MODES = [
  { name: 'Chase', dist: 11, height: 4.5, lookAhead: 6 },
  { name: 'Far', dist: 18, height: 8, lookAhead: 8 },
  { name: 'Hood', dist: 4, height: 2.2, lookAhead: 16 },
  { name: 'Top', dist: 0.5, height: 30, lookAhead: 1 },
  { name: 'Free', dist: 0, height: 0, lookAhead: 0 },
];
let camModeIndex = 0;
let camYaw = 0; // orbit offset from directly-behind (drag horizontally to look around)
let camPitchAdj = 0; // extra camera height in metres (drag vertically)
let camZoom = 1; // wheel zoom multiplier
let camPosSmooth: Cartesian3 | undefined; // smoothed camera position (racing lag)
let camDistRatio = 1; // pulled in by the obstruction check when a building blocks
const isFreeCam = () => CAM_MODES[camModeIndex].name === 'Free';

// Desired camera geometry for the current view/car state (shared by the render
// loop and the obstruction check).
function cameraDesired() {
  const mode = CAM_MODES[camModeIndex];
  const dist = mode.dist * camZoom;
  const height = mode.height + camPitchAdj;
  const enu = Transforms.eastNorthUpToFixedFrame(carPos);
  const up = Cartesian3.normalize(
    Matrix4.multiplyByPointAsVector(enu, new Cartesian3(0, 0, 1), new Cartesian3()),
    new Cartesian3()
  );
  const backHeading = vehicle.heading + Math.PI + camYaw;
  const back = Cartesian3.normalize(
    Matrix4.multiplyByPointAsVector(
      enu,
      new Cartesian3(Math.sin(backHeading), Math.cos(backHeading), 0),
      new Cartesian3()
    ),
    new Cartesian3()
  );
  const eye = Cartesian3.add(
    carPos,
    Cartesian3.multiplyByScalar(up, 1.5, new Cartesian3()),
    new Cartesian3()
  );
  const desired = Cartesian3.add(
    carPos,
    Cartesian3.add(
      Cartesian3.multiplyByScalar(back, dist, new Cartesian3()),
      Cartesian3.multiplyByScalar(up, height, new Cartesian3()),
      new Cartesian3()
    ),
    new Cartesian3()
  );
  return { mode, up, eye, desired };
}

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
  model: { uri: '/models/car.glb', scale: 0.55 },
});

// Settle the car onto the 3D-tiles mesh before the scene is revealed.
async function clampCarToTiles(): Promise<void> {
  const s = viewer.scene as any;
  if (!s.sampleHeightMostDetailed) return;
  try {
    const carto = Cartographic.fromRadians(vehicle.lon, vehicle.lat);
    const [res] = await s.sampleHeightMostDetailed([carto], [carEntity]);
    if (res && isFinite(res.height)) {
      sampled3DHeight = res.height;
      carHeight = res.height;
    }
  } catch {
    /* tiles not ready — the per-frame sampler will catch up */
  }
}

function finishLoading(): void {
  loadingEl.classList.add('hidden');
  setTimeout(() => loadingEl.remove(), 700);
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
async function loadWorld(): Promise<void> {
  // Preferred: Google Photorealistic 3D Tiles — a real 3D mesh of the world
  // (roads, bridges, terrain) that the car drives on the actual surface of.
  const load3DTiles = async (tileset: Cesium3DTileset, label: string) => {
    viewer.scene.primitives.add(tileset);
    viewer.scene.globe.show = false; // the tiles bring their own terrain
    use3DTiles = true;
    statusEl.textContent = label;
    loadingEl.textContent = 'Placing you on the map…';
    await clampCarToTiles();
    finishLoading();
  };

  if (hasIon) {
    loadingEl.textContent = 'Loading 3D world…';
    try {
      await load3DTiles(await Cesium3DTileset.fromIonAssetId(GOOGLE_P3DT_ASSET), 'Google Photorealistic 3D');
      return;
    } catch (err) {
      console.warn('Google Photorealistic 3D Tiles unavailable, using fallback.', err);
      use3DTiles = false;
      viewer.scene.globe.show = true;
    }
  } else if (googleKey) {
    try {
      await load3DTiles(await (createGooglePhotorealistic3DTileset as any)({ key: googleKey }), 'Google 3D');
      return;
    } catch (err) {
      console.warn('Google 3D Tiles (key) failed, using fallback.', err);
      use3DTiles = false;
      viewer.scene.globe.show = true;
    }
  }

  // Fallback: OSM imagery + our synthetic 3D roads/bridges/tunnels.
  if (!hasIon) {
    viewer.imageryLayers.addImageryProvider(
      new OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
    );
  }

  let buildingStatus = '';
  if (hasIon) {
    try {
      viewer.scene.primitives.add(await createOsmBuildingsAsync());
      buildingStatus = 'ion buildings';
    } catch (err) {
      console.warn('OSM Buildings failed to load.', err);
    }
  } else {
    loadingEl.textContent = 'Loading buildings…';
    try {
      const buildings = await fetchBuildings(START.lat, START.lon, 700);
      buildingStatus = `${buildBuildings(viewer.scene, buildings).toLocaleString()} buildings`;
    } catch (err) {
      console.warn('Buildings failed to load (Overpass).', err);
      buildingStatus = 'buildings failed';
    }
  }

  loadingEl.textContent = 'Loading streets…';
  let roadStatus = '';
  try {
    const roads = await fetchRoads(START.lat, START.lon, 1500, '/data/start-roads.json');
    const result = await buildRoads(viewer.scene, viewer.terrainProvider, roads);
    roadOverlay = result.groundPrimitive;
    if (roadOverlay) roadOverlay.show = !hasIon;
    roadStatus = `${result.total.toLocaleString()} roads`;
    try {
      const t = await buildTunnels(viewer.scene, viewer.terrainProvider, roads);
      tunnelClip = t.collection;
      tunnelPrimitive = t.primitive;
      if (t.count) roadStatus += ` · ${t.count} tunnels`;
    } catch (err) {
      console.warn('Tunnel carving failed.', err);
    }
    try {
      surfaceIndex = await buildSurfaceIndex(viewer.terrainProvider, roads);
    } catch (err) {
      console.warn('Surface index failed.', err);
    }
  } catch (err) {
    console.warn('Road network failed to load (Overpass).', err);
    roadStatus = 'roads failed';
  }

  statusEl.textContent = [buildingStatus, roadStatus].filter(Boolean).join(' · ');
  finishLoading();
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set<string>();

function cycleCameraView(): void {
  camModeIndex = (camModeIndex + 1) % CAM_MODES.length;
  camYaw = 0;
  camPitchAdj = 0;
  camZoom = 1;
  camPosSmooth = undefined;
  const free = isFreeCam();
  viewer.scene.screenSpaceCameraController.enableInputs = free;
  if (free) viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  statusEl.dataset.view = CAM_MODES[camModeIndex].name;
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'r') vehicle.reset();
  if (k === 'm' && roadOverlay) roadOverlay.show = !roadOverlay.show;
  if (k === 't') {
    tunnelsEnabled = !tunnelsEnabled;
    if (tunnelClip) tunnelClip.enabled = tunnelsEnabled;
    if (tunnelPrimitive) tunnelPrimitive.show = tunnelsEnabled;
  }
  if (k === 'c') cycleCameraView();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// Mouse: drag to look around / adjust the camera angle, wheel to zoom (chase
// views only — the Free view uses Cesium's own controls).
const canvas = viewer.canvas;
let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  if (isFreeCam()) return;
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});
window.addEventListener('pointerup', () => {
  dragging = false;
});
window.addEventListener('pointermove', (e) => {
  if (!dragging || isFreeCam()) return;
  camYaw += (e.clientX - lastX) * 0.005;
  camPitchAdj = Math.max(-3, Math.min(28, camPitchAdj - (e.clientY - lastY) * 0.06));
  lastX = e.clientX;
  lastY = e.clientY;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    if (isFreeCam()) return;
    e.preventDefault();
    camZoom = Math.max(0.4, Math.min(3, camZoom * (e.deltaY > 0 ? 1.1 : 0.9)));
  },
  { passive: false }
);

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

  // Choose the height the car sits at.
  let targetHeight: number;
  if (use3DTiles) {
    // Drive on the real 3D mesh surface (sampled off the render loop).
    targetHeight = isNaN(sampled3DHeight) ? (isNaN(carHeight) ? 0 : carHeight) : sampled3DHeight;
  } else {
    // Terrain, plus a bridge deck / tunnel floor if we're on one.
    const ground = viewer.scene.globe.getHeight(carto);
    if (ground !== undefined) lastGround = ground;
    targetHeight = lastGround;
    const surf = surfaceIndex?.query(vehicle.lon, vehicle.lat);
    if (surf && (surf.kind === 'bridge' || tunnelsEnabled)) targetHeight = surf.height;
  }
  const k = use3DTiles ? 0.3 : 0.18; // smoothing (ramps onto surfaces)
  carHeight = isNaN(carHeight) ? targetHeight : carHeight + (targetHeight - carHeight) * k;
  Cartesian3.fromRadians(vehicle.lon, vehicle.lat, carHeight + CAR_GROUND_OFFSET, undefined, carPos);

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

  // Racing chase camera (skipped in the Free view, which uses Cesium controls).
  if (!isFreeCam()) {
    const { mode, up, eye, desired } = cameraDesired();

    // camDistRatio (obstruction check) pulls the camera in past buildings.
    let camPos = Cartesian3.lerp(eye, desired, camDistRatio, new Cartesian3());

    // Smooth the position for a bit of racing-style lag.
    if (!camPosSmooth) camPosSmooth = Cartesian3.clone(camPos, new Cartesian3());
    else camPosSmooth = Cartesian3.lerp(camPosSmooth, camPos, 0.35, new Cartesian3());
    camPos = camPosSmooth;

    // Keep the camera from dipping below the ground on slopes (cheap, no pick).
    const camCarto = Cartographic.fromCartesian(camPos);
    const camGround = viewer.scene.globe.getHeight(camCarto);
    if (camGround !== undefined && camCarto.height < camGround + 2) {
      Cartesian3.fromRadians(camCarto.longitude, camCarto.latitude, camGround + 2, undefined, camPos);
    }

    const target = Cartesian3.add(
      carPos,
      Cartesian3.add(
        Cartesian3.multiplyByScalar(worldForward, mode.lookAhead, new Cartesian3()),
        Cartesian3.multiplyByScalar(up, 0.8, new Cartesian3()),
        new Cartesian3()
      ),
      new Cartesian3()
    );
    const direction = Cartesian3.subtract(target, camPos, new Cartesian3());
    Cartesian3.normalize(direction, direction);

    viewer.camera.setView({ destination: camPos, orientation: { direction, up } });
  }
});

// Camera-obstruction check. Runs on a timer OUTSIDE the render loop: casting a
// pick ray inside preRender previously broke primitive rendering, so here the
// pick just updates camDistRatio, which the chase camera reads next frame.
setInterval(() => {
  const pickScene = viewer.scene as any; // pickFromRay isn't in the public types
  if (isFreeCam() || !pickScene.pickFromRay) {
    camDistRatio = 1;
    return;
  }
  const { eye, desired } = cameraDesired();
  const dir = Cartesian3.subtract(desired, eye, new Cartesian3());
  const full = Cartesian3.magnitude(dir);
  if (full < 0.01) {
    camDistRatio = 1;
    return;
  }
  Cartesian3.normalize(dir, dir);
  try {
    const hit = pickScene.pickFromRay(new Ray(eye, dir), [carEntity]);
    if (hit?.position) {
      const d = Cartesian3.distance(eye, hit.position);
      camDistRatio = d < full ? Math.max((d - 1) / full, 0.25) : 1;
    } else {
      camDistRatio = 1;
    }
  } catch {
    camDistRatio = 1;
  }
}, 60);

// Sample the 3D-mesh height under the car, OUTSIDE the render loop (sampleHeight
// runs an offscreen pass — doing it in preRender would corrupt rendering). The
// game loop reads the stored value and smooths toward it.
setInterval(() => {
  const s = viewer.scene as any;
  if (!use3DTiles || !s.sampleHeightSupported || !s.sampleHeight) return;
  try {
    const h = s.sampleHeight(Cartographic.fromRadians(vehicle.lon, vehicle.lat), [carEntity]);
    if (typeof h === 'number' && isFinite(h)) sampled3DHeight = h;
  } catch {
    /* tiles not ready under the car yet */
  }
}, 40);

loadWorld();
