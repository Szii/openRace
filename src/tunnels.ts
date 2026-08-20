// Carves tunnels out of the terrain and renders their interiors.
//
// For each tunnel we (1) cut a hole in the globe (terrain + imagery) along the
// tunnel footprint using a ClippingPolygon, and (2) fill the void with a sunken
// road floor plus side walls (left open at the top so you can see inside).
//
// Note: this is a *visual* carve. The car still follows the surface until the
// layer-aware road graph lands — it can't yet descend into the tunnel.

import {
  Cartesian3,
  Cartographic,
  Color,
  CorridorGeometry,
  CornerType,
  GeometryInstance,
  ColorGeometryInstanceAttribute,
  Primitive,
  PerInstanceColorAppearance,
  WallGeometry,
  Transforms,
  Matrix4,
  ClippingPolygon,
  ClippingPolygonCollection,
  sampleTerrainMostDetailed,
  type Scene,
  type TerrainProvider,
} from 'cesium';
import { roadWidth, type RoadSegment } from './osm';

const TUNNEL_DEPTH = 8; // metres the tunnel floor sits below the surface
const FLOOR_COLOR = Color.fromCssColorString('#2b2b30');
const WALL_COLOR = Color.fromCssColorString('#3a3a40');

export interface TunnelResult {
  count: number;
  collection?: ClippingPolygonCollection;
  primitive?: Primitive;
}

// Offset a geodetic point (radians) by (east, north) metres; returns radians.
function offsetLonLat(lon: number, lat: number, east: number, north: number) {
  const base = Cartesian3.fromRadians(lon, lat, 0);
  const enu = Transforms.eastNorthUpToFixedFrame(base);
  const v = Matrix4.multiplyByPointAsVector(enu, new Cartesian3(east, north, 0), new Cartesian3());
  const p = Cartesian3.add(base, v, new Cartesian3());
  const c = Cartographic.fromCartesian(p);
  return { lon: c.longitude, lat: c.latitude };
}

export async function buildTunnels(
  scene: Scene,
  terrainProvider: TerrainProvider,
  roads: RoadSegment[]
): Promise<TunnelResult> {
  const tunnels = roads.filter((r) => r.tunnel && r.points.length >= 2);
  if (!tunnels.length) return { count: 0 };
  if (typeof ClippingPolygon === 'undefined' || typeof ClippingPolygonCollection === 'undefined') {
    return { count: 0 };
  }

  // Sample ground heights for every tunnel vertex.
  const cartos: Cartographic[] = [];
  for (const t of tunnels) for (const p of t.points) cartos.push(Cartographic.fromDegrees(p.lon, p.lat));
  try {
    await sampleTerrainMostDetailed(terrainProvider, cartos);
  } catch {
    /* ellipsoid / no ion — heights stay ~0 */
  }

  const clipPolygons: ClippingPolygon[] = [];
  const instances: GeometryInstance[] = [];
  let cursor = 0;

  for (const t of tunnels) {
    const n = t.points.length;
    const halfW = roadWidth(t) / 2;
    const groundH = cartos.slice(cursor, cursor + n).map((c) => c.height || 0);
    cursor += n;

    const lon = t.points.map((p) => (p.lon * Math.PI) / 180);
    const lat = t.points.map((p) => (p.lat * Math.PI) / 180);

    const leftLL: { lon: number; lat: number }[] = [];
    const rightLL: { lon: number; lat: number }[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      // tangent in local east/north (direction only)
      let dE = (lon[b] - lon[a]) * Math.cos(lat[i]);
      let dN = lat[b] - lat[a];
      const len = Math.hypot(dE, dN) || 1;
      dE /= len;
      dN /= len;
      // left perpendicular = (-dN, dE)
      leftLL.push(offsetLonLat(lon[i], lat[i], -dN * halfW, dE * halfW));
      rightLL.push(offsetLonLat(lon[i], lat[i], dN * halfW, -dE * halfW));
    }

    // (1) Clipping polygon: left edge forward, right edge back → closed ring.
    const ring: Cartesian3[] = [];
    for (let i = 0; i < n; i++) ring.push(Cartesian3.fromRadians(leftLL[i].lon, leftLL[i].lat, 0));
    for (let i = n - 1; i >= 0; i--) ring.push(Cartesian3.fromRadians(rightLL[i].lon, rightLL[i].lat, 0));
    try {
      clipPolygons.push(new ClippingPolygon({ positions: ring }));
    } catch {
      /* skip a bad ring */
    }

    const floorH = groundH.map((g) => g - TUNNEL_DEPTH);
    const avgFloor = floorH.reduce((s, h) => s + h, 0) / n;

    // (2a) Sunken road floor.
    instances.push(
      new GeometryInstance({
        geometry: new CorridorGeometry({
          positions: t.points.map((p) => Cartesian3.fromDegrees(p.lon, p.lat)),
          width: roadWidth(t),
          cornerType: CornerType.ROUNDED,
          height: avgFloor,
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(FLOOR_COLOR) },
      })
    );

    // (2b) Side walls from floor up to the ground surface.
    for (const edge of [leftLL, rightLL]) {
      const positions = edge.map((e) => Cartesian3.fromRadians(e.lon, e.lat, 0));
      instances.push(
        new GeometryInstance({
          geometry: new WallGeometry({
            positions,
            maximumHeights: groundH.slice(),
            minimumHeights: floorH.slice(),
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(WALL_COLOR) },
        })
      );
    }
  }

  // Start disabled so the default scene is untouched until the player opts in
  // with the T key (the carve is experimental and can't be visually verified here).
  let collection: ClippingPolygonCollection | undefined;
  try {
    collection = new ClippingPolygonCollection({ polygons: clipPolygons, enabled: false });
    scene.globe.clippingPolygons = collection;
  } catch (err) {
    console.warn('Tunnel clipping unavailable; interiors will be hidden by terrain.', err);
  }

  let primitive: Primitive | undefined;
  if (instances.length) {
    primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({ closed: true }),
      show: false,
    });
    scene.primitives.add(primitive);
  }

  return { count: tunnels.length, collection, primitive };
}
