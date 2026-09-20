# FORM — Address → 3D Building

A hackathon-ready prototype that turns a real-world building into a prompt-driven 3D asset and anchors the result back onto the building's real location.

## Demo flow

```text
Area / campus ─────────────┐
                           ▼
Building address → Google Geocoding → lat/lng
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
      User photo refs              OSM footprint
             │                    width / length /
             ▼                       heading
      HF image-to-image                 │
             │                           │
             ▼                           │
       2D AI preview                    │
             │                           │
             ▼                           │
 Stable Fast 3D → .glb ──────────────────┘
                           │
                           ▼
             Google Maps 3D Maps
       scale + heading + position + clamp-to-ground
```

## The no-card architecture

The original starter was using Google Photorealistic 3D Tiles, Places photos, Street View, paid image APIs, and a paid mesh API. That does not satisfy the competition constraint.

This version changes the stack to:

| Requirement | Prototype implementation |
|---|---|
| Area / campus 3D context | **Google Maps 3D Maps** JavaScript API using a **Google Maps Demo Key** |
| Address → coordinates | **Google Geocoding API v4** with the Demo Key |
| Building photos | **User uploads 1–4 photos**. This is deliberate: the Demo Key does not expose Google user-generated photo content. |
| Prompt → 2D building preview | **Puter.js** browser AI image generation using fast FLUX models (prefers `black-forest-labs/flux-schnell`, then FLUX Pro fallback) |
| Image → 3D | **Stability AI Stable Fast 3D** public Hugging Face Space via `@gradio/client` |
| Building footprint | **OpenStreetMap / Overpass** |
| Real scale / orientation | OSM footprint minimum-area rectangle + GLB POSITION bounds |
| Ground alignment | Google 3D model `altitudeMode: CLAMP_TO_GROUND` |
| Safety net | Local parametric GLB fallback when the public mesh Space is unavailable |

Google's Demo Key documentation states that the key is intended for no-cost testing/prototyping without billing information, supports Maps JavaScript map rendering and selected web services, and does **not** expose user-generated photos such as user-submitted photos/reviews. That is why this build intentionally replaces the old “top 2 Google Maps photos” step with the user's own photo uploads.

## Setup

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
npm start
```

The backend runs at `http://localhost:3001`.

### 2. Frontend

Edit `frontend/config.js` and replace:

```js
GOOGLE_MAPS_DEMO_KEY: "YOUR_GOOGLE_MAPS_DEMO_KEY"
```

Then serve the folder with any static server:

```bash
cd frontend
npx serve .
```

No AI API key is needed in the frontend for the image step. Puter.js handles the image generation directly in-browser with a free user-authenticated model flow.

### 3. Free credentials

You need a Google Maps Demo Key for the map/geocoder. The AI image step uses Puter.js, so there is no server-side token to manage. The mesh route still relies on a public Space and can queue/sleep.

## Important competition talking points

### Why we don't scrape the “top two Google Maps photos”

A no-billing Google Maps Demo Key does not expose Google user-generated photo content. Instead of quietly violating that constraint or falling back to a paid key, the prototype asks the user for the source photos directly. This is also better for a judged demo because the presenter controls exactly which building views go into the pipeline.

### How the real-world placement works

1. Google Geocoding resolves the address to latitude/longitude.
2. Overpass returns nearby building footprints from OpenStreetMap.
3. The nearest footprint is converted into local meters.
4. A minimum-area rectangle extracts the building's short dimension, long dimension, and heading.
5. The returned GLB is parsed from its glTF `POSITION` accessor bounds so the model gets a true non-uniform scale rather than a bounding-sphere approximation.
6. The model is positioned at the OSM footprint centroid, rotated to the footprint heading, and clamped to ground in the Google 3D map.

### What is still an approximation

- A single image cannot recover the hidden sides of a building perfectly; Stable Fast 3D is still image-to-3D reconstruction, not a survey-grade scan.
- If OSM has no matching footprint, the backend uses a flagged 20 m × 20 m estimate.
- The height comes from OSM `height` or `building:levels`; otherwise a 10 m estimate is used.
- Model orientation depends on the generated GLB's local axis convention. The code compensates by mapping the model's larger horizontal axis to the footprint's long axis.
- The Google map is live context; the generated mesh is placed on top of the existing 3D scene rather than replacing Google's underlying building geometry.

## Suggested 90-second judge demo

Use a recognizable campus building with 2 good facade photos.

1. Type the campus name and let the map pull back to the area.
2. Type the exact building address and click **Locate**.
3. Drop in two facade photos.
4. Prompt something visually obvious: “Replace the facade with black metal panels and a glass curtain wall while preserving the massing and camera perspective.”
5. Show the 2D preview.
6. Click **Generate 3D mesh** and explain that the AI reconstruction runs separately from the geographic footprint lookup.
7. Click **Place on map** and zoom in. The visual punchline is that the synthetic building lands at the real address with a footprint-derived scale and heading.

## Project structure

```text
frontend/
  index.html
  app.js
  style.css
  config.js
backend/
  server.js
  .env.example
  services/
    geocode.js
    footprint.js
    imageGen.js
    meshGen.js
  generated/
```

## Sources

The current implementation follows the official Google Maps Demo Key / 3D Maps documentation and the Puter.js FLUX image-generation flow for the free, no-server image step.
