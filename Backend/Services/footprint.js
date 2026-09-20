/**
 * Building footprint from OpenStreetMap/Overpass (free, no API key).
 * We find the nearest mapped building, calculate its centroid, and use a
 * minimum-area rectangle to estimate real-world width/length/heading.
 */
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const FALLBACK_SIZE_METERS = 20;

export async function getBuildingFootprint(lat, lng) {
  const query = `
    [out:json][timeout:15];
    way(around:65,${lat},${lng})["building"];
    out tags geom;
  `;

  let res;
  try {
    res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "User-Agent": "AddressTo3D-Hackathon-Demo/1.0 (local prototype)",
      },
      body: query,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.warn("Overpass footprint lookup failed; using estimated footprint:", error?.message || error);
    return estimatedFootprint(lat, lng, "fallback estimate (Overpass unavailable)");
  }

  if (!res.ok) {
    console.warn(`Overpass footprint lookup returned ${res.status}; using estimated footprint.`);
    return estimatedFootprint(lat, lng, `fallback estimate (Overpass ${res.status})`);
  }

  const data = await res.json();
  const ways = data.elements?.filter((el) => el.type === "way" && el.geometry?.length >= 3) ?? [];
  if (!ways.length) {
    return estimatedFootprint(lat, lng);
  }

  const candidates = ways.map((way) => {
    const pts = way.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
    const centroid = averagePoint(pts);
    return {
      pts,
      centroid,
      tags: way.tags || {},
      dist: haversine(lat, lng, centroid.lat, centroid.lng),
    };
  });

  const closest = candidates.sort((a, b) => a.dist - b.dist)[0];
  const local = closest.pts.map((p) =>
    toLocalMeters(p.lat, p.lng, closest.centroid.lat, closest.centroid.lng)
  );
  const hull = convexHull(local);
  const rect = minAreaRect(hull);

  let shortMeters = Math.min(rect.width, rect.height);
  let longMeters = Math.max(rect.width, rect.height);
  let headingDegrees = rect.angleDegrees;
  if (rect.height > rect.width) headingDegrees += 90;

  shortMeters = clamp(shortMeters, 2, 500);
  longMeters = clamp(longMeters, 2, 500);

  const levels = Number.parseFloat(closest.tags["building:levels"] || "");
  const explicitHeight = parseMeters(closest.tags.height);
  const heightMeters = explicitHeight || (Number.isFinite(levels) ? levels * 3.2 : 10);

  return {
    widthMeters: round(shortMeters),
    lengthMeters: round(longMeters),
    headingDegrees: round(normalizeHeading(headingDegrees)),
    heightMeters: round(clamp(heightMeters, 3, 250)),
    levels: Number.isFinite(levels) ? levels : null,
    buildingType: closest.tags.building || "building",
    center: closest.centroid,
    distanceFromGeocodeMeters: round(closest.dist),
    estimated: false,
    source: "OpenStreetMap / Overpass",
  };
}

function estimatedFootprint(lat, lng, source = "fallback estimate") {
  return {
    widthMeters: FALLBACK_SIZE_METERS,
    lengthMeters: FALLBACK_SIZE_METERS,
    headingDegrees: 0,
    heightMeters: 10,
    levels: null,
    buildingType: "building",
    center: { lat, lng },
    distanceFromGeocodeMeters: null,
    estimated: true,
    source,
  };
}

function parseMeters(value) {
  if (!value) return null;
  const m = String(value).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function round(n) { return Math.round(n * 100) / 100; }
function averagePoint(pts) {
  return {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
  };
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function toLocalMeters(lat, lng, originLat, originLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  return {
    x: toRad(lng - originLng) * R * Math.cos(toRad(originLat)),
    y: toRad(lat - originLat) * R,
  };
}
function normalizeHeading(deg) {
  let h = ((deg % 180) + 180) % 180;
  if (h < 0) h += 180;
  return h;
}
function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
function minAreaRect(points) {
  if (points.length < 2) return { width: FALLBACK_SIZE_METERS, height: FALLBACK_SIZE_METERS, angleDegrees: 0 };
  let best = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const c = Math.cos(-angle), s = Math.sin(-angle);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      const x = p.x * c - p.y * s;
      const y = p.x * s + p.y * c;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const area = (maxX - minX) * (maxY - minY);
    if (!best || area < best.area) {
      best = { area, width: maxX - minX, height: maxY - minY, angleDegrees: normalizeHeading((angle * 180) / Math.PI) };
    }
  }
  return best;
}
