// A lightweight spatial index that tells the car what surface it's on: a bridge
// deck, a tunnel floor, or (by returning null) the plain terrain. Heights match
// what roads.ts / tunnels.ts render, so the car sits on the geometry you see.

import {
  Cartographic,
  sampleTerrainMostDetailed,
  type TerrainProvider,
} from 'cesium';
import { roadWidth, type RoadSegment } from './osm';

const LEVEL_HEIGHT = 6; // must match roads.ts
const TUNNEL_DEPTH = 8; // must match tunnels.ts
const EARTH_R = 6378137;

interface Span {
  pts: { lon: number; lat: number }[]; // radians
  halfW: number; // metres
  height: number; // absolute deck/floor height
  kind: 'bridge' | 'tunnel';
}

export interface SurfaceHit {
  height: number;
  kind: 'bridge' | 'tunnel';
}

export class SurfaceIndex {
  private spans: Span[] = [];

  add(s: Span): void {
    this.spans.push(s);
  }

  /** Bridge deck / tunnel floor height at a point, or null for plain terrain. */
  query(lonRad: number, latRad: number): SurfaceHit | null {
    // Prefer bridges (topmost) over tunnels when footprints overlap.
    for (const kind of ['bridge', 'tunnel'] as const) {
      for (const s of this.spans) {
        if (s.kind === kind && this.onSpan(lonRad, latRad, s)) {
          return { height: s.height, kind };
        }
      }
    }
    return null;
  }

  private onSpan(lon: number, lat: number, s: Span): boolean {
    const cosLat = Math.cos(lat);
    const px = lon * cosLat;
    const py = lat;
    for (let i = 0; i < s.pts.length - 1; i++) {
      const a = s.pts[i];
      const b = s.pts[i + 1];
      const ax = a.lon * cosLat;
      const ay = a.lat;
      const dx = b.lon * cosLat - ax;
      const dy = b.lat - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const dist = Math.hypot(px - cx, py - cy) * EARTH_R; // radians → metres
      if (dist <= s.halfW) return true;
    }
    return false;
  }
}

export async function buildSurfaceIndex(
  terrainProvider: TerrainProvider,
  roads: RoadSegment[]
): Promise<SurfaceIndex> {
  const index = new SurfaceIndex();
  const special = roads.filter(
    (r) => (r.bridge || r.layer > 0 || r.tunnel) && r.points.length >= 2
  );
  if (!special.length) return index;

  const cartos: Cartographic[] = [];
  for (const r of special) for (const p of r.points) cartos.push(Cartographic.fromDegrees(p.lon, p.lat));
  try {
    await sampleTerrainMostDetailed(terrainProvider, cartos);
  } catch {
    /* ellipsoid / no ion — heights stay ~0 */
  }

  let cursor = 0;
  for (const r of special) {
    const n = r.points.length;
    const gh = cartos.slice(cursor, cursor + n).map((c) => c.height || 0);
    cursor += n;
    const avg = gh.reduce((s, h) => s + h, 0) / n;
    const pts = r.points.map((p) => ({
      lon: (p.lon * Math.PI) / 180,
      lat: (p.lat * Math.PI) / 180,
    }));
    const halfW = roadWidth(r) / 2 + 1; // small margin so edges catch

    if (r.tunnel) {
      index.add({ pts, halfW, height: avg - TUNNEL_DEPTH, kind: 'tunnel' });
    } else {
      const level = r.layer > 0 ? r.layer : 1;
      index.add({ pts, halfW, height: avg + level * LEVEL_HEIGHT, kind: 'bridge' });
    }
  }
  return index;
}
