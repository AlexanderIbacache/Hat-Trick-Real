import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { GENERATED_DIR } from "./Services/generatedDir.js";

import { geocodeAddress } from "./Services/geocode.js";
import { getBuildingFootprint } from "./Services/footprint.js";
import { editBuildingImage, editBuildingImages } from "./Services/imageGen.js";
import { imageToMesh, readGlbDimensions } from "./Services/meshGen.js";

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "35mb" }));
app.use("/generated", express.static(GENERATED_DIR, {
  setHeaders(res) { res.setHeader("Access-Control-Allow-Origin", "*"); }
}));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    providers: {
      maps: Boolean(process.env.GOOGLE_MAPS_DEMO_KEY),
      image: Boolean(process.env.HF_TOKEN),
      mesh: process.env.MESH_PROVIDER || "tripo",
    },
  });
});

app.get("/api/client-config", (_req, res) => {
  const googleMapsDemoKey = process.env.GOOGLE_MAPS_DEMO_KEY;
  if (!googleMapsDemoKey) {
    return res.status(503).json({ error: "GOOGLE_MAPS_DEMO_KEY is not set in Backend/.env." });
  }
  res.json({ googleMapsDemoKey });
});

app.post("/api/geocode", async (req, res) => {
  try {
    const { address } = req.body || {};
    if (!address?.trim()) return res.status(400).json({ error: "Address is required." });
    res.json(await geocodeAddress(address.trim()));
  } catch (err) { sendError(res, err); }
});

app.post("/api/footprint", async (req, res) => {
  try {
    const { lat, lng } = req.body || {};
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
      return res.status(400).json({ error: "lat and lng are required." });
    }
    res.json(await getBuildingFootprint(Number(lat), Number(lng)));
  } catch (err) { sendError(res, err); }
});

app.post("/api/edit-image", async (req, res) => {
  try {
    const { base64, mimeType, images, prompt } = req.body || {};
    if (!prompt?.trim()) return res.status(400).json({ error: "A source image and prompt are required." });
    if (Array.isArray(images)) {
      if (!images.length) return res.status(400).json({ error: "At least one reference image is required." });
      const generated = await editBuildingImages({ images, prompt });
      return res.json({ images: generated, model: generated[0]?.model, provider: generated[0]?.provider });
    }
    if (!base64) return res.status(400).json({ error: "A source image and prompt are required." });
    res.json(await editBuildingImage({ base64, mimeType, prompt }));
  } catch (err) { sendError(res, err); }
});

app.post("/api/mesh", async (req, res) => {
  try {
    const { base64, mimeType, images } = req.body || {};
    if (!base64 && !images?.length) return res.status(400).json({ error: "At least one source image is required." });
    res.json(await imageToMesh({ base64, mimeType, images }));
  } catch (err) { sendError(res, err); }
});

app.post("/api/analyze-mesh", async (req, res) => {
  try {
    const { fileName } = req.body || {};
    if (!fileName || fileName.includes("..") || fileName.includes("/")) return res.status(400).json({ error: "Invalid mesh filename." });
    res.json({ meshDimensions: await readGlbDimensions(path.join(GENERATED_DIR, fileName)) });
  } catch (err) { sendError(res, err, 404); }
});

function sendError(res, err, defaultStatus = 500) {
  console.error(err);
  res.status(defaultStatus).json({ error: err?.message || "Unexpected server error." });
}

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Address→3D backend listening on http://localhost:${port}`));
