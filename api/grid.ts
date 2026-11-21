// GET /api/grid?lat=&lon=
// Nearby power infrastructure, returned in one Overpass-like shape the app understands:
//  - transmission lines from HIFLD (US federal dataset on ArcGIS) — fast and reliable, primary source
//  - substations and smaller lines from OpenStreetMap Overpass — optional, short timeout (mirrors are often overloaded)
// Cached at Vercel's edge so repeat lookups are instant.
type El = { type: string; tags: Record<string, string | undefined>; lat?: number; lon?: number; geometry?: { lat: number; lon: number }[] };

const json = (body: unknown, status = 200, cache = true) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...(cache ? { 'cache-control': 'public, s-maxage=604800' } : {}) },
  });

const HIFLD =
  'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query';
const OVERPASS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter'];

async function hifldLines(lat: number, lon: number): Promise<El[]> {
  const dLat = 0.065; // ~7 km
  const dLon = 0.065 / Math.cos((lat * Math.PI) / 180);
  const q = new URLSearchParams({
    where: '1=1',
    geometry: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'VOLTAGE',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '400',
    f: 'json',
  });
  const r = await fetch(`${HIFLD}?${q}`, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HIFLD ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error('HIFLD error');
  const out: El[] = [];
  for (const f of j.features ?? []) {
    const v = Number(f.attributes?.VOLTAGE);
    for (const path of f.geometry?.paths ?? []) {
      out.push({
        type: 'way',
        tags: { power: 'line', voltage: v > 0 ? String(Math.round(v * 1000)) : undefined },
        geometry: (path as [number, number][]).map(([x, y]) => ({ lat: +y.toFixed(6), lon: +x.toFixed(6) })),
      });
    }
  }
  return out;
}

async function osmExtras(lat: number, lon: number): Promise<El[]> {
  const q = `[out:json][timeout:8];(way["power"="minor_line"](around:3000,${lat},${lon});node["power"="substation"](around:15000,${lat},${lon});way["power"="substation"](around:15000,${lat},${lon}););out geom qt 300;`;
  for (const ep of OVERPASS) {
    try {
      const r = await fetch(`${ep}?data=${encodeURIComponent(q)}`, {
        headers: { 'user-agent': 'SunPlot-hackathon-demo/1.0', accept: 'application/json' },
        signal: AbortSignal.timeout(7000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      return (j.elements ?? []).map((e: El) => ({
        type: e.type,
        tags: { power: e.tags?.power, voltage: e.tags?.voltage, name: e.tags?.name },
        lat: e.lat,
        lon: e.lon,
        geometry: e.geometry?.map((g) => ({ lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6) })),
      }));
    } catch {
      /* next mirror */
    }
  }
  return [];
}

export async function GET(request: Request) {
  const u = new URL(request.url);
  const lat = Number(u.searchParams.get('lat'));
  const lon = Number(u.searchParams.get('lon'));
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return json({ error: 'Bad location' }, 400, false);

  const [lines, extras] = await Promise.allSettled([hifldLines(lat, lon), osmExtras(lat, lon)]);
  const hl = lines.status === 'fulfilled' ? lines.value : [];
  const ex = extras.status === 'fulfilled' ? extras.value : [];
  if (lines.status === 'rejected' && ex.length === 0) return json({ error: 'Power-line data unavailable' }, 502, false);
  // only cache complete answers for long; partial ones (no substations) for 10 minutes
  const res = json({ elements: [...hl, ...ex], sources: { hifld: lines.status === 'fulfilled', osm: ex.length > 0 } });
  if (ex.length === 0) res.headers.set('cache-control', 'public, s-maxage=600');
  return res;
}
