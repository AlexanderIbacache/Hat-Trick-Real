import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { GENERATED_DIR } from "./generatedDir.js";

// Keep the key server-side; it is never sent to a client.  This application
// uses Tripo's current V3 API, which is required by the V3 model identifiers.
const TRIPO_API_BASE = "https://openapi.tripo3d.ai/v3";
const TRIPO_DEFAULT_MODEL = "v3.1-20260211";
const tripoTaskCreations = new Map();

/**
 * Creates a Tripo image-to-3D model with texture and PBR maps. The API key is
 * read only by this server; it is never exposed in a browser response.
 */
export async function imageToMesh({ base64, mimeType = "image/png", images = [] }) {
  const mode = process.env.MESH_PROVIDER || "tripo";
  if (mode === "parametric") return makeFallbackMesh();
  if (mode !== "tripo") throw new Error(`Unsupported MESH_PROVIDER: ${mode}. Use "tripo" or "parametric".`);

  try {
    const apiKey = process.env.TRIPO_API_KEY || process.env.TRIPO_API_TOKEN;
    if (!apiKey || apiKey.startsWith("YOUR_")) {
      throw new Error("TRIPO_API_KEY is not set. Add your Tripo API key to Backend/.env; it is used only by the backend.");
    }
    const references = normalizeReferences({ base64, mimeType, images });
    // Preserve a task for this exact reference set. If Tripo finished but its
    // model CDN briefly fails, a button retry resumes this paid task instead
    // of uploading and charging for a new one.
    const taskCacheKey = makeTaskCacheKey(references);
    const taskId = await getOrCreateTripoTask(references, apiKey, taskCacheKey);
    const task = await waitForTripoTask(taskId, apiKey);
    // V3 returns `model_url`. Legacy fields remain as fallbacks only, since
    // some of them can be metadata rather than a directly downloadable URL.
    const modelUrl = [task.output?.model_url, task.output?.pbr_model, task.output?.model]
      .find((value) => typeof value === "string" && /^https?:\/\//i.test(value));
    if (!modelUrl) {
      throw new Error(`Tripo completed task ${taskId} without a downloadable model URL.`);
    }

    // A task can be marked successful a few seconds before its CDN artifact is
    // available. Retry the download independently; never create a second task.
    const modelResponse = await tripoFetch(modelUrl, {}, { retries: 8, timeoutMs: 60_000, retryStatuses: [404, 408, 429, 500, 502, 503, 504] });
    if (!modelResponse.ok) throw new Error(`Could not download Tripo's generated GLB (${modelResponse.status}).`);
    const glbBuffer = Buffer.from(await modelResponse.arrayBuffer());
    if (glbBuffer.toString("ascii", 0, 4) !== "glTF") throw new Error("Tripo returned a model that is not a GLB file.");

    const filename = `tripo-${crypto.randomUUID()}.glb`;
    const filePath = path.join(GENERATED_DIR, filename);
    await fs.mkdir(GENERATED_DIR, { recursive: true });
    await fs.writeFile(filePath, glbBuffer);
    return {
      glbUrl: `/generated/${filename}`,
      provider: `Tripo ${process.env.TRIPO_MODEL || TRIPO_DEFAULT_MODEL} image-to-3D`,
      taskId,
      meshDimensions: await readGlbDimensions(filePath),
      texture: { enabled: true, pbr: true, quality: process.env.TRIPO_TEXTURE_QUALITY || "detailed" },
      fallback: false,
    };
  } catch (error) {
    if (/Tripo generation (?:failed|cancelled):/i.test(error?.message || "")) {
      await removeCachedTripoTask(makeTaskCacheKey(normalizeReferences({ base64, mimeType, images }))).catch(() => {});
    }
    if (process.env.MESH_FALLBACK === "parametric") {
      console.warn("Tripo image-to-3D failed; using parametric fallback:", error.message);
      return makeFallbackMesh();
    }
    throw error;
  }
}

function makeTaskCacheKey(references) {
  const model = process.env.TRIPO_MODEL || TRIPO_DEFAULT_MODEL;
  const imageData = references.map(({ base64, mimeType }) => `${mimeType}:${base64}`).join("|");
  return crypto.createHash("sha256").update(`${model}|${imageData}`).digest("hex");
}

function cachedTaskPath(taskCacheKey) {
  return path.join(GENERATED_DIR, "tripo-tasks", `${taskCacheKey}.json`);
}

async function readCachedTripoTask(taskCacheKey) {
  try {
    const value = JSON.parse(await fs.readFile(cachedTaskPath(taskCacheKey), "utf8"));
    return typeof value?.taskId === "string" ? value.taskId : null;
  } catch {
    return null;
  }
}

async function removeCachedTripoTask(taskCacheKey) {
  await fs.unlink(cachedTaskPath(taskCacheKey));
}

async function getOrCreateTripoTask(references, apiKey, taskCacheKey) {
  const existingTaskId = await readCachedTripoTask(taskCacheKey);
  if (existingTaskId) {
    console.info(`Resuming Tripo task ${existingTaskId}; no new credits will be used.`);
    return existingTaskId;
  }

  // Protect against two clicks arriving before the task record is written.
  if (tripoTaskCreations.has(taskCacheKey)) return tripoTaskCreations.get(taskCacheKey);
  const creation = (async () => {
    const fileTokens = await Promise.all(references.map((reference, index) => uploadTripoImage({ ...reference, apiKey, index })));
    const taskId = await createTripoModelTask(fileTokens, apiKey);
    await fs.mkdir(path.dirname(cachedTaskPath(taskCacheKey)), { recursive: true });
    await fs.writeFile(cachedTaskPath(taskCacheKey), JSON.stringify({ taskId, createdAt: new Date().toISOString() }));
    return taskId;
  })();
  tripoTaskCreations.set(taskCacheKey, creation);
  try {
    return await creation;
  } finally {
    tripoTaskCreations.delete(taskCacheKey);
  }
}

function tripoHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

async function tripoFetch(url, options = {}, { retries = 2, timeoutMs = 45_000, retryStatuses = [408, 429, 500, 502, 503, 504] } = {}) {
  let lastError;
  let retryAfterSeconds;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (!retryStatuses.includes(response.status) || attempt === retries) return response;
      lastError = new Error(`Tripo returned ${response.status}`);
      retryAfterSeconds = Number(response.headers.get("retry-after"));
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
    }
    // Respect rate limiting where possible, then use a short bounded backoff.
    const delay = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 750 * (2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 8_000)));
  }
  const code = lastError?.cause?.code ? ` (${lastError.cause.code})` : "";
  throw new Error(`Could not reach Tripo at ${new URL(url).host} after ${retries + 1} attempts${code}. Check your internet connection or Tripo service status.`);
}

