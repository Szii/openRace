// Fetches and models the OpenStreetMap road network via the Overpass API.

export interface OsmPoint {
  lon: number; // degrees
  lat: number; // degrees
}

export interface RoadSegment {
  id: number;
  points: OsmPoint[]; // ordered centerline
  highway: string; // OSM highway class, e.g. "primary", "residential"
  layer: number; // OSM layer tag (0 = ground, >0 above, <0 below)
  bridge: boolean;
  tunnel: boolean;
  oneway: boolean;
  lanes: number; // 0 = unknown
  name?: string;
}

// The public Overpass instances are frequently overloaded (504/429). Try a few
// mirrors in turn so a single flaky endpoint doesn't sink the road network.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

async function overpassRequest(query: string): Promise<any> {
  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    // Abort a stalled mirror so we fail over instead of hanging forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${endpoint} -> ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn('Overpass mirror failed, trying next…', err);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`All Overpass mirrors failed: ${lastErr}`);
}

// Roads we care about driving on (skip footways/cycleways/steps by default).
const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service', 'road',
]);

/**
 * Fetch drivable roads within `radius` metres of (lat, lon). Result is cached in
 * localStorage so repeated loads of the same area don't re-hit Overpass.
 */
export async function fetchRoads(
  lat: number,
  lon: number,
  radius: number,
  bundledUrl?: string
): Promise<RoadSegment[]> {
  const cacheKey = `osm-roads:${lat.toFixed(4)}:${lon.toFixed(4)}:${radius}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as RoadSegment[];
    } catch {
      /* fall through and refetch */
    }
  }

  // Prefer a pre-bundled data file (shipped with the app) so the start area
  // never depends on the flaky live Overpass API.
  if (bundledUrl) {
    try {
      const res = await fetch(bundledUrl);
      if (res.ok) {
        const roads = (await res.json()) as RoadSegment[];
        try {
          localStorage.setItem(cacheKey, JSON.stringify(roads));
        } catch {
          /* quota — fine */
        }
        return roads;
      }
    } catch (err) {
      console.warn('Bundled roads unavailable, falling back to Overpass.', err);
    }
  }

  const query = `[out:json][timeout:30];
way["highway"](around:${radius},${lat},${lon});
(._;>;);
out body;`;

  const data = await overpassRequest(query);

  const nodes = new Map<number, OsmPoint>();
  for (const el of data.elements) {
    if (el.type === 'node') nodes.set(el.id, { lon: el.lon, lat: el.lat });
  }

  const roads: RoadSegment[] = [];
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.tags || !el.tags.highway) continue;
    if (!DRIVABLE.has(el.tags.highway)) continue;

    const points: OsmPoint[] = [];
    for (const ref of el.nodes as number[]) {
      const n = nodes.get(ref);
      if (n) points.push(n);
    }
    if (points.length < 2) continue;

    const t = el.tags;
    roads.push({
      id: el.id,
      points,
      highway: t.highway,
      layer: parseInt(t.layer ?? '0', 10) || 0,
      bridge: t.bridge != null && t.bridge !== 'no',
      tunnel: t.tunnel != null && t.tunnel !== 'no',
      oneway: t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1',
      lanes: parseInt(t.lanes ?? '', 10) || 0,
      name: t.name,
    });
  }

  try {
    localStorage.setItem(cacheKey, JSON.stringify(roads));
  } catch {
    /* quota exceeded — fine, just skip caching */
  }
  return roads;
}

export interface Building {
  points: OsmPoint[]; // footprint ring
  height: number; // metres
}

/** Building height in metres from OSM tags, with a sensible default. */
function buildingHeight(t: Record<string, string>): number {
  if (t.height) {
    const h = parseFloat(t.height);
    if (!isNaN(h)) return Math.max(3, h);
  }
  if (t['building:levels']) {
    const levels = parseFloat(t['building:levels']);
    if (!isNaN(levels)) return Math.max(3, levels * 3.2);
  }
  return 9; // ~3 floors
}

/**
 * Fetch building footprints within `radius` metres and give each an extrusion
 * height. Used to build a 3D city when no Cesium ion / Google key is present.
 */
export async function fetchBuildings(lat: number, lon: number, radius: number): Promise<Building[]> {
  const cacheKey = `osm-bldg:${lat.toFixed(4)}:${lon.toFixed(4)}:${radius}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as Building[];
    } catch {
      /* refetch */
    }
  }

  const query = `[out:json][timeout:60];
way["building"](around:${radius},${lat},${lon});
(._;>;);
out body;`;
  const data = await overpassRequest(query);

  const nodes = new Map<number, OsmPoint>();
  for (const el of data.elements) {
    if (el.type === 'node') nodes.set(el.id, { lon: el.lon, lat: el.lat });
  }

  const buildings: Building[] = [];
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.tags || !el.tags.building) continue;
    const points: OsmPoint[] = [];
    for (const ref of el.nodes as number[]) {
      const n = nodes.get(ref);
      if (n) points.push(n);
    }
    // Drop the duplicate closing vertex if present.
    if (points.length > 1) {
      const a = points[0];
      const b = points[points.length - 1];
      if (a.lon === b.lon && a.lat === b.lat) points.pop();
    }
    if (points.length < 3) continue;
    buildings.push({ points, height: buildingHeight(el.tags) });
  }

  try {
    localStorage.setItem(cacheKey, JSON.stringify(buildings));
  } catch {
    /* quota — skip caching */
  }
  return buildings;
}

const DEFAULT_LANES: Record<string, number> = {
  motorway: 6, motorway_link: 2, trunk: 4, trunk_link: 2, primary: 4, primary_link: 2,
  secondary: 3, secondary_link: 2, tertiary: 2, tertiary_link: 2, unclassified: 2,
  residential: 2, living_street: 1, service: 1, road: 2,
};

/** Real-world road width in metres, from lane count (or a class-based default). */
export function roadWidth(r: RoadSegment): number {
  const lanes = r.lanes > 0 ? r.lanes : (DEFAULT_LANES[r.highway] ?? 2);
  return Math.max(3.5, lanes * 3.4);
}

/** A CSS colour string keyed by road class (bridges get their own tint). */
export function roadColorCss(r: RoadSegment): string {
  if (r.bridge) return '#caa24f';
  switch (r.highway) {
    case 'motorway':
    case 'motorway_link':
      return '#e8892b';
    case 'trunk':
    case 'trunk_link':
    case 'primary':
    case 'primary_link':
      return '#f2c14e';
    case 'secondary':
    case 'secondary_link':
      return '#f7e08a';
    case 'tertiary':
    case 'tertiary_link':
      return '#f4f0d0';
    default:
      return '#dcdcdc';
  }
}
