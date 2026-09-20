/**
 * Google Geocoding API v4 using a Google Maps Demo Key.
 * The Demo Key is intentionally used here because this project is designed to
 * run without attaching a billing account.
 */
export async function geocodeAddress(address) {
  const key = process.env.GOOGLE_MAPS_DEMO_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_DEMO_KEY is not set in backend/.env");

  const url = new URL("https://geocode.googleapis.com/v4/geocode/address");
  url.searchParams.set("addressQuery", address);
  url.searchParams.set("key", key);

  const res = await fetch(url);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error?.message || `Google Geocoding failed: ${res.status}`);
  }

  const first = payload.results?.[0];
  const location = first?.location || first?.geometry?.location;
  if (!location || location.latitude == null || location.longitude == null) {
    throw new Error("No location was found for that address.");
  }

  return {
    lat: Number(location.latitude),
    lng: Number(location.longitude),
    placeId: first?.placeId || null,
    formattedAddress: first?.formattedAddress || first?.address?.formattedAddress || address,
    raw: first,
  };
}