async function uploadTripoImage({ base64, mimeType, apiKey, index = 0 }) {
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length) throw new Error("The source image is empty.");
  if (bytes.length > 20 * 1024 * 1024) throw new Error("Tripo accepts images up to 20 MB.");
  const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType }), `reference-${index + 1}.${ext}`);
  const response = await tripoFetch(`${TRIPO_API_BASE}/files`, { method: "POST", headers: tripoHeaders(apiKey), body: form }, { retries: 3 });
  const payload = await readTripoResponse(response, "upload the image");
  const fileToken = payload.data?.file_token || payload.data?.image_token;
  if (!fileToken) throw new Error("Tripo did not return a file token for the uploaded image.");
  return fileToken;
}

async function createTripoModelTask(fileTokens, apiKey) {
  const isMultiview = fileTokens.length > 1;
  // Keep all generated images, in their UI/source-photo order. Tripo's V3
  // multiview API accepts view-keyed entries and does not require blank slots.
  const viewNames = ["front", "left", "back", "right"];
  const input = fileTokens[0];
  const inputs = isMultiview
    ? fileTokens.map((fileToken, index) => ({ [viewNames[index]]: fileToken }))
    : undefined;
  // Do not retry this POST: a connection failure after Tripo receives it could
  // otherwise create a duplicate, credit-consuming task.
  const response = await tripoFetch(`${TRIPO_API_BASE}/generation/${isMultiview ? "multiview-to-model" : "image-to-model"}`, {
    method: "POST",
    headers: { ...tripoHeaders(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(isMultiview ? { inputs } : { input }),
      model: process.env.TRIPO_MODEL || TRIPO_DEFAULT_MODEL,
      texture: true,
      pbr: true,
      texture_quality: process.env.TRIPO_TEXTURE_QUALITY || "detailed",
      texture_alignment: process.env.TRIPO_TEXTURE_ALIGNMENT || "original_image",
      orientation: "align_image",
      face_limit: Number(process.env.TRIPO_FACE_LIMIT || 50000),
      geometry_quality: process.env.TRIPO_GEOMETRY_QUALITY || "standard",
      export_uv: true,
    }),
  }, { retries: 0, timeoutMs: 60_000 });
  const payload = await readTripoResponse(response, "start image-to-3D generation");
  if (!payload.data?.task_id) throw new Error("Tripo did not return a generation task ID.");
  return payload.data.task_id;
}

