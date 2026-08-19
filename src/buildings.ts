// Extrudes OSM building footprints into 3D blocks. This is the no-API-key path
// to a 3D city: when there's no Cesium ion / Google key we build the environment
// ourselves from OpenStreetMap footprints instead of streaming 3D tiles.

import {
  Cartesian3,
  Color,
  PolygonGeometry,
  PolygonHierarchy,
  GeometryInstance,
  ColorGeometryInstanceAttribute,
  Primitive,
  PerInstanceColorAppearance,
  type Scene,
} from 'cesium';
import type { Building } from './osm';

// Deterministic pseudo-random shade so each building reads separately but the
// city stays a coherent neutral grey (looks fine over the map imagery).
function shadeFor(seed: number): Color {
  const n = Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
  const g = 0.52 + n * 0.22;
  return new Color(g, g, g * 1.03, 1);
}

export function buildBuildings(scene: Scene, buildings: Building[]): number {
  const instances: GeometryInstance[] = [];

  buildings.forEach((b, i) => {
    if (b.points.length < 3) return;
    const positions = b.points.map((p) => Cartesian3.fromDegrees(p.lon, p.lat));
    instances.push(
      new GeometryInstance({
        geometry: new PolygonGeometry({
          polygonHierarchy: new PolygonHierarchy(positions),
          height: 0,
          extrudedHeight: b.height,
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(shadeFor(i + 1)) },
      })
    );
  });

  if (instances.length) {
    scene.primitives.add(
      new Primitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance(),
      })
    );
  }
  return instances.length;
}
