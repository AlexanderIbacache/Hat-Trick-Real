const CFG = window.APP_CONFIG;
const $ = (id) => document.getElementById(id);
const DEFAULT_BACKEND_PORTS = [3001, 3002, 3003, 3004, 3005];

async function resolveBackendUrl() {
  const candidates = [...new Set([
    CFG.BACKEND_URL,
    ...DEFAULT_BACKEND_PORTS.map((port) => `http://localhost:${port}`),
  ].map((url) => String(url).replace(/\/$/, "")))];

  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/api/health`, { cache: "no-store" });
      if (response.ok) return candidate;
    } catch (_err) {
      // Ignore and keep trying the next candidate.
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
  modelVisible: false,
};

const mapState = { map: null, marker: null, modelClass: null, markerClass: null, drag: null };

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

function setStatus(id, text, kind = "") { const el = $(id); el.textContent = text; el.className = `status ${kind}`; }
function unlock(id) { const el = $(id); el.dataset.locked = "false"; el.classList.remove("active-step"); }
function activate(stepNumber) {
  for (let i=1;i<=5;i++) { const el = $(`pipeline-${i}`); if (el) el.classList.toggle("active", i === stepNumber); }
  const stepIds = ["step-address","step-photos","step-prompt","step-mesh","step-place"];
  stepIds.forEach((id, i) => $(id)?.classList.toggle("active-step", i + 1 === stepNumber));
}
function fmtMeters(n) { return `${Number(n).toFixed(1)} m`; }

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
      // The page-level controller below provides consistent mouse and trackpad
      // navigation across versions of the beta 3D Maps component.
      gestureHandling: GestureHandling.NONE,
    });
    $("map3d").appendChild(mapState.map);
    enableMapPointerNavigation();
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
function flyTo(lat, lng, options = {}) {
  if (!mapState.map) return;
  mapState.map.center = { lat, lng, altitude: options.altitude ?? 120 };
  mapState.map.range = options.range ?? 1350;
  mapState.map.tilt = options.tilt ?? 64.5;
  if (options.heading != null) mapState.map.heading = options.heading;
  updateMapChrome(lat, lng);
}

function enableMapPointerNavigation() {
  const surface = $("map3d");
  if (surface.dataset.pointerNavigationEnabled) return;
  surface.dataset.pointerNavigationEnabled = "true";

  surface.addEventListener("pointerdown", (event) => {
    if (!mapState.map || (event.button !== 0 && event.button !== 2)) return;
    event.preventDefault();
    event.stopPropagation();
    mapState.drag = { button: event.button, x: event.clientX, y: event.clientY };
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

    if (drag.button === 2) {
      mapState.map.heading = normalizeHeading(Number(mapState.map.heading || 0) + dx * 0.35);
      mapState.map.tilt = Math.min(85, Math.max(0, Number(mapState.map.tilt || 0) - dy * 0.2));
    } else {
      panMapByPixels(dx, dy, surface);
    }
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
    // Horizontal two-finger trackpad movement pans; wheel and pinch zoom.
    if (Math.abs(event.deltaX) > 0.5) {
      panMapByPixels(-event.deltaX, -event.deltaY, surface);
      return;
    }
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
  const northMeters = -dy * metersPerPixel;
  const eastMeters = -dx * metersPerPixel;
  const nextLat = lat + northMeters / 111320;
  const nextLng = lng + eastMeters / (111320 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  map.center = { lat: nextLat, lng: nextLng, altitude: Number(center.altitude || 0) };
  updateMapChrome(nextLat, nextLng);
}
function changeMapZoom(multiplier) {
  if (!mapState.map) return;
  mapState.map.range = Math.min(12000, Math.max(30, Number(mapState.map.range || CFG.DEFAULT_VIEW.range) * multiplier));
}
$("btn-zoom-in").addEventListener("click", () => changeMapZoom(0.72));
$("btn-zoom-out").addEventListener("click", () => changeMapZoom(1.38));
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

async function callWithTimeout(fn, timeoutMs = 15000) {
  let timer;
  return Promise.race([
    Promise.resolve().then(fn),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Puter generation timed out after ${timeoutMs}ms.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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
      const result = await callWithTimeout(() => ai.txt2img(finalPrompt, {
        model: "black-forest-labs/flux-2-klein-4b",
        input_image: photo.url,
        input_image_mime_type: photo.mimeType || "image/png",
        output_quality: 50,
        output_megapixels: "0.5",
        response_format: "webp",
      }), 18000);

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
    const imageBase64 = await urlToBase64(resolveImageUrl(state.editedImageUrl));
    const [mesh, footprint] = await Promise.all([
      api("/api/mesh", { base64:imageBase64.base64, mimeType:imageBase64.mimeType }),
      api("/api/footprint", { lat:state.lat, lng:state.lng }),
    ]);
    if (!mesh || !footprint) throw new Error("Mesh or building-footprint data was not returned.");
    state.mesh = mesh; state.footprint = footprint;
    $("mesh-readout").textContent = mesh.fallback ? "Local fallback" : "Tripo textured PBR";
    $("footprint-readout").textContent = `${footprint.widthMeters}×${footprint.lengthMeters} m`;
    setStatus("mesh-status", mesh.fallback ? "Mesh fallback ready; place it with the real footprint." : "Textured PBR 3D model ready. Placement will use its true GLB bounds + OSM footprint.", "ok");
    unlock("step-place");
    activate(5);
  } catch (err) { setStatus("mesh-status", err.message, "err"); }
});

// 05: place generated GLB at footprint centroid, ground-aligned and non-uniformly scaled.
$("btn-place").addEventListener("click", async () => {
  if (!state.mesh || !state.footprint || !mapState.map || !mapState.modelClass) {
    setStatus("place-status", "Map/model system is not ready yet.", "err"); return;
  }
  setStatus("place-status", "Fitting the mesh to the real building footprint…", "busy");
  try {
    if (state.model) mapState.map.removeChild(state.model);
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

    const center = fp.center || { lat:state.lat, lng:state.lng };
    const model = new mapState.modelClass({
      src: `${API}${state.mesh.glbUrl}`,
      position: { lat:Number(center.lat), lng:Number(center.lng), altitude:0 },
      orientation: { heading:normalizeHeading(heading), tilt:0, roll:0 },
      scale: { x:scaleX, y:scaleY, z:scaleZ },
      altitudeMode: "CLAMP_TO_GROUND",
    });
    mapState.map.appendChild(model);
    state.model = model; state.modelVisible = true;

    flyTo(Number(center.lat), Number(center.lng), { altitude:100, range:260, tilt:74.5, heading:normalizeHeading(heading) });
    $("btn-toggle").disabled = false; $("btn-toggle").textContent = "Hide model";
    $("place-position").textContent = `${Number(center.lat).toFixed(6)}, ${Number(center.lng).toFixed(6)}`;
    $("place-orientation").textContent = `${normalizeHeading(heading).toFixed(1)}° heading`;
    $("place-scale").textContent = `${scaleX.toFixed(2)} × ${scaleY.toFixed(2)} × ${scaleZ.toFixed(2)}`;
    $("download-mesh").href = `${API}${state.mesh.glbUrl}`; $("download-mesh").hidden = false;
    setStatus("place-status", `Placed at footprint centroid · ${fmtMeters(fp.widthMeters)} × ${fmtMeters(fp.lengthMeters)} · ground aligned.`, "ok");
  } catch (err) { setStatus("place-status", err.message, "err"); console.error(err); }
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
