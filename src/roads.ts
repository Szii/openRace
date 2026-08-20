// Turns parsed OSM road segments into 3D geometry in the Cesium scene.
//
// Normal roads are drawn as corridors draped on the terrain (GroundPrimitive),
// so they automatically follow elevation. Bridges (bridge=yes or layer>0) are
// drawn as slabs floating at their OSM layer height — this is what gives us
// roads passing over/under one another. Tunnels are skipped (underground).

import {
  Cartesian3,
  Cartographic,
  Color,
  CorridorGeometry,
  CornerType,
  GeometryInstance,
  ColorGeometryInstanceAttribute,
  GroundPrimitive,
  Primitive,
  PerInstanceColorAppearance,
  sampleTerrainMostDetailed,
  type Scene,
  type TerrainProvider,
} from 'cesium';
import { roadColorCss, roadWidth, type RoadSegment } from './osm';

const LEVEL_HEIGHT = 6; // metres of clearance per OSM layer level
const DECK_THICKNESS = 0.5; // visual thickness of a bridge deck

function color(r: RoadSegment, alpha: number): Color {
  return Color.fromCssColorString(roadColorCss(r)).withAlpha(alpha);
}

export interface BuildResult {
  total: number;
  ground: number;
  bridges: number;
  /** The draped ground-road overlay (translucent). Toggle its `.show`. */
  groundPrimitive?: GroundPrimitive;
  bridgePrimitive?: Primitive;
}

export async function buildRoads(
  scene: Scene,
  terrainProvider: TerrainProvider,
  roads: RoadSegment[]
): Promise<BuildResult> {
  const groundInstances: GeometryInstance[] = [];
  const bridges: RoadSegment[] = [];
  const bridgeSampleCartos: Cartographic[] = [];

  for (const r of roads) {
    if (r.tunnel) continue; // underground — don't draw

    const isBridge = r.bridge || r.layer > 0;
    if (isBridge) {
      bridges.push(r);
      for (const p of r.points) bridgeSampleCartos.push(Cartographic.fromDegrees(p.lon, p.lat));
      continue;
    }

    groundInstances.push(
      new GeometryInstance({
        geometry: new CorridorGeometry({
          positions: r.points.map((p) => Cartesian3.fromDegrees(p.lon, p.lat)),
          width: roadWidth(r),
          cornerType: CornerType.ROUNDED,
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(color(r, 0.55)) },
      })
    );
  }

  // Draped ground roads — one batched primitive follows the terrain. Kept
  // translucent so photorealistic imagery still reads through it.
  let groundPrimitive: GroundPrimitive | undefined;
  if (groundInstances.length) {
    groundPrimitive = new GroundPrimitive({
      geometryInstances: groundInstances,
      appearance: new PerInstanceColorAppearance({ flat: true }),
    });
    scene.primitives.add(groundPrimitive);
  }

  // Bridges need real terrain heights so the deck floats a fixed clearance above.
  let bridgeCount = 0;
  let bridgePrimitive: Primitive | undefined;
  if (bridges.length) {
    try {
      await sampleTerrainMostDetailed(terrainProvider, bridgeSampleCartos);
    } catch {
      /* ellipsoid terrain / no ion — heights stay ~0, still fine */
    }

    const bridgeInstances: GeometryInstance[] = [];
    let cursor = 0;
    for (const r of bridges) {
      const cartos = bridgeSampleCartos.slice(cursor, cursor + r.points.length);
      cursor += r.points.length;

      const avgGround =
        cartos.reduce((sum, c) => sum + (c.height || 0), 0) / cartos.length;
      const level = r.layer > 0 ? r.layer : 1;
      const deckTop = avgGround + level * LEVEL_HEIGHT;

      bridgeInstances.push(
        new GeometryInstance({
          geometry: new CorridorGeometry({
            positions: r.points.map((p) => Cartesian3.fromDegrees(p.lon, p.lat)),
            width: roadWidth(r),
            cornerType: CornerType.ROUNDED,
            height: deckTop - DECK_THICKNESS,
            extrudedHeight: deckTop,
            vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(color(r, 0.95)) },
        })
      );
      bridgeCount++;
    }

    bridgePrimitive = new Primitive({
      geometryInstances: bridgeInstances,
      appearance: new PerInstanceColorAppearance({ closed: true }),
    });
    scene.primitives.add(bridgePrimitive);
  }

  return {
    total: roads.length,
    ground: groundInstances.length,
    bridges: bridgeCount,
    groundPrimitive,
    bridgePrimitive,
  };
}
