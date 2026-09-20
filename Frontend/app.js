const CFG = window.APP_CONFIG;
const $ = (id) => document.getElementById(id);
const DEFAULT_BACKEND_PORTS = [3001, 3002, 3003, 3004, 3005];

async function resolveBackendUrl() {
  const candidates = [...new Set([
    ...DEFAULT_BACKEND_PORTS.map((port) => `http://localhost:${port}`),
    CFG.BACKEND_URL,
  ].map((url) => String(url).replace(/\/$/, "")))];

  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/api/health`, { cache: "no-store" });
      const health = await response.json().catch(() => ({}));
      if (response.ok && (health.providers?.meshTransport === "async-job-v1" || candidate === CFG.BACKEND_URL.replace(/\/$/, ""))) return candidate;
    } catch (_err) {
      // Ignore and keep trying the next candidate.
      // Ignore and keep trying the next candidate 2.
    }
  }

  return CFG.BACKEND_URL.replace(/\/$/, "");
}

let API = CFG.BACKEND_URL.replace(/\/$/, "");

const state = {
  address: null,
  lat: null,
  lng: null,
  placeId: null,
  photos: [],
  selectedPhoto: null,
  editedImageUrl: null,
  editedImageBase64: null,
  editedImageMime: null,
  editedImages: [],
  footprint: null,
  mesh: null,
  model: null,
  modelBaseScale: null,
  modelVisible: false,
};

const mapState = { map: null, marker: null, modelMarker: null, modelClass: null, markerClass: null, drag: null };

function getMapCenterLatLng() {
  const center = mapState.map?.center || CFG.DEFAULT_VIEW;
  return {
    lat: Number(typeof center.lat === "function" ? center.lat() : center.lat),
    lng: Number(typeof center.lng === "function" ? center.lng() : center.lng),
  };
}

function projectLatLngToScreen(lat, lng, surface) {
  const center = getMapCenterLatLng();
  const metersPerPixel = (Number(mapState.map.range || CFG.DEFAULT_VIEW.range) * 1.25) / Math.max(surface.clientHeight, 1);
  const dxMeters = (lng - center.lng) * 111320 * Math.max(Math.cos(center.lat * Math.PI / 180), 0.01);
  const dyMeters = (lat - center.lat) * 111320;
  return {
    x: surface.clientWidth / 2 + (dxMeters / metersPerPixel),
    y: surface.clientHeight / 2 - (dyMeters / metersPerPixel),
  };
}

function getModelScreenPoint(surface) {
  if (!state.model || !mapState.map) return null;
  const modelPosition = state.model.position || {};
  const lat = Number(modelPosition.lat ?? getMapCenterLatLng().lat);
  const lng = Number(modelPosition.lng ?? getMapCenterLatLng().lng);
  return projectLatLngToScreen(lat, lng, surface);
}

async function getApiBaseUrl() {
  const resolved = await resolveBackendUrl();
  if (resolved && resolved !== API) {
    API = resolved;
    CFG.BACKEND_URL = resolved;
    window.APP_CONFIG.BACKEND_URL = resolved;
  }
  return API;
}

function api(path, body) {
  return getApiBaseUrl().then((baseUrl) => fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).catch((err) => {
    if (err instanceof TypeError) {
      throw new Error(`Cannot reach the backend at ${API}. Start it with \"npm run dev\" from the Backend folder.`);
    }
    throw err;
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  });
}

async function getApiJson(path) {
  const baseUrl = await getApiBaseUrl();
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      return data;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && !/Failed to fetch|NetworkError|Load failed/i.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`Could not read the mesh job status from ${baseUrl}. ${lastError?.message || "Network error."}`);
}

async function createMeshAndWait(body) {
  const queued = await api("/api/mesh", body);
  if (!queued.jobId) return queued;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const result = await getApiJson(`/api/mesh/${encodeURIComponent(queued.jobId)}`);
    if (result.status === "completed") return result.mesh;
    if (result.status === "failed") throw new Error(result.error || "Mesh generation failed.");
    setStatus("mesh-status", result.status === "queued" ? "Tripo job queued…" : "Tripo is building the textured model…", "busy");
  }
}