async function waitForTripoTask(taskId, apiKey) {
  // Model reconstruction can take several minutes during busy periods. Keep
  // the same task alive and poll it at a modest cadence instead of failing the
  // browser request early or submitting a second token-consuming task.
  const interval = Math.max(1000, Number(process.env.TRIPO_POLL_INTERVAL_MS || 5000));
  const timeout = Math.max(interval, Number(process.env.TRIPO_TIMEOUT_MS || 900000));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let payload;
    try {
      const response = await tripoFetch(`${TRIPO_API_BASE}/tasks/${encodeURIComponent(taskId)}`, { headers: tripoHeaders(apiKey) });
      payload = await readTripoResponse(response, "check image-to-3D generation status");
    } catch (error) {
      // Tripo occasionally returns a temporary gateway response while a queued
      // job is being routed. The task remains valid, so keep polling it.
      if (!isTransientTripoError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, interval));
      continue;
    }
    const task = payload.data;
    if (task?.status === "success") return task;
    if (task?.status === "failed" || task?.status === "cancelled") {
      throw new Error(`Tripo generation ${task.status}: ${task.error_message || "no error details returned"}`);
    }
    console.info(`Tripo task ${taskId}: ${task?.status || "queued"} (${task?.progress ?? 0}%).`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Tripo generation timed out after ${Math.round(timeout / 1000)} seconds (task ${taskId}).`);
}

function isTransientTripoError(error) {
  return /\b(?:Bad Gateway|Gateway Timeout|Service Unavailable|Too Many Requests|Internal Server Error|Could not reach Tripo|408|429|500|502|503|504)\b/i.test(error?.message || "");
}

function normalizeReferences({ base64, mimeType, images }) {
  const supplied = Array.isArray(images) ? images : [];
  const references = supplied.length ? supplied : [{ base64, mimeType }];
  if (references.length > 4) throw new Error("Tripo accepts at most four ordered views: front, left, back, right.");
  if (!references.every((reference) => reference?.base64)) throw new Error("Every Tripo reference image must include image data.");
  return references.map((reference) => ({
    base64: reference.base64,
    mimeType: reference.mimeType || "image/png",
  }));
}

async function readTripoResponse(response, action) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0) {
    throw new Error(`Tripo could not ${action}: ${payload.message || payload.error?.message || response.statusText || response.status}`);
  }
  return payload;
}

async function runStableFast3D(inputPath) {
  const app = await Client.connect(SPACE_ID, {
    status_callback: (status) => {
      if (status?.status) console.log(`[${SPACE_ID}] ${status.status}: ${status.message || ""}`);
    },
  });

  // The public Space currently exposes its main action as /run_button.
  // view_api() is checked so that a future endpoint rename can be surfaced
  // cleanly in the thrown error instead of silently producing bad placement.
  const api = await app.view_api();
  const named = Object.keys(api?.named_endpoints || {});
  const endpoint = named.find((name) => /run_button/i.test(name)) || "/run_button";

  const inputFile = handle_file(inputPath);
  const removeResult = await app.predict(endpoint, [
    "Remove Background",
    inputFile,
    null,
    0.85,
    "None",
    -1,
    1024,
  ]);
  const backgroundState = removeResult?.data?.[2] ?? null;

  const meshResult = await app.predict(endpoint, [
    "Run",
    inputFile,
    backgroundState,
    0.85,
    "None",
    -1,
    1024,
  ]);

  const candidate = findGlbCandidate(meshResult?.data);
  if (!candidate) throw new Error("Stable Fast 3D returned no GLB model. The public Space may have changed its API.");
  return downloadCandidate(candidate);
}

function findGlbCandidate(value) {
  if (!value) return null;
  if (typeof value === "string" && /\.glb($|\?)/i.test(value)) return value;
  if (typeof value !== "object") return null;
  if (value.url && /\.glb($|\?)/i.test(value.url)) return value.url;
  if (value.path && /\.glb($|\?)/i.test(value.path)) return value.path;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGlbCandidate(item);
      if (found) return found;
    }
  } else {
    for (const key of Object.keys(value)) {
      const found = findGlbCandidate(value[key]);
      if (found) return found;
    }
  }
  return null;
}

async function downloadCandidate(candidate) {
  if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
    const res = await fetch(candidate);
    if (!res.ok) throw new Error(`Could not download generated GLB: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const base = `https://${SPACE_ID.replace("/", "-")}.hf.space`;
  const url = new URL(candidate, base).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download generated GLB: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function writeInputImage(base64, mimeType) {
  const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  const dir = path.join(GENERATED_DIR, "inputs");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `input-${crypto.randomUUID()}.${ext}`);
  await fs.writeFile(file, Buffer.from(base64, "base64"));
  return file;
}

