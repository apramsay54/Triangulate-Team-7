// GET /api/pvwatts?lat=&lon=&kw=&tilt=&array=0|1
// Annual and monthly AC output from NREL PVWatts v8 (the US national lab's solar model).
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=86400' },
  });

export async function GET(request: Request) {
  const u = new URL(request.url);
  const lat = Number(u.searchParams.get('lat'));
  const lon = Number(u.searchParams.get('lon'));
  const kw = Number(u.searchParams.get('kw'));
  const tilt = Number(u.searchParams.get('tilt') ?? 25);
  const array = u.searchParams.get('array') === '1' ? '1' : '0';
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: 'Bad location' }, 400);
  if (!isFinite(kw) || kw < 0.05 || kw > 500000) return json({ error: 'System size must be 0.05–500,000 kW' }, 400);
  if (!isFinite(tilt) || tilt < 0 || tilt > 90) return json({ error: 'Tilt must be 0–90°' }, 400);

  const key = process.env.NREL_API_KEY || 'DEMO_KEY';
  const q = new URLSearchParams({
    api_key: key, lat: String(lat), lon: String(lon), system_capacity: String(kw),
    azimuth: '180', tilt: String(tilt), array_type: array, module_type: '0', losses: '14', timeframe: 'monthly',
  });
  // NREL's API moved to developer.nlr.gov; keep the old host as a fallback.
  for (const host of ['developer.nlr.gov', 'developer.nrel.gov']) {
    try {
      const r = await fetch(`https://${host}/api/pvwatts/v8.json?${q}`);
      const j = await r.json();
      if (r.ok && !(j.errors?.length) && j.outputs) {
        return json({
          acAnnual: j.outputs.ac_annual,
          acMonthly: j.outputs.ac_monthly,
          solradAnnual: j.outputs.solrad_annual,
          station: j.station_info?.city || j.station_info?.location || null,
        });
      }
      if (j.errors?.length) return json({ error: j.errors.join('; ') }, 502);
    } catch {
      /* try next host */
    }
  }
  return json({ error: 'Solar model unavailable' }, 502);
}