function setStatus(id, text, kind = "") { const el = $(id); el.textContent = text; el.className = `status ${kind}`; }
function unlock(id) { const el = $(id); el.dataset.locked = "false"; el.classList.remove("active-step"); }
function activate(stepNumber) {
  for (let i=1;i<=5;i++) { const el = $(`pipeline-${i}`); if (el) el.classList.toggle("active", i === stepNumber); }
  const stepIds = ["step-address","step-photos","step-prompt","step-mesh","step-place"];
  stepIds.forEach((id, i) => $(id)?.classList.toggle("active-step", i + 1 === stepNumber));
}
function fmtMeters(n) { return `${Number(n).toFixed(1)} m`; }

async function verifyModelAsset(modelUrl) {
  let response;
  try {
    response = await fetch(modelUrl, { method: "HEAD", cache: "no-store" });
  } catch (error) {
    throw new Error(`The generated GLB cannot be reached from the browser: ${error.message}`);
  }
  if (!response.ok) throw new Error(`The generated GLB returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type") || "";
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength === 0 && /text\/html/i.test(contentType)) {
    throw new Error("The model URL returned HTML instead of a GLB file. Check the Render generated-file route.");
  }
  return { contentType, contentLength };
}

async function confirmModelAttached(model, modelUrl) {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  if (model.parentNode !== mapState.map || (model.src && new URL(model.src, modelUrl).href !== modelUrl)) {
    throw new Error(`The verified GLB was not attached to the Google 3D map: ${modelUrl}`);
  }
}

async function loadClientConfig() {
  const backendUrl = await resolveBackendUrl();
  if (backendUrl && backendUrl !== API) {
    API = backendUrl;
    CFG.BACKEND_URL = backendUrl;
    window.APP_CONFIG.BACKEND_URL = backendUrl;
  }

  const res = await fetch(`${API}/api/client-config`);
  const config = await res.json().catch(() => ({}));
  if (!res.ok || !config.googleMapsDemoKey) {
    throw new Error(config.error || "Google Maps configuration is unavailable.");
  }
  CFG.GOOGLE_MAPS_DEMO_KEY = config.googleMapsDemoKey;
}

async function initGoogle3D() {
  const key = CFG.GOOGLE_MAPS_DEMO_KEY;
  if (!key || key.includes("YOUR_")) {
    $("map-fallback").hidden = false;
    return;
  }
  try {
    await loadGoogleScript(key);
    const { Map3DElement, Marker3DElement, Model3DElement, GestureHandling } = await google.maps.importLibrary("maps3d");
    mapState.modelClass = Model3DElement;
    mapState.markerClass = Marker3DElement;
    mapState.map = new Map3DElement({
      center: { lat: CFG.DEFAULT_VIEW.lat, lng: CFG.DEFAULT_VIEW.lng, altitude: CFG.DEFAULT_VIEW.altitude },
      range: CFG.DEFAULT_VIEW.range,
      tilt: CFG.DEFAULT_VIEW.tilt,
      heading: CFG.DEFAULT_VIEW.heading,
      mode: "HYBRID",
      defaultUIHidden: false,
      // We manage the map navigation ourselves so pan, tilt, rotation, and zoom
      // are consistent across browsers and remain predictable for model placement.
      gestureHandling: GestureHandling.NONE,
    });
    const host = $("map3d");
    host.appendChild(mapState.map);
    const interactionLayer = document.createElement("div");
    interactionLayer.id = "map-interaction-layer";
    interactionLayer.setAttribute("aria-hidden", "true");
    interactionLayer.style.position = "absolute";
    interactionLayer.style.inset = "0";
    interactionLayer.style.zIndex = "5";
    interactionLayer.style.cursor = "grab";
    interactionLayer.style.touchAction = "none";
    interactionLayer.style.background = "transparent";
    host.appendChild(interactionLayer);
    enableMapPointerNavigation(interactionLayer);
    $("map-fallback").hidden = true;
    updateMapChrome(CFG.DEFAULT_VIEW.lat, CFG.DEFAULT_VIEW.lng);
  } catch (err) {
    console.error(err);
    $("map-fallback").hidden = false;
    $("map-fallback").querySelector("h3").textContent = "Google Maps unavailable";
    $("map-fallback").querySelector("p").textContent = `Google 3D Maps could not initialize: ${err.message}`;
  }
}

function loadGoogleScript(key) {
  if (typeof window.google?.maps?.importLibrary === "function") return Promise.resolve();
  if (window.__formGoogleMapsLoadPromise) return window.__formGoogleMapsLoadPromise;

  const callbackName = "__formGoogleMapsReady";
  window.__formGoogleMapsLoadPromise = new Promise((resolve, reject) => {
    const cleanup = () => {
      delete window[callbackName];
      delete window.__formGoogleMapsLoadPromise;
    };
    window[callbackName] = () => {
      cleanup();
      if (typeof window.google?.maps?.importLibrary === "function") resolve();
      else reject(new Error("Google Maps loaded without the dynamic library loader. Check that the Maps JavaScript API is enabled for this key."));
    };
    const script = document.createElement("script");
    const params = new URLSearchParams({
      key,
      v: "beta",
      loading: "async",
      libraries: "maps3d",
      callback: callbackName,
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true; script.defer = true;
    script.onerror = () => {
      cleanup();
      reject(new Error("Google Maps JavaScript API failed to load. Verify the API key and allowed referrers."));
    };
    document.head.appendChild(script);
  });
  return window.__formGoogleMapsLoadPromise;
}

function updateMapChrome(lat, lng) {
  $("map-coordinates").textContent = `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}
function showModelMapIndicator({ lat, lng, altitude, url, dims, scale, status }) {
  const indicator = $("model-map-indicator");
  if (indicator) {
    indicator.hidden = false;
    indicator.innerHTML = `<strong>3D MODEL ${status === "loaded" ? "· LOADED" : "· ANCHORED"}</strong><span>${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)} · Z ${Number(altitude).toFixed(1)} m</span><span>AI GLB ${Number(dims.width).toFixed(1)} × ${Number(dims.height).toFixed(1)} × ${Number(dims.depth).toFixed(1)} m</span><span>Map scale ${Number(scale.x).toFixed(2)} × ${Number(scale.y).toFixed(2)} × ${Number(scale.z).toFixed(2)}</span><span>${url}</span>`;
  }
}
function placeModelIndicator(lat, lng, altitude) {
  if (!mapState.map || !mapState.markerClass) return;
  if (mapState.modelMarker?.parentNode === mapState.map) mapState.map.removeChild(mapState.modelMarker);
  mapState.modelMarker = new mapState.markerClass({
    position: { lat, lng, altitude: Math.max(altitude, 0) },
    altitudeMode: "RELATIVE_TO_GROUND",
    label: "3D MODEL",
    collisionBehavior: "OPTIONAL_AND_HIDES_LOWER_PRIORITY",
  });
  mapState.map.appendChild(mapState.modelMarker);
}
function flyTo(lat, lng, options = {}) {
  if (!mapState.map) return;
  mapState.map.center = { lat, lng, altitude: options.altitude ?? 120 };
  mapState.map.range = options.range ?? 1350;
  mapState.map.tilt = options.tilt ?? 64.5;
  if (options.heading != null) mapState.map.heading = options.heading;
  updateMapChrome(lat, lng);
}

function enableMapPointerNavigation(handle = $("map3d")) {
  const surface = handle;
  if (surface.dataset.pointerNavigationEnabled) return;
  surface.dataset.pointerNavigationEnabled = "true";

  surface.addEventListener("pointerdown", (event) => {
    if (!mapState.map || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = surface.getBoundingClientRect();
    const modelPoint = getModelScreenPoint(surface);
    const nearModel = !!(
      state.model &&
      modelPoint &&
      Math.hypot(
        event.clientX - (rect.left + modelPoint.x),
        event.clientY - (rect.top + modelPoint.y)
      ) < 80
    );

    mapState.drag = {
      button: event.button,
      x: event.clientX,
      y: event.clientY,
      mode: event.button === 2 ? "rotate" : nearModel ? "model" : "map",
      modelStart: state.model ? { lat: Number(state.model.position?.lat), lng: Number(state.model.position?.lng) } : null,
    };
    surface.setPointerCapture(event.pointerId);
  }, true);

  surface.addEventListener("pointermove", (event) => {
    const drag = mapState.drag;
    if (!drag || !mapState.map) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;

    if (drag.mode === "rotate") {
      mapState.map.heading = normalizeHeading(Number(mapState.map.heading || 0) + dx * 0.35);
      mapState.map.tilt = Math.min(85, Math.max(0, Number(mapState.map.tilt || 0) - dy * 0.2));
      return;
    }

    if (drag.mode === "model" && state.model && drag.modelStart) {
      const center = getMapCenterLatLng();
      const metersPerPixel = (Number(mapState.map.range || CFG.DEFAULT_VIEW.range) * 1.25) / Math.max(surface.clientHeight, 1);
      const latDelta = (-dy * metersPerPixel) / 111320;
      const lngDelta = (dx * metersPerPixel) / (111320 * Math.max(Math.cos(center.lat * Math.PI / 180), 0.01));
      const nextLat = drag.modelStart.lat + latDelta;
      const nextLng = drag.modelStart.lng + lngDelta;
      state.model.position = { lat: nextLat, lng: nextLng, altitude: Number(state.model.position?.altitude || 0) };
      if ($("model-lat")) $("model-lat").value = Number(nextLat).toFixed(6);
      if ($("model-lng")) $("model-lng").value = Number(nextLng).toFixed(6);
      if ($("place-position")) $("place-position").textContent = `${Number(nextLat).toFixed(6)}, ${Number(nextLng).toFixed(6)}`;
      return;
    }

    panMapByPixels(dx, dy, surface);
  }, true);

  const stopDrag = (event) => {
    if (!mapState.drag) return;
    mapState.drag = null;
    if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
  };
  surface.addEventListener("pointerup", stopDrag, true);
  surface.addEventListener("pointercancel", stopDrag, true);
  surface.addEventListener("contextmenu", (event) => event.preventDefault());

  surface.addEventListener("wheel", (event) => {
    if (!mapState.map) return;
    event.preventDefault();
    event.stopPropagation();
    const multiplier = Math.exp(event.deltaY * 0.0015);
    mapState.map.range = Math.min(12000, Math.max(30, Number(mapState.map.range || CFG.DEFAULT_VIEW.range) * multiplier));
  }, { capture: true, passive: false });
}

function panMapByPixels(dx, dy, surface) {
  const map = mapState.map;
  const center = map.center || CFG.DEFAULT_VIEW;
  const lat = Number(typeof center.lat === "function" ? center.lat() : center.lat);
  const lng = Number(typeof center.lng === "function" ? center.lng() : center.lng);
  const metersPerPixel = (Number(map.range || CFG.DEFAULT_VIEW.range) * 1.25) / Math.max(surface.clientHeight, 1);
  const northMeters = dy * metersPerPixel;
  const eastMeters = -dx * metersPerPixel;
  const nextLat = lat + northMeters / 111320;
  const nextLng = lng + eastMeters / (111320 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  map.center = { lat: nextLat, lng: nextLng, altitude: Number(center.altitude || 0) };
  updateMapChrome(nextLat, nextLng);
}
function replaceAddressMarker(lat, lng) {
  if (!mapState.map || !mapState.markerClass) return;
  if (mapState.marker) mapState.map.removeChild(mapState.marker);
  mapState.marker = new mapState.markerClass({
    position: { lat, lng, altitude: 0 },
    altitudeMode: "CLAMP_TO_GROUND",
    label: "site",
    collisionBehavior: "OPTIONAL_AND_HIDES_LOWER_PRIORITY",
  });
  mapState.map.appendChild(mapState.marker);
}

// 01: exact building address
$("btn-geocode").addEventListener("click", async () => {
  const address = $("address-input").value.trim();
  if (!address) return;
  activate(1);
  setStatus("geocode-status", "Locating the building…", "busy");
  try {
    const result = await api("/api/geocode", { address });
    Object.assign(state, { address, lat: result.lat, lng: result.lng, placeId: result.placeId });
    $("geocode-readout").textContent = `${result.formattedAddress}\n${result.lat.toFixed(6)}, ${result.lng.toFixed(6)}`;
    $("map-label").textContent = "Selected building";
    flyTo(result.lat, result.lng, { altitude: 90, range: 800, tilt: 67.5 });
    replaceAddressMarker(result.lat, result.lng);
    unlock("step-photos");
    activate(2);
    setStatus("geocode-status", "Building located. Add photo references below.", "ok");
  } catch (err) { setStatus("geocode-status", err.message, "err"); }
});

// 02: multi-photo upload
const dropzone = $("dropzone");
const photoInput = $("photo-input");
dropzone.addEventListener("click", () => photoInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.style.borderColor = "rgba(255,47,47,.55)"; });
dropzone.addEventListener("dragleave", () => dropzone.style.borderColor = "");
dropzone.addEventListener("drop", (e) => { e.preventDefault(); dropzone.style.borderColor = ""; handlePhotoFiles(e.dataTransfer.files); });
photoInput.addEventListener("change", () => handlePhotoFiles(photoInput.files));

function handlePhotoFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/")).slice(0,4);
  if (!files.length) return;
  state.photos = [];
  $("photo-grid").innerHTML = "";
  Promise.all(files.map(readFile)).then((photos) => {
    state.photos = photos;
    renderPhotos();
    if (photos[0]) selectPhoto(0);
    unlock("step-prompt");
    activate(3);
    setStatus("photos-status", `${photos.length} reference photo${photos.length > 1 ? "s" : ""} loaded. Click a tile to choose the AI source.`, "ok");
  }).catch((err) => setStatus("photos-status", err.message, "err"));
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve({ name:file.name, url:dataUrl, base64:dataUrl.split(",")[1], mimeType:file.type || "image/png" });
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
function renderPhotos() {
  const grid = $("photo-grid");
  grid.innerHTML = "";
  state.photos.forEach((photo, i) => {
    const tile = document.createElement("button");
    tile.className = "photo-tile";
    tile.type = "button";
    tile.innerHTML = `<img alt="${escapeHtml(photo.name)}" src="${photo.url}"><span class="tag">${i === 0 ? "SOURCE" : "REF"} · ${i + 1}</span>`;
    tile.addEventListener("click", () => selectPhoto(i));
    grid.appendChild(tile);
  });
  markSelectedTile();
}
function selectPhoto(index) { state.selectedPhoto = state.photos[index]; markSelectedTile(); }
function markSelectedTile() { [...$("photo-grid").children].forEach((el, i) => el.classList.toggle("selected", state.photos[i] === state.selectedPhoto)); }
function escapeHtml(s) { return s.replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c])); }