export async function readGlbDimensions(filePath) {
  const buffer = await fs.readFile(filePath);
  if (buffer.toString("ascii", 0, 4) !== "glTF") throw new Error("Generated file is not a GLB.");
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.toString("utf8", 20, 20 + jsonLength));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      const positionIndex = primitive.attributes?.POSITION;
      const accessor = json.accessors?.[positionIndex];
      if (!accessor?.min || !accessor?.max) continue;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], accessor.min[i]);
        max[i] = Math.max(max[i], accessor.max[i]);
      }
    }
  }

  if (!Number.isFinite(min[0])) return { width: 1, height: 1, depth: 1 };
  return {
    width: Math.max(max[0] - min[0], 0.001),
    height: Math.max(max[1] - min[1], 0.001),
    depth: Math.max(max[2] - min[2], 0.001),
  };
}

function makeFallbackMesh() {
  const filename = `mesh-${crypto.randomUUID()}.glb`;
  const filePath = path.join(GENERATED_DIR, filename);
  const glb = makeBoxGlb();
  return fs.mkdir(GENERATED_DIR, { recursive: true })
    .then(() => fs.writeFile(filePath, glb))
    .then(() => ({
      glbUrl: `/generated/${filename}`,
      provider: "Local parametric GLB fallback",
      meshDimensions: { width: 1, height: 1, depth: 1 },
      fallback: true,
    }));
}

// Minimal self-contained GLB: a centered unit cube, Y-up, no external assets.
function makeBoxGlb() {
  const p = [
    [-0.5,0,-0.5],[0.5,0,-0.5],[0.5,1,-0.5],[-0.5,1,-0.5],
    [-0.5,0,0.5],[0.5,0,0.5],[0.5,1,0.5],[-0.5,1,0.5],
  ];
  const faces = [
    [0,1,2,3, 0,0,-1], [5,4,7,6, 0,0,1], [4,0,3,7, -1,0,0],
    [1,5,6,2, 1,0,0], [3,2,6,7, 0,1,0], [4,5,1,0, 0,-1,0],
  ];
  const positions = [], normals = [], indices = [];
  for (const [a,b,c,d,nx,ny,nz] of faces) {
    const base = positions.length / 3;
    for (const idx of [a,b,c,d]) positions.push(...p[idx]);
    for (let i=0;i<4;i++) normals.push(nx,ny,nz);
    indices.push(base,base+1,base+2, base,base+2,base+3);
  }
  const posBuf = Buffer.from(new Float32Array(positions).buffer);
  const normBuf = Buffer.from(new Float32Array(normals).buffer);
  const idxBuf = Buffer.from(new Uint16Array(indices).buffer);
  const pad = (buf) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4)]);
  const posP = pad(posBuf), normP = pad(normBuf), idxP = pad(idxBuf);
  const bin = Buffer.concat([posP,normP,idxP]);
  const json = {
    asset:{version:"2.0",generator:"AddressTo3D local fallback"},
    scene:0, scenes:[{nodes:[0]}], nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2,material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[0.72,0.72,0.76,1],metallicFactor:0.05,roughnessFactor:0.72}}],
    accessors:[
      {bufferView:0,componentType:5126,count:positions.length/3,type:"VEC3",min:[-0.5,0,-0.5],max:[0.5,1,0.5]},
      {bufferView:1,componentType:5126,count:normals.length/3,type:"VEC3"},
      {bufferView:2,componentType:5123,count:indices.length,type:"SCALAR",min:[0],max:[23]},
    ],
    bufferViews:[
      {buffer:0,byteOffset:0,byteLength:posP.length,target:34962},
      {buffer:0,byteOffset:posP.length,byteLength:normP.length,target:34962},
      {buffer:0,byteOffset:posP.length+normP.length,byteLength:idxP.length,target:34963},
    ],buffers:[{byteLength:bin.length}]
  };
  const jsonBufRaw = Buffer.from(JSON.stringify(json));
  const jsonPad = Buffer.concat([jsonBufRaw, Buffer.alloc((4-(jsonBufRaw.length%4))%4,0x20)]);
  const header = Buffer.alloc(12); header.write("glTF",0,"ascii"); header.writeUInt32LE(2,4); header.writeUInt32LE(12+8+jsonPad.length+8+bin.length,8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonPad.length,0); jh.writeUInt32LE(0x4E4F534A,4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length,0); bh.writeUInt32LE(0x004E4942,4);
  return Buffer.concat([header,jh,jsonPad,bh,bin]);
}
