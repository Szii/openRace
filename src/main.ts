import {
  Ion,
  Viewer,
  Cartesian3,
  Cartographic,
  Math as CesiumMath,
  Terrain,
  Color,
  EllipsoidTerrainProvider,
  Cesium3DTileset,
  createOsmBuildingsAsync,
  createGooglePhotorealistic3DTileset,
  HeadingPitchRoll,
  Transforms,
  Matrix4,
  Ray,
  CallbackProperty,
  OpenStreetMapImageryProvider,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
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
// Cities with Google Photorealistic 3D coverage. Coordinates sit on a road so
// the car spawns on the street. Pick one from the dropdown to teleport.
interface City {
  name: string;
  lon: number;
  lat: number;
  heading: number;
}
const CITIES: City[] = [
  { name: 'San Francisco, US', lon: -122.4014, lat: 37.7911, heading: 235 },
  { name: 'New York, US', lon: -73.9855, lat: 40.758, heading: 180 },
  { name: 'Los Angeles, US', lon: -118.261, lat: 34.0505, heading: 0 },
  { name: 'Las Vegas, US', lon: -115.1726, lat: 36.11, heading: 0 },
  { name: 'Chicago, US', lon: -87.6244, lat: 41.8825, heading: 0 },
  { name: 'Miami, US', lon: -80.1918, lat: 25.77, heading: 0 },
  { name: 'Seattle, US', lon: -122.335, lat: 47.61, heading: 0 },
  { name: 'London, UK', lon: -0.1223, lat: 51.5079, heading: 90 },
  { name: 'Paris, FR', lon: 2.305, lat: 48.87, heading: 120 },
  { name: 'Berlin, DE', lon: 13.37, lat: 52.5145, heading: 90 },
  { name: 'Amsterdam, NL', lon: 4.89, lat: 52.366, heading: 0 },
  { name: 'Barcelona, ES', lon: 2.1686, lat: 41.388, heading: 0 },
  { name: 'Madrid, ES', lon: -3.702, lat: 40.42, heading: 0 },
  { name: 'Rome, IT', lon: 12.4924, lat: 41.903, heading: 0 },
  { name: 'Vienna, AT', lon: 16.372, lat: 48.208, heading: 0 },
  { name: 'Prague, CZ', lon: 14.4378, lat: 50.078, heading: 90 },
  { name: 'Tokyo, JP', lon: 139.7454, lat: 35.66, heading: 0 },
  { name: 'Sydney, AU', lon: 151.2093, lat: -33.87, heading: 0 },
  { name: 'Toronto, CA', lon: -79.3832, lat: 43.648, heading: 0 },
];
let currentCityIndex = 0;
const START = {
  lon: CITIES[currentCityIndex].lon,
  lat: CITIES[currentCityIndex].lat,
  headingDeg: CITIES[currentCityIndex].heading,
};

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
let prevCarHeight = NaN; // last frame's height (for slope-from-motion pitch)

// Real 3D world (Google Photorealistic 3D Tiles). When active, the car drives
// on the actual mesh surface instead of terrain + synthetic roads.
const GOOGLE_P3DT_ASSET = 2275207; // Google Photorealistic 3D Tiles on Cesium ion
let use3DTiles = false;
let p3dtTileset: Cesium3DTileset | undefined;
let sampled3DHeight = NaN; // height of the 3D mesh under the car (sampled off-render)

// Coverage tracking: block the car at the edge of the mapped 3D area.
let established = false; // have we ever found ground for the car?
let missCount = 0; // consecutive ticks with no surface below the car
let outOfBounds = false;
let lastGoodLon = NaN;
let lastGoodLat = NaN;
let lastGoodHeight = NaN;
const boundsMsgEl = document.getElementById('boundsMsg')!;
const citySelect = document.getElementById('citySelect') as HTMLSelectElement;

function setOutOfBounds(v: boolean): void {
  if (outOfBounds === v) return;
  outOfBounds = v;
  boundsMsgEl.classList.toggle('show', v);
}

// Align the glTF's nose with the travel direction (tweak by ±90/180 if needed).
const MODEL_HEADING_OFFSET = CesiumMath.toRadians(-90);
const CAR_GROUND_OFFSET = 0.2; // metres above sampled ground

// Camera views (cycle with C). dist = behind the car, height = above it,
// lookAhead = how far ahead it aims. The last entry is a free/orbit camera.
const CAM_MODES = [
  { name: 'Chase', dist: 12, height: 6, lookAhead: 6 },
  { name: 'Far', dist: 20, height: 9, lookAhead: 8 },
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

// Settle the car onto the 3D-tiles mesh before the scene is revealed. Uses a
// cheap high-altitude ray against whatever tiles are loaded (coarse is fine),
// polling until tiles stream in. Much faster than forcing most-detailed tiles.
async function clampCarToTiles(): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const h = castDown(9000);
    if (h !== null) {
      sampled3DHeight = h;
      carHeight = h;
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function finishLoading(): void {
  loadingEl.classList.add('hidden'); // kept in the DOM so teleports can reuse it
}

// Teleport the car to given coordinates (the 3D tileset is global, no reload).
async function teleportToCoords(
  lonRad: number,
  latRad: number,
  headingRad: number,
  label: string
): Promise<void> {
  vehicle.lon = lonRad;
  vehicle.lat = latRad;
  vehicle.heading = headingRad;
  vehicle.speed = 0;
  vehicle.steer = 0;
  carHeight = NaN;
  sampled3DHeight = NaN;
  established = false;
  missCount = 0;
  setOutOfBounds(false);
  camPosSmooth = undefined;
  if (use3DTiles) {
    loadingEl.textContent = `Loading ${label}…`;
    loadingEl.classList.remove('hidden');
    const ok = await clampCarToTiles();
    loadingEl.classList.add('hidden');
    if (!ok) setOutOfBounds(true); // no 3D mesh here — show the message
  }
}

async function teleportTo(city: City): Promise<void> {
  await teleportToCoords(
    CesiumMath.toRadians(city.lon),
    CesiumMath.toRadians(city.lat),
    CesiumMath.toRadians(city.heading),
    city.name
  );
}

// ---------------------------------------------------------------------------
// Map mode: fly up to a top-down view and click the mesh to pick a spawn point.
// ---------------------------------------------------------------------------
let mapMode = false;
const mapBtn = document.getElementById('mapBtn')!;
const mapHintEl = document.getElementById('mapHint')!;
const MAP_HINT_DEFAULT = mapHintEl.textContent || '';
let hintTimer = 0;

function flashMapHint(msg: string): void {
  mapHintEl.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => (mapHintEl.textContent = MAP_HINT_DEFAULT), 2600);
}

function flyMapTo(lonRad: number, latRad: number): void {
  viewer.camera.flyTo({
    destination: Cartesian3.fromRadians(lonRad, latRad, 2200),
    orientation: { heading: 0, pitch: CesiumMath.toRadians(-72), roll: 0 },
    duration: 1.4,
  });
}

// Show/hide a red "no coverage" backdrop under the 3D mesh. It's a plain red
// ellipsoid at sea level, so the Google mesh (at real elevation) occludes it
// where coverage exists — leaving red only where there's no 3D data.
const flatTerrain = new EllipsoidTerrainProvider();
function setCoverageBackdrop(on: boolean): void {
  if (!use3DTiles) return; // only meaningful in Google 3D mode
  if (on) {
    viewer.scene.terrainProvider = flatTerrain;
    viewer.scene.globe.baseColor = Color.fromCssColorString('#c0231f');
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      viewer.imageryLayers.get(i).show = false;
    }
    viewer.scene.globe.show = true;
  } else {
    viewer.scene.globe.show = false;
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      viewer.imageryLayers.get(i).show = true;
    }
  }
}

