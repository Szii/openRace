// Regenerates public/data/start-roads.json — the bundled road network for the
// start area, so the app doesn't depend on the (flaky) live Overpass API there.
// Run:  node scripts/fetch-start-data.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const LAT = 37.7995;
const LON = -122.4665;
const RADIUS = 1500;

const DRIVABLE = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street', 'service', 'road',
]);

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const query = `[out:json][timeout:60];
way["highway"](around:${RADIUS},${LAT},${LON});
(._;>;);
out body;`;

async function overpass() {
  let lastErr;
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query) });
      if (!res.ok) throw new Error(`${ep} -> ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn('mirror failed:', String(err).split('\n')[0]);
    }
  }
  throw new Error('all mirrors failed: ' + lastErr);
}

const data = await overpass();
const nodes = new Map();
for (const el of data.elements) if (el.type === 'node') nodes.set(el.id, { lon: el.lon, lat: el.lat });

const roads = [];
for (const el of data.elements) {
  if (el.type !== 'way' || !el.tags || !el.tags.highway) continue;
  if (!DRIVABLE.has(el.tags.highway)) continue;
  const points = [];
  for (const ref of el.nodes) {
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

mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/start-roads.json', JSON.stringify(roads));

const bridges = roads.filter((r) => r.bridge).length;
const tunnels = roads.filter((r) => r.tunnel).length;
console.log(`Wrote ${roads.length} roads (${bridges} bridges, ${tunnels} tunnels) to public/data/start-roads.json`);