function toImageRecordFromPuter(result) {
  if (!result) return null;
  const candidates = [
    result?.src,
    result?.url,
    result?.imageUrl,
    result?.image?.src,
    result?.imageUrl || result?.output,
    result?.data?.url,
    result?.image?.url,
    result?.image,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return { imageUrl: candidate, mimeType: candidate.startsWith("data:image/") ? candidate.match(/^data:(image\/[a-zA-Z0-9.+-]+);/i)?.[1] || "image/png" : "image/png" };
    }
    if (candidate instanceof HTMLImageElement && candidate.src) {
      return { imageUrl: candidate.src, mimeType: candidate.src.startsWith("data:image/") ? candidate.src.match(/^data:(image\/[a-zA-Z0-9.+-]+);/i)?.[1] || "image/png" : "image/png" };
    }
  }

  if (typeof result === "string") {
    return { imageUrl: result, mimeType: "image/png" };
  }

  return null;
}

async function callWithTimeout(fn, timeoutMs = 45_000) {
  let timer;
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Puter generation timed out after ${timeoutMs}ms.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function retryImageGeneration(generate, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await generate();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`FLUX image generation attempt ${attempt} failed; retrying.`, error);
        await wait(1_000 * (2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

function extractTextFromPuterResponse(value) {
  if (!value && value !== 0) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => extractTextFromPuterResponse(item)).filter(Boolean).join("\n");
  if (value?.text) return extractTextFromPuterResponse(value.text);
  if (value?.content) return extractTextFromPuterResponse(value.content);
  if (value?.message) return extractTextFromPuterResponse(value.message);
  if (value?.response) return extractTextFromPuterResponse(value.response);
  if (value?.choices?.length) return value.choices.map((choice) => extractTextFromPuterResponse(choice?.message || choice?.text)).filter(Boolean).join("\n");
  return "";
}

async function generatePreviewWithPuter(prompt) {
  const ai = window.puter?.ai;
  if (!ai) {
    throw new Error("Puter.js is not loaded. Please make sure the script is available before generating a preview.");
  }

  const sources = (state.photos.length ? state.photos : [state.selectedPhoto]).filter(Boolean);
  if (!sources.length) {
    throw new Error("Add at least one reference photo before generating a preview.");
  }

  const generated = [];
  for (const photo of sources) {
    const finalPrompt = [
      "Preserve the exact building geometry from this reference image.",
      "Keep the same massing, silhouette, roofline, perspective, window rhythm, and facade alignment.",
      "This is a design remix of the same building, not a different building.",
      prompt.trim(),
      "Apply the requested change only to the materials, facade treatment, and architectural expression while preserving the original structure.",
      "Do not add another tower, wing, or unrelated architectural form. Do not change the building's overall proportions.",
      "The output should look like the same structure reimagined in a new material and design language."
    ].join(" ");

    try {
      const result = await retryImageGeneration(() => callWithTimeout(() => ai.txt2img(finalPrompt, {
        model: "black-forest-labs/flux-2-klein-4b",
        input_image: photo.url,
        input_image_mime_type: photo.mimeType || "image/png",
        output_quality: 50,
        output_megapixels: "0.5",
        response_format: "webp",
      }), 45_000));

      const record = toImageRecordFromPuter(result);
      if (record) generated.push(record);
    } catch (err) {
      console.warn("Image-to-image generation for one reference image failed:", err);
    }
  }

  if (!generated.length) {
    throw new Error("Puter did not return a generated image for the reference structure.");
  }

  return generated;
}

function resolveImageUrl(url) {
  if (!url) return "";
  return /^data:|^blob:|^https?:\/\//i.test(url) ? url : `${API}${url}`;
}

$("btn-edit").addEventListener("click", async () => {
  const prompt = $("prompt-input").value.trim();
  if (!state.selectedPhoto || !prompt) return;
  setStatus("edit-status", "Sending each reference image individually to Puter + FLUX…", "busy");
  try {
    const result = await generatePreviewWithPuter(prompt);
    state.editedImages = Array.isArray(result) ? result : [result];
    if (!state.editedImages.length) throw new Error("The image model did not return a generated view.");
    selectGeneratedImage(0);
    renderGeneratedImages();
    $("preview-frame").style.display = "block";
    setStatus("edit-status", "Preview ready · Puter / FLUX", "ok");
    unlock("step-mesh");
    activate(4);
  } catch (err) { setStatus("edit-status", err.message, "err"); }
});

function selectGeneratedImage(index) {
  const image = state.editedImages[index];
  if (!image) return;
  state.editedImageUrl = image.imageUrl;
  state.editedImageMime = image.mimeType;
  renderGeneratedImages();
}

function renderGeneratedImages() {
  const grid = $("generated-grid");
  grid.innerHTML = "";
  state.editedImages.forEach((image, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.label = `VIEW ${index + 1}`;
    button.classList.toggle("selected", image.imageUrl === state.editedImageUrl);
    const preview = document.createElement("img");
    preview.src = resolveImageUrl(image.imageUrl);
    preview.alt = `AI generated building view ${index + 1}`;
    button.appendChild(preview);
    button.addEventListener("click", () => selectGeneratedImage(index));
    grid.appendChild(button);
  });
}

// 04: mesh + footprint in parallel
$("btn-mesh").addEventListener("click", async () => {
  if (!state.editedImageUrl) return;
  setStatus("mesh-status", "Reconstructing 3D + reading the real footprint…", "busy");
  try {
    // Every successful FLUX output is a Tripo reference. Preserve the same
    // order as the uploaded source images: front, left, back, right.
    const generatedReferences = await Promise.all(state.editedImages.map(async (image) => {
      const imageBase64 = await urlToBase64(resolveImageUrl(image.imageUrl));
      return { base64: imageBase64.base64, mimeType: imageBase64.mimeType };
    }));
    const [mesh, footprint] = await Promise.all([
      createMeshAndWait({
        base64: generatedReferences[0].base64,
        mimeType: generatedReferences[0].mimeType,
        images: generatedReferences,
      }),
      api("/api/footprint", { lat:state.lat, lng:state.lng }),
    ]);
    if (!mesh || !footprint) throw new Error("Mesh or building-footprint data was not returned.");
    state.mesh = mesh; state.footprint = footprint;
    const preview = $("mesh-preview");
    preview.src = `${API}${mesh.glbUrl}`;
    preview.hidden = false;
    $("mesh-readout").textContent = mesh.fallback ? "Local fallback" : "Tripo textured PBR";
    $("footprint-readout").textContent = `${footprint.widthMeters}×${footprint.lengthMeters} m`;
    setStatus("mesh-status", mesh.fallback ? "Mesh fallback ready; place it with the real footprint." : "Textured PBR 3D model ready. Placement will use its true GLB bounds + OSM footprint.", "ok");
    unlock("step-place");
    activate(5);
    // The placement inputs are already known, so render the completed model
    // immediately in the map below instead of making the user click twice.
    if (mapState.map && mapState.modelClass) {
      $("btn-place").click();
    } else {
      setStatus("place-status", "Model is ready. The map is still loading; use Place on map when it is available.", "busy");
    }
  } catch (err) { setStatus("mesh-status", err.message, "err"); }
});

// 05: place generated GLB at footprint centroid, ground-aligned and non-uniformly scaled.
$("btn-place").addEventListener("click", async () => {
  if (!state.mesh || !state.footprint || !mapState.map || !mapState.modelClass) {
    setStatus("place-status", "Map/model system is not ready yet.", "err"); return;
  }
  setStatus("place-status", "Fitting the mesh to the real building footprint…", "busy");
  try {
    const isFirstPlacement = !state.model;
    const fp = state.footprint;
    const dims = state.mesh.meshDimensions || { width:1, height:1, depth:1 };

    // GLB is treated as Y-up. Map long footprint axis to the model's largest horizontal axis.
    let scaleX, scaleY, scaleZ, heading = Number(fp.headingDegrees || 0);
    const meshLongAxisIsX = Number(dims.width) >= Number(dims.depth);
    if (meshLongAxisIsX) {
      scaleX = Number(fp.lengthMeters) / Number(dims.width);
      scaleZ = Number(fp.widthMeters) / Number(dims.depth);
    } else {
      scaleX = Number(fp.widthMeters) / Number(dims.width);
      scaleZ = Number(fp.lengthMeters) / Number(dims.depth);
      heading -= 90;
    }
    scaleY = Number(fp.heightMeters || 10) / Number(dims.height || 1);
    const modelScale = {
      x: clampFiniteScale(scaleX),
      y: clampFiniteScale(scaleY),
      z: clampFiniteScale(scaleZ),
    };

    const center = fp.center || { lat:state.lat, lng:state.lng };
    $("model-lat").value = Number(center.lat).toFixed(6);
    $("model-lng").value = Number(center.lng).toFixed(6);
    $("model-altitude").value = "0";
    $("model-heading").value = normalizeHeading(heading).toFixed(1);
    $("model-tilt").value = "0";
    $("model-roll").value = "0";
    $("model-scale").value = "1";
    const modelUrl = new URL(state.mesh.glbUrl, `${API}/`).href;
    setStatus("place-status", "Checking the generated GLB before adding it to Google Maps…", "busy");
    const asset = await verifyModelAsset(modelUrl);
    placeModelIndicator(Number(center.lat), Number(center.lng), 0);
    showModelMapIndicator({ lat:center.lat, lng:center.lng, altitude:0, url:modelUrl, dims, scale:modelScale, status:"anchored" });
    const model = new mapState.modelClass({
      src: modelUrl,
      position: { lat:Number(center.lat), lng:Number(center.lng), altitude:0 },
      orientation: { heading:normalizeHeading(heading), tilt:0, roll:0 },
      scale: modelScale,
      altitudeMode: "RELATIVE_TO_GROUND",
    });
    if (state.model?.parentNode === mapState.map) mapState.map.removeChild(state.model);
    mapState.map.appendChild(model);
    state.model = model; state.modelBaseScale = modelScale; state.modelVisible = true;

    if (isFirstPlacement) flyTo(Number(center.lat), Number(center.lng), { altitude:100, range:260, tilt:68, heading:normalizeHeading(heading) });
    setStatus("place-status", `GLB verified (${asset.contentType || "binary"}). Attached to Google Maps…`, "busy");
    await confirmModelAttached(model, modelUrl);
    showModelMapIndicator({ lat:center.lat, lng:center.lng, altitude:0, url:modelUrl, dims, scale:modelScale, status:"loaded" });
    $("place-position").textContent = `${Number(center.lat).toFixed(6)}, ${Number(center.lng).toFixed(6)}`;
    $("place-orientation").textContent = `${normalizeHeading(heading).toFixed(1)}° heading`;
    $("place-scale").textContent = `${scaleX.toFixed(2)} × ${scaleY.toFixed(2)} × ${scaleZ.toFixed(2)}`;
    $("download-mesh").href = `${API}${state.mesh.glbUrl}`; $("download-mesh").hidden = false;
    setStatus("place-status", `Confirmed attached to Google Maps · ${fmtMeters(fp.widthMeters)} × ${fmtMeters(fp.lengthMeters)} · ground aligned.`, "ok");
  } catch (err) { setStatus("place-status", err.message, "err"); console.error(err); }
});

$("btn-update-model").addEventListener("click", () => {
  if (!state.model) return;
  const lat = Number($("model-lat").value);
  const lng = Number($("model-lng").value);
  const altitude = Number($("model-altitude").value);
  const heading = Number($("model-heading").value);
  const tilt = Number($("model-tilt").value);
  const roll = Number($("model-roll").value);
  const size = Number($("model-scale").value);
  if (![lat, lng, altitude, heading, tilt, roll, size].every(Number.isFinite) || size <= 0) {
    setStatus("place-status", "Enter valid placement values. Size must be greater than zero.", "err");
    return;
  }
  const currentScale = state.modelBaseScale || state.model.scale || { x:1, y:1, z:1 };
  state.model.position = { lat, lng, altitude };
  state.model.orientation = { heading: normalizeHeading(heading), tilt, roll };
  const updatedScale = { x:clampFiniteScale(Number(currentScale.x) * size), y:clampFiniteScale(Number(currentScale.y) * size), z:clampFiniteScale(Number(currentScale.z) * size) };
  state.model.scale = updatedScale;
  placeModelIndicator(lat, lng, altitude);
  showModelMapIndicator({ lat, lng, altitude, url:state.mesh.glbUrl, dims:state.mesh.meshDimensions || { width:1, height:1, depth:1 }, scale:updatedScale, status:"loaded" });
  $("place-position").textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}, Z ${altitude.toFixed(1)} m`;
  $("place-orientation").textContent = `${normalizeHeading(heading).toFixed(1)}° heading · ${tilt.toFixed(1)}° tilt · ${roll.toFixed(1)}° roll`;
  $("place-scale").textContent = `${updatedScale.x.toFixed(2)} × ${updatedScale.y.toFixed(2)} × ${updatedScale.z.toFixed(2)}`;
  setStatus("place-status", "Model placement updated.", "ok");
});

$("btn-place-cube").addEventListener("click", async () => {
  if (!state.footprint || !mapState.map || !mapState.modelClass) {
    setStatus("place-status", "Generate the model and wait for Google Maps before placing the test cube.", "err");
    return;
  }
  setStatus("place-status", "Creating a diagnostic cube GLB on the backend…", "busy");
  try {
    const cube = await getApiJson("/api/fallback-cube");
    state.mesh = cube;
    $("btn-place").click();
  } catch (error) {
    setStatus("place-status", `Diagnostic cube failed: ${error.message}`, "err");
  }
});

$("btn-toggle").addEventListener("click", () => {
  if (!state.model) return;
  state.modelVisible = !state.modelVisible;
  state.model.style.display = state.modelVisible ? "" : "none";
  $("btn-toggle").textContent = state.modelVisible ? "Hide model" : "Show model";
});

async function urlToBase64(url) {
  if (url.startsWith("data:")) {
    const match = /^data:(image\/[^;]+);base64,(.+)$/i.exec(url);
    if (match) {
      return { base64: match[2], mimeType: match[1] || "image/png" };
    }
    return { base64: url.split(",")[1], mimeType: "image/png" };
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not read generated preview (${res.status}).`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onloadend = () => {
      const dataUrl = String(reader.result); resolve({ base64:dataUrl.split(",")[1], mimeType:blob.type || "image/png" });
    }; reader.onerror = reject; reader.readAsDataURL(blob);
  });
}
function normalizeHeading(deg) { return ((Number(deg) % 360) + 360) % 360; }
function clampFiniteScale(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(1000, Math.max(0.001, numeric)) : 1;
}

async function bootstrap() {
  try {
    await loadClientConfig();
    await initGoogle3D();
  } catch (err) {
    console.error(err);
    $("map-fallback").hidden = false;
    $("map-fallback").querySelector("h3").textContent = "Google Maps unavailable";
    $("map-fallback").querySelector("p").textContent = err.message;
  }
}

bootstrap();
