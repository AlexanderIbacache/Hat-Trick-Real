import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import crypto from "node:crypto";
import { GENERATED_DIR } from "./Services/generatedDir.js";

import { geocodeAddress } from "./Services/geocode.js";
import { getBuildingFootprint } from "./Services/footprint.js";
import { imageToMesh, readGlbDimensions } from "./Services/meshGen.js";

const app = express();
const meshJobs = new Map();

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
      image: "puter-flux",
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
    const { prompt } = req.body || {};
    if (!prompt?.trim()) return res.status(400).json({ error: "A prompt is required." });
    return res.status(410).json({
      error: "Image generation now runs in the browser via Puter.js and FLUX. The old backend image route has been removed.",
    });
  } catch (err) { sendError(res, err); }
});

app.post("/api/mesh", async (req, res) => {
  try {
    const { base64, mimeType, images } = req.body || {};
    if (!base64 && !images?.length) return res.status(400).json({ error: "At least one source image is required." });
    const jobId = crypto.randomUUID();
    const job = { status: "queued", createdAt: Date.now() };
    meshJobs.set(jobId, job);
    // Tripo can take several minutes. Keep that work off the HTTP request so
    // hosted proxies cannot terminate it before the model is downloaded.
    Promise.resolve().then(() => imageToMesh({ base64, mimeType, images }))
      .then((mesh) => Object.assign(job, { status: "completed", mesh, completedAt: Date.now() }))
      .catch((error) => Object.assign(job, { status: "failed", error: error?.message || "Mesh generation failed.", completedAt: Date.now() }));
    res.status(202).json({ jobId, status: job.status });
  } catch (err) { sendError(res, err); }
});

app.get("/api/mesh/:jobId", (req, res) => {
  const job = meshJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Mesh job was not found or has expired." });
  res.json({ status: job.status, ...(job.status === "completed" ? { mesh: job.mesh } : {}), ...(job.status === "failed" ? { error: job.error } : {}) });
  if (job.completedAt && Date.now() - job.completedAt > 30 * 60 * 1000) meshJobs.delete(req.params.jobId);
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

function startServer(startPort) {
  const port = Number(startPort || process.env.PORT || 3001);
  const server = app.listen(port, () => {
    process.env.PORT = String(port);
    console.log(`Address→3D backend listening on http://localhost:${port}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      const nextPort = port + 1;
      console.warn(`Port ${port} is busy. Retrying on ${nextPort}.`);
      startServer(nextPort);
      return;
    }

    console.error("Failed to start backend server:", err);
    process.exit(1);
  });
}

startServer(Number(process.env.PORT || 3001));