function enterMapMode(): void {
  mapMode = true;
  mapBtn.textContent = '✕ Close';
  mapHintEl.textContent = MAP_HINT_DEFAULT;
  mapHintEl.classList.add('show');
  viewer.scene.screenSpaceCameraController.enableInputs = true; // let the user pan/zoom
  setCoverageBackdrop(true);
  flyMapTo(vehicle.lon, vehicle.lat);
}

function exitMapMode(): void {
  mapMode = false;
  mapBtn.textContent = '🗺 Map';
  mapHintEl.classList.remove('show');
  viewer.scene.screenSpaceCameraController.enableInputs = isFreeCam();
  setCoverageBackdrop(false);
  camPosSmooth = undefined;
}

mapBtn.addEventListener('click', () => (mapMode ? exitMapMode() : enterMapMode()));

// Click the map to spawn there (only where the 3D mesh exists).
const pickHandler = new ScreenSpaceEventHandler(viewer.canvas);
pickHandler.setInputAction((e: any) => {
  if (!mapMode) return;
  const pos = viewer.scene.pickPosition(e.position);
  if (!pos) {
    flashMapHint('No 3D coverage there — click a mapped (non-red) area.');
    return;
  }
  const carto = Cartographic.fromCartesian(pos);
  // The red backdrop is a sea-level ellipsoid; the mesh is real elevation. A
  // picked 3D-tile feature or a clearly non-sea-level height means real coverage.
  const picked = viewer.scene.pick(e.position);
  const onMesh = !!picked || Math.abs(carto.height) > 8;
  if (!onMesh) {
    flashMapHint('That area has no Google 3D — click a mapped (non-red) area.');
    return;
  }
  exitMapMode();
  void teleportToCoords(carto.longitude, carto.latitude, vehicle.heading, 'selected spot');
}, ScreenSpaceEventType.LEFT_CLICK);

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
async function loadWorld(): Promise<void> {
  // Google Photorealistic 3D Tiles — a real 3D mesh the car drives on. The
  // tileset is global; we keep it loaded and teleport the car between covered
  // cities. Only fall back to terrain if the tileset itself can't be loaded.
  const startTiles = async (tileset: Cesium3DTileset, label: string): Promise<boolean> => {
    tileset.maximumScreenSpaceError = 20; // a bit coarser → smoother framerate
    // Keep a big tile cache so driving around re-streams far less.
    (tileset as any).cacheBytes = 1_500_000_000;
    (tileset as any).maximumCacheOverflowBytes = 1_000_000_000;
    p3dtTileset = tileset;
    viewer.scene.primitives.add(tileset);
    viewer.scene.globe.show = false; // the tiles bring their own terrain
    use3DTiles = true;
    loadingEl.textContent = 'Placing you on the map…';
    await clampCarToTiles();
    statusEl.textContent = label;
    finishLoading();
    return true;
  };

  let googleFailed = false;
  if (hasIon) {
    loadingEl.textContent = 'Loading Google 3D…';
    // The load can fail transiently (Google rate-limits sessions); retry first.
    let tileset: Cesium3DTileset | null = null;
    for (let i = 0; i < 4 && !tileset; i++) {
      try {
        tileset = await Cesium3DTileset.fromIonAssetId(GOOGLE_P3DT_ASSET);
      } catch (err) {
        console.warn(`Google 3D load attempt ${i + 1} failed; retrying…`, err);
        await new Promise((r) => setTimeout(r, 900));
      }
    }
    if (tileset) {
      try {
        await startTiles(tileset, 'Google Photorealistic 3D');
        return;
      } catch (err) {
        console.warn('Google 3D tiles failed after load; using fallback.', err);
        viewer.scene.primitives.remove(tileset);
        use3DTiles = false;
        viewer.scene.globe.show = true;
        googleFailed = true;
      }
    } else {
      console.warn('Google 3D unavailable after retries; using terrain fallback.');
      use3DTiles = false;
      viewer.scene.globe.show = true;
      googleFailed = true;
    }
  } else if (googleKey) {
    try {
      await startTiles(await (createGooglePhotorealistic3DTileset as any)({ key: googleKey }), 'Google 3D');
      return;
    } catch (err) {
      console.warn('Google 3D Tiles (key) failed, using fallback.', err);
      use3DTiles = false;
      viewer.scene.globe.show = true;
      googleFailed = true;
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
    const roads = await fetchRoads(START.lat, START.lon, 1500);
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

  statusEl.textContent = [
    googleFailed ? 'Google 3D failed — terrain (reload to retry)' : 'Cesium 3D terrain',
    buildingStatus,
    roadStatus,
  ]
    .filter(Boolean)
    .join(' · ');
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

// Populate the city dropdown and teleport on selection.
CITIES.forEach((c, i) => {
  const opt = document.createElement('option');
  opt.value = String(i);
  opt.textContent = c.name;
  citySelect.appendChild(opt);
});
citySelect.value = String(currentCityIndex);
citySelect.addEventListener('change', () => {
  currentCityIndex = parseInt(citySelect.value, 10);
  const c = CITIES[currentCityIndex];
  if (mapMode) {
    // In map mode, fly the overview to the city so you can click a spot.
    flyMapTo(CesiumMath.toRadians(c.lon), CesiumMath.toRadians(c.lat));
  } else {
    void teleportTo(c);
  }
  citySelect.blur();
});

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'escape' && mapMode) exitMapMode();
  if (k === 'r') void teleportTo(CITIES[currentCityIndex]);
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
  if (isFreeCam() || mapMode) return;
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});
window.addEventListener('pointerup', () => {
  dragging = false;
});
window.addEventListener('pointermove', (e) => {
  if (!dragging || isFreeCam() || mapMode) return;
  camYaw += (e.clientX - lastX) * 0.005;
  camPitchAdj = Math.max(-3, Math.min(28, camPitchAdj - (e.clientY - lastY) * 0.06));
  lastX = e.clientX;
  lastY = e.clientY;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    if (isFreeCam() || mapMode) return;
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

  // In map mode the car is frozen and Cesium controls the camera.
  if (mapMode) return;

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

  // Don't let the car leave the mapped 3D area: hold it at the last covered spot.
  if (use3DTiles && outOfBounds && !isNaN(lastGoodLon)) {
    vehicle.lon = lastGoodLon;
    vehicle.lat = lastGoodLat;
    vehicle.speed = 0;
  }

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
  const k = use3DTiles ? 0.4 : 0.18; // smoothing (ramps onto surfaces)
  carHeight = isNaN(carHeight) ? targetHeight : carHeight + (targetHeight - carHeight) * k;
  Cartesian3.fromRadians(vehicle.lon, vehicle.lat, carHeight + CAR_GROUND_OFFSET, undefined, carPos);

  // Pitch/roll the car to match the ground slope.
  if (use3DTiles) {
    // Derive the road grade from how the mesh height changes as we move (cheap —
    // no extra picks). Only while moving; otherwise ease pitch back to flat.
    const horiz = Math.abs(vehicle.speed) * dt;
    if (horiz > 0.05 && !isNaN(prevCarHeight)) {
      const dir = vehicle.speed >= 0 ? 1 : -1;
      let targetPitch = Math.atan2((carHeight - prevCarHeight) * dir, horiz);
      targetPitch = Math.max(-0.5, Math.min(0.5, targetPitch));
      modelPitch += (targetPitch - modelPitch) * 0.1;
    } else {
      modelPitch += (0 - modelPitch) * 0.05;
    }
    modelRoll += (0 - modelRoll) * 0.1;
  } else {
    // Terrain mode: sample nearby heights directly (finite differences).
    const step = 3;
    const fx = Math.sin(vehicle.heading);
    const fy = Math.cos(vehicle.heading);
    const rx = Math.cos(vehicle.heading); // right = heading + 90°
    const ry = -Math.sin(vehicle.heading);
    const hF = groundHeightAt(carPos, fx * step, fy * step);
    const hB = groundHeightAt(carPos, -fx * step, -fy * step);
    const hR = groundHeightAt(carPos, rx * step, ry * step);
    const hL = groundHeightAt(carPos, -rx * step, -ry * step);
    modelPitch += (Math.atan2(hF - hB, 2 * step) - modelPitch) * 0.15;
    modelRoll += (Math.atan2(hR - hL, 2 * step) - modelRoll) * 0.15;
  }
  prevCarHeight = carHeight;

  // HUD
  speedEl.textContent = `${Math.round(Math.abs(vehicle.speed) * 3.6)} km/h`;

  // Racing chase camera (skipped in the Free view, which uses Cesium controls).
  if (!isFreeCam()) {
    const { mode, up, eye, desired } = cameraDesired();

    // camDistRatio (obstruction check) pulls the camera in past buildings.
    let camPos = Cartesian3.lerp(eye, desired, camDistRatio, new Cartesian3());

    // Smooth the position for a bit of racing-style lag.
    if (!camPosSmooth) camPosSmooth = Cartesian3.clone(camPos, new Cartesian3());
    else camPosSmooth = Cartesian3.lerp(camPosSmooth, camPos, 0.5, new Cartesian3());
    camPos = camPosSmooth;

    // Keep the camera from dipping below the ground (cheap, no pick). In 3D-tiles
    // mode use the car's sampled mesh height; otherwise the terrain height.
    const camCarto = Cartographic.fromCartesian(camPos);
    let floor: number | undefined;
    if (use3DTiles) {
      floor = isNaN(sampled3DHeight) ? undefined : sampled3DHeight + 2;
    } else {
      const camGround = viewer.scene.globe.getHeight(camCarto);
      floor = camGround !== undefined ? camGround + 2 : undefined;
    }
    if (floor !== undefined && camCarto.height < floor) {
      Cartesian3.fromRadians(camCarto.longitude, camCarto.latitude, floor, undefined, camPos);
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
  if (mapMode || isFreeCam() || !pickScene.pickFromRay) {
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
}, 120);

// Find the road height under the car, OUTSIDE the render loop (picking runs an
// offscreen pass; doing it in preRender corrupts rendering). Cast a ray DOWN
// from a given altitude and return the first surface below it.
const RAY_START_ABOVE = 2.5; // metres above the car the local down-ray starts
function castDown(startHeight: number): number | null {
  const s = viewer.scene as any;
  const start = Cartesian3.fromRadians(vehicle.lon, vehicle.lat, startHeight);
  const up = Cartesian3.normalize(
    Matrix4.multiplyByPointAsVector(
      Transforms.eastNorthUpToFixedFrame(start),
      new Cartesian3(0, 0, 1),
      new Cartesian3()
    ),
    new Cartesian3()
  );
  const down = Cartesian3.negate(up, new Cartesian3());
  const hit = s.pickFromRay(new Ray(start, down), [carEntity]);
  if (hit?.position) {
    const h = Cartographic.fromCartesian(hit.position).height;
    if (isFinite(h)) return h;
  }
  return null;
}

setInterval(() => {
  const s = viewer.scene as any;
  if (mapMode || !use3DTiles || !s.pickFromRay) return;
  try {
    const onSurface = (h: number) => {
      sampled3DHeight = h;
      established = true;
      missCount = 0;
      lastGoodLon = vehicle.lon;
      lastGoodLat = vehicle.lat;
      lastGoodHeight = h;
      setOutOfBounds(false);
    };
    // Local ray just above the car — first surface below it, so overhead trees
    // and stacked roads are ignored during normal driving.
    const local = isNaN(carHeight) ? null : castDown(carHeight + RAY_START_ABOVE);
    if (local !== null) {
      onSurface(local);
    } else {
      // Nothing just above the car. Before declaring an edge, look from high up:
      // the surface may have shifted up (LOD refining) or we spawned below it.
      const high = castDown(9000);
      if (high !== null) {
        onSurface(high);
      } else if (established) {
        // Genuinely no mesh here → we're leaving the mapped area.
        missCount++;
        if (missCount >= 3) setOutOfBounds(true);
      }
    }
  } catch {
    /* tiles not ready under the car yet */
  }
}, 55);

loadWorld();
