// GET /api/grid?lat=&lon=
// Power lines (within 6 km) and substations (within 20 km) from OpenStreetMap, via Overpass.
// Proxied server-side so it is cached at the edge and does not depend on browser CORS/slow mirrors.
const json = (body: unknown, status = 200, cache = true) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(cache ? { 'cache-control': 'public, s-maxage=604800' } : {}) },
  });

const ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export async function GET(request: Request) {
  const u = new URL(request.url);
  const lat = Number(u.searchParams.get('lat'));
  const lon = Number(u.searchParams.get('lon'));
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return json({ error: 'Bad location' }, 400, false);

  const q = `[out:json][timeout:20];(way["power"~"^(line|minor_line)$"](around:6000,${lat},${lon});node["power"="substation"](around:20000,${lat},${lon});way["power"="substation"](around:20000,${lat},${lon}););out geom qt 600;`;
  for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(`${ep}?data=${encodeURIComponent(q)}`, {
        headers: { 'user-agent': 'SunPlot-hackathon-demo/1.0', accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      // keep only what the app needs
      const elements = (j.elements ?? []).map((e: { type: string; tags?: Record<string, string>; lat?: number; lon?: number; geometry?: { lat: number; lon: number }[] }) => ({
        type: e.type,
        tags: { power: e.tags?.power, voltage: e.tags?.voltage, name: e.tags?.name },
        lat: e.lat,
        lon: e.lon,
        geometry: e.geometry?.map((g) => ({ lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6) })),
      }));
      return json({ elements });
    } catch {
      /* try the next mirror */
    }
  }
  return json({ error: 'Power-line data unavailable' }, 502, false);
}
