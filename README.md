# openRace 🏎️

Drive a car in **3D through real, existing streets** in your browser — the world is
built from **OpenStreetMap** data (streets + 3D buildings) with optional
**Google Photorealistic 3D Tiles** ("Google Earth" imagery).

Built with [Vite](https://vitejs.dev/), [TypeScript](https://www.typescriptlang.org/)
and [CesiumJS](https://cesium.com/platform/cesiumjs/).

## Controls

| Key            | Action                 |
| -------------- | ---------------------- |
| `W` / `↑`      | Accelerate             |
| `S` / `↓`      | Brake / reverse        |
| `A` `D` / `← →`| Steer                  |
| `R`            | Reset to start         |
| `C`            | Toggle free camera     |

## Quick start

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173). It works with **no
setup** — with no keys it falls back to raw OpenStreetMap street tiles on flat ground.

## Getting the good visuals (real terrain + 3D buildings)

The polished, Google-Earth-like world uses **Cesium ion's free tier** (satellite
imagery, world terrain, and textured **OSM 3D Buildings** worldwide). It's free and
needs **no billing**:

1. Create a free account at https://ion.cesium.com
2. Copy an access token from **Access Tokens**.
3. `cp .env.example .env` and set `VITE_CESIUM_ION_TOKEN=...`
4. Restart `npm run dev`.

### Optional: Google Photorealistic 3D Tiles

For true photogrammetry ("Google Earth") data, enable Google's **Map Tiles API**
(this one is **paid** and requires billing), then set `VITE_GOOGLE_MAPS_API_KEY` in
`.env`.

## How it works

- `src/main.ts` sets up the Cesium scene, loads terrain/imagery/buildings, spawns the
  car (a glTF model in `public/models/car.glb`), and runs the driving loop.
- The car is moved along its heading in a local East-North-Up frame each frame and
  clamped to the ground height so it hugs the terrain.
- A chase camera follows from behind via `camera.lookAtTransform`.

## Roadmap

- [x] glTF car model.
- [ ] Snap the car to the OSM road network (query road geometry) for on-rails driving.
- [ ] Collision against 3D buildings.
- [ ] Location search / spawn anywhere.
- [ ] Multiplayer.

## Credits

Vehicle model: **CesiumMilkTruck** from the
[Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
(royalty-free).

## Security note

Never commit tokens or private keys. `.env`, `*.key`, `*.pem` and `id_*` are already
git-ignored. Share only **public** SSH keys (`.pub`) — never private ones.
