import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  type LatLng, areaM2, centroid, distToPolylineM, layoutPanels, selfIntersects, toLocal, toLatLng, M2_PER_ACRE, M_PER_MILE,
} from './geo';

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYTIME_USE = 0.4; // share of a typical site's use that happens while panels are producing
const BATTERY_EFF = 0.9; // round-trip efficiency for energy shifted through the battery
const HEAT_HALF_M = 4000; // heat map covers 8 km x 8 km around the plot
const HEAT_N = 32; // cells per side
import { type Mode, type FinInputs, type FinResult, runFinance, compact, YEARS } from './finance';

const START: LatLng = [35.7847, -78.6821]; // NC State campus
const PANEL_W = 1.134; // m, typical 72-cell / 580 W module
const PANEL_L = 2.278;
const PANEL_KW = 0.58; // kW DC per module
const HOUSEHOLD_KWH = 10_500; // average US home, kWh per year (EIA)
const CO2_T_PER_MWH = 0.37; // US grid average, t CO2 per MWh (EPA eGRID, approx.)

type SiteType = 'ground' | 'roof';
const SITE_DEFAULTS: Record<SiteType, { tilt: number; gcr: number; setback: number; costPerW: number; om: number; array: 0 | 1 }> = {
  ground: { tilt: 25, gcr: 0.45, setback: 6, costPerW: 1.25, om: 16, array: 0 },
  roof: { tilt: 10, gcr: 0.7, setback: 1.5, costPerW: 1.9, om: 18, array: 1 },
};

interface Grid {
  nearestLineMi: number | null;
  nearestLineKv: string;
  nearestSubMi: number | null;
  nearestSubName: string;
  lineCount: number;
}
interface AiResult {
  siteType: string;
  landCover: { type: string; percentOfPlot: number }[];
  usablePercent: number;
  recommendedCoveragePercent: number;
  obstructions: string[];
  concerns: string[];
  confidence: 'high' | 'medium' | 'low';
  imageQuality: string;
  summary: string;
  imageUrl: string;
}
type AiState = { status: 'idle' | 'loading' | 'off' | 'error'; msg?: string } | { status: 'done'; data: AiResult };
type ProdVal = { annual: number; monthly: number[]; station: string | null };
type Prod = { status: 'idle' | 'loading' } | ({ status: 'done' } & ProdVal) | { status: 'error'; msg: string };

const MODES: { id: Mode; title: string; blurb: string }[] = [
  { id: 'grid', title: 'Sell to the grid', blurb: 'Connect to the nearest power line and sell every kWh to Duke Energy as a small power producer.' },
  { id: 'onsite', title: 'Use it on site', blurb: 'Power your own buildings; surplus is credited at the export rate.' },
  { id: 'battery', title: 'Store it yourself', blurb: 'Add batteries and use most of it yourself; no new power line.' },
  { id: 'lease', title: 'Lease to an investor', blurb: '$0 upfront. An investor funds and owns the panels and pays you rent. NC-legal: a lease, not a power sale.' },
];

function clampNum(v: string, min: number, max: number, fallback: number) {
  if (v.trim() === '') return fallback;
  const n = Number(v);
  return isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function Field(props: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; suffix?: string; prefix?: string }) {
  const { label, value, onChange, step = 1, min = 0, max = 1e9, suffix, prefix } = props;
  return (
    <label className="field">
      <span>{label}</span>
      <div className="field-input">
        {prefix && <em>{prefix}</em>}
        <input type="number" defaultValue={value} key={value} step={step} min={min} max={max}
          onBlur={(e) => onChange(clampNum(e.target.value, min, max, value))}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        {suffix && <em>{suffix}</em>}
      </div>
    </label>
  );
}

const fmtDist = (mi: number) => (mi < 0.1 ? `${Math.round(mi * 5280)} ft` : `${mi.toFixed(2)} mi`);
const fmtKv = (kv: string) => {
  const v = Number(kv.split(';')[0]);
  return isFinite(v) && v > 0 ? `${Math.round(v / 1000)} kV` : '';
};

export default function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<{ plot: L.LayerGroup; handles: L.LayerGroup; panels: L.LayerGroup; grid: L.LayerGroup; heat: L.LayerGroup; canvas: L.Canvas } | null>(null);
  const gridGeo = useRef<{ c: LatLng; lines: LatLng[][] } | null>(null);
  const [usage, setUsage] = useState(0); // kWh per month, 0 = not entered
  const [showHeat, setShowHeat] = useState(false);
  const drawingRef = useRef(false);

  const [points, setPoints] = useState<LatLng[]>([]);
  const [view, setView] = useState<'landing' | 'app'>('landing');
  const [scenarioNote, setScenarioNote] = useState('');
  const [drawing, setDrawing] = useState(false);
  const [siteType, setSiteType] = useState<SiteType>('ground');
  const [coverage, setCoverage] = useState(85); // leaves room for access lanes, inverters and fencing
  const [tilt, setTilt] = useState(SITE_DEFAULTS.ground.tilt);
  const [gcr, setGcr] = useState(SITE_DEFAULTS.ground.gcr);
  const [setback, setSetback] = useState(SITE_DEFAULTS.ground.setback);
  const [query, setQuery] = useState('');
  const [searchMsg, setSearchMsg] = useState('');
  const [grid, setGrid] = useState<Grid | null>(null);
  const [gridStatus, setGridStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [ai, setAi] = useState<AiState>({ status: 'idle' });
  const [prod, setProd] = useState<Prod>({ status: 'idle' });
  const prodCache = useRef(new Map<string, ProdVal>());
  const [mode, setMode] = useState<Mode>('grid');
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [fin, setFin] = useState({
    costPerW: SITE_DEFAULTS.ground.costPerW, ppaRate: 0.05, retailRate: 0.13, exportRate: 0.04, selfUseShare: 0.5,
    batteryHours: 2, batteryCostPerKwh: 400, batterySelfUseShare: 0.9, incentivePct: 0, omPerKwYr: SITE_DEFAULTS.ground.om,
    escalation: 0.02, discount: 0.06, degradation: 0.005, leaseRatePerAcre: 900, lineCostPerMile: 250_000, interconnectPerKw: 120,
  });
  const setF = (k: keyof typeof fin) => (n: number) => setFin((f) => ({ ...f, [k]: n }));

  // ---------- map setup ----------
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = L.map(mapEl.current, { zoomControl: false, doubleClickZoom: false }).setView(START, 17);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    }).addTo(map);
    const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 21, maxNativeZoom: 19, opacity: 0.9,
    }).addTo(map);
    const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' });
    const canvas = L.canvas({ padding: 0.3 });
    const heat = L.layerGroup().addTo(map);
    const grid = L.layerGroup().addTo(map);
    const panels = L.layerGroup().addTo(map);
    const plot = L.layerGroup().addTo(map);
    const handles = L.layerGroup().addTo(map);
    L.control.layers({ Satellite: sat, Streets: streets }, { Labels: labels, 'Power lines': grid, Panels: panels }, { position: 'topright' }).addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (drawingRef.current) setPoints((p) => [...p, [e.latlng.lat, e.latlng.lng]]);
    });
    layers.current = { plot, handles, panels, grid, heat, canvas };
    mapRef.current = map;
  }, []);

  useEffect(() => {
    drawingRef.current = drawing;
    mapEl.current?.classList.toggle('drawing', drawing);
  }, [drawing]);

  // ---------- plot outline + draggable border handles ----------
  useEffect(() => {
    const ly = layers.current;
    if (!ly) return;
    ly.plot.clearLayers();
    ly.handles.clearLayers();
    if (!points.length) return;
    const shape = (drawing || points.length < 3
      ? L.polyline(points, { color: '#fbbf24', weight: 3, dashArray: '6 6' })
      : L.polygon(points, { color: '#fbbf24', weight: 3, fillOpacity: 0.06 })) as unknown as L.Polyline;
    shape.addTo(ly.plot);

    const vIcon = L.divIcon({ className: 'vertex', iconSize: [16, 16] });
    const mIcon = L.divIcon({ className: 'midpoint', iconSize: [12, 12] });
    points.forEach((p, i) => {
      const mk = L.marker(p, { icon: vIcon, draggable: true, title: 'Drag to move · double-click to delete' }).addTo(ly.handles);
      mk.on('drag', () => {
        const ll = mk.getLatLng();
        shape.setLatLngs(points.map((q, j): LatLng => (j === i ? [ll.lat, ll.lng] : q)));
      });
      mk.on('dragend', () => {
        const ll = mk.getLatLng();
        setPoints((ps) => ps.map((q, j) => (j === i ? [ll.lat, ll.lng] : q)));
      });
      mk.on('dblclick', (e) => {
        L.DomEvent.stop(e);
        setPoints((ps) => (ps.length > 3 ? ps.filter((_, j) => j !== i) : ps));
      });
    });
    if (!drawing && points.length >= 3) {
      points.forEach((p, i) => {
        const q = points[(i + 1) % points.length];
        const mk = L.marker([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], { icon: mIcon, draggable: true, title: 'Drag to add a corner' }).addTo(ly.handles);
        mk.on('dragend', () => {
          const ll = mk.getLatLng();
          setPoints((ps) => [...ps.slice(0, i + 1), [ll.lat, ll.lng], ...ps.slice(i + 1)]);
        });
      });
    }
  }, [points, drawing]);

  // ---------- panel layout ----------
  const closed = !drawing && points.length >= 3;
  const badShape = closed && selfIntersects(points);
  const areaM = closed ? areaM2(points) : 0;
  const acres = areaM / M2_PER_ACRE;
  const layout = useMemo(
    () => (closed && !badShape
      ? layoutPanels(points, { panelWidthM: PANEL_W, panelLengthM: PANEL_L, tiltDeg: tilt, groundCoverageRatio: gcr, setbackM: setback, coverage: coverage / 100 })
      : { maxPanels: 0, panelCount: 0, runs: [], tooLarge: false }),
    [points, closed, badShape, tilt, gcr, setback, coverage],
  );
  const kw = layout.panelCount * PANEL_KW;
  const center = useMemo(() => (closed ? centroid(points) : null), [closed, points]);

  useEffect(() => {
    const ly = layers.current;
    if (!ly) return;
    ly.panels.clearLayers();
    for (const r of layout.runs) {
      L.polygon(r, { renderer: ly.canvas, color: '#93c5fd', weight: 0.6, fillColor: '#1e3a8a', fillOpacity: 0.85, interactive: false }).addTo(ly.panels);
    }
  }, [layout]);

  // ---------- solar production (NREL PVWatts via our API) ----------
  const arrayType = SITE_DEFAULTS[siteType].array;
  useEffect(() => {
    if (!center || kw < 0.05) { setProd({ status: 'idle' }); return; }
    const key = `${center[0].toFixed(3)},${center[1].toFixed(3)},${kw.toFixed(1)},${tilt},${arrayType}`;
    const hit = prodCache.current.get(key);
    if (hit) { setProd({ status: 'done', ...hit }); return; }
    setProd({ status: 'loading' });
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/pvwatts?lat=${center[0]}&lon=${center[1]}&kw=${kw.toFixed(2)}&tilt=${tilt}&array=${arrayType}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        const station = typeof j.station === 'string' && /[a-z]/i.test(j.station) ? j.station : null;
        const v = { annual: j.acAnnual, monthly: j.acMonthly, station };
        prodCache.current.set(key, v);
        setProd({ status: 'done', ...v });
      } catch (e) {
        setProd({ status: 'error', msg: (e as Error).message });
      }
    }, 700);
    return () => clearTimeout(t);
  }, [center, kw, tilt, arrayType]);

  // ---------- grid connection (OpenStreetMap power lines & substations) ----------
  useEffect(() => {
    const ly = layers.current;
    if (!ly) return;
    if (!closed || badShape) { gridGeo.current = null; setGrid(null); ly.grid.clearLayers(); return; }
    const c = centroid(points);
    setGridStatus('loading');
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      // rounded to ~100 m so nearby plots share the server's cached answer
      const sources = [`/api/grid?lat=${c[0].toFixed(3)}&lon=${c[1].toFixed(3)}`];
      for (const ep of sources) {
        try {
          const r = await fetch(ep, { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(40000)]) });
          if (!r.ok) continue;
          const j = await r.json();
          type El = { type: string; tags?: Record<string, string>; lat?: number; lon?: number; geometry?: { lat: number; lon: number }[] };
          const lines: { coords: LatLng[]; kv: string; minor: boolean }[] = [];
          const subs: { pos: LatLng; name: string }[] = [];
          for (const el of j.elements as El[]) {
            const tags = el.tags ?? {};
            if (tags.power === 'substation') {
              const pos: LatLng | null = el.type === 'node' && el.lat != null && el.lon != null
                ? [el.lat, el.lon]
                : el.geometry?.length ? centroid(el.geometry.map((g) => [g.lat, g.lon] as LatLng)) : null;
              if (pos) subs.push({ pos, name: tags.name || 'Substation' });
            } else if (el.geometry?.length) {
              lines.push({ coords: el.geometry.map((g) => [g.lat, g.lon] as LatLng), kv: tags.voltage || '', minor: tags.power === 'minor_line' });
            }
          }
          const probes = [c, ...points];
          let nearestLineM = Infinity, nearestLineKv = '';
          for (const ln of lines) {
            const d = Math.min(...probes.map((p) => distToPolylineM(p, ln.coords)));
            if (d < nearestLineM) { nearestLineM = d; nearestLineKv = ln.kv; }
          }
          let nearestSubM = Infinity, nearestSubName = '';
          for (const s of subs) {
            const d = distToPolylineM(c, [s.pos]);
            if (d < nearestSubM) { nearestSubM = d; nearestSubName = s.name; }
          }
          ly.grid.clearLayers();
          for (const ln of lines) {
            L.polyline(ln.coords, { color: ln.minor ? '#fdba74' : '#f97316', weight: ln.minor ? 2 : 3.5, opacity: 0.9 })
              .bindTooltip(fmtKv(ln.kv) ? `${fmtKv(ln.kv)} power line` : 'Power line').addTo(ly.grid);
          }
          for (const s of subs) {
            L.circleMarker(s.pos, { radius: 7, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }).bindTooltip(s.name).addTo(ly.grid);
          }
          gridGeo.current = { c, lines: lines.map((l) => l.coords) };
          setGrid({
            nearestLineMi: isFinite(nearestLineM) ? nearestLineM / M_PER_MILE : null, nearestLineKv,
            nearestSubMi: isFinite(nearestSubM) ? nearestSubM / M_PER_MILE : null, nearestSubName, lineCount: lines.length,
          });
          setGridStatus('idle');
          return;
        } catch {
          if (ctl.signal.aborted) return; // plot changed; a newer lookup is running
          // otherwise this server timed out or failed: try the next one
        }
      }
      setGridStatus('error');
    }, 900);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [points, closed, badShape]);

  // ---------- AI site analysis ----------
  async function analyze() {
    if (!closed) return;
    setAi({ status: 'loading' });
    try {
      const r = await fetch('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ polygon: points }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j.error === 'AI_NOT_CONFIGURED') return setAi({ status: 'off' });
      if (!r.ok) return setAi({ status: 'error', msg: j.error || `Request failed (${r.status})` });
      setAi({ status: 'done', data: j });
    } catch {
      setAi({ status: 'error', msg: 'Network error, try again.' });
    }
  }

  // ---------- search ----------
  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return setSearchMsg('Those coordinates are out of range.');
      mapRef.current?.flyTo([lat, lng], 18); setSearchMsg(''); return;
    }
    setSearchMsg('Searching…');
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      if (!j.length) return setSearchMsg('No match. Try a full address or "lat, lng".');
      mapRef.current?.flyTo([Number(j[0].lat), Number(j[0].lon)], 18);
      setSearchMsg('');
    } catch {
      setSearchMsg('Search unavailable. Pan the map instead.');
    }
  }

  function changeSite(s: SiteType) {
    setSiteType(s);
    const d = SITE_DEFAULTS[s];
    setTilt(d.tilt); setGcr(d.gcr); setSetback(d.setback);
    setFin((f) => ({ ...f, costPerW: d.costPerW, omPerKwYr: d.om }));
    if (s === 'roof' && mode === 'lease') setMode('onsite');
  }
  function startDraw() { setPoints([]); setDrawing(true); setAi({ status: 'idle' }); setScenarioNote(''); }

  function showApp(after?: (map: L.Map) => void) {
    setView('app');
    window.scrollTo(0, 0);
    setTimeout(() => {
      const map = mapRef.current;
      if (!map) return;
      map.invalidateSize();
      after?.(map);
    }, 60);
  }
  function startScenario(s: Scenario) {
    changeSite(s.site);
    setDrawing(false);
    setAi({ status: 'idle' });
    const rect: LatLng[] = [
      toLatLng(s.center, [-s.w / 2, -s.h / 2]), toLatLng(s.center, [s.w / 2, -s.h / 2]),
      toLatLng(s.center, [s.w / 2, s.h / 2]), toLatLng(s.center, [-s.w / 2, s.h / 2]),
    ];
    setPoints(rect);
    setScenarioNote(`Example outline near ${s.place}. Drag the corners onto the actual ${s.site === 'ground' ? 'field' : 'roof'}, or search your own address.`);
    showApp((map) => map.setView(s.center, s.zoom));
  }
  function finishDraw() { if (points.length >= 3) { setDrawing(false); setAi({ status: 'idle' }); } }

  // ---------- finance ----------
  const annualKwh = prod.status === 'done' ? prod.annual : 0;
  const ready = closed && kw > 0 && annualKwh > 0;

  // How much of the solar output the owner uses themselves vs. sells back, from their monthly use.
  const usageCalc = useMemo(() => {
    if (prod.status !== 'done' || usage <= 0 || prod.annual <= 0) return null;
    const battKwh = kw * fin.batteryHours;
    let direct = 0, withBatt = 0, covered = 0;
    prod.monthly.forEach((p, i) => {
      const d = Math.min(p, usage * DAYTIME_USE); // used the moment it's produced
      const shiftable = Math.min(p, usage) - d; // could be used later in the day with storage
      const shifted = Math.min(shiftable, battKwh * DAYS[i]) * BATTERY_EFF;
      direct += d;
      withBatt += d + shifted;
      covered += Math.min(p, usage);
    });
    return {
      selfShare: direct / prod.annual,
      battShare: withBatt / prod.annual,
      coverPct: covered / (usage * 12),
      exportKwh: prod.annual - direct,
      exportKwhBatt: prod.annual - withBatt / BATTERY_EFF,
    };
  }, [prod, usage, kw, fin.batteryHours]);
  const results = useMemo(() => {
    if (!ready) return null;
    const make = (m: Mode): FinInputs => ({
      mode: m, kw, annualKwh, acres,
      costPerW: fin.costPerW, ppaRate: fin.ppaRate, retailRate: fin.retailRate, exportRate: fin.exportRate,
      selfUseShare: usageCalc ? usageCalc.selfShare : fin.selfUseShare,
      batteryKwh: kw * fin.batteryHours, batteryCostPerKwh: fin.batteryCostPerKwh,
      batterySelfUseShare: usageCalc ? usageCalc.battShare : fin.batterySelfUseShare,
      incentivePct: fin.incentivePct / 100, omPerKwYr: fin.omPerKwYr, escalation: fin.escalation, discount: fin.discount, degradation: fin.degradation,
      leaseRatePerAcre: fin.leaseRatePerAcre, gridDistanceMi: grid?.nearestLineMi ?? null, lineCostPerMile: fin.lineCostPerMile,
      interconnectFixed: 10_000 + kw * fin.interconnectPerKw,
    });
    return Object.fromEntries(MODES.map((m) => [m.id, runFinance(make(m.id))])) as Record<Mode, FinResult>;
  }, [ready, kw, annualKwh, acres, fin, grid, usageCalc]);

  // Grid-sale profit across the surrounding area. Same system and sunlight as the plot;
  // what changes cell to cell is the distance to the nearest mapped power line.
  const heat = useMemo(() => {
    if (!showHeat || !results || !grid || !gridGeo.current) return null;
    const { c, lines } = gridGeo.current;
    const npv0 = results.grid.npv + (grid.nearestLineMi ?? 0) * fin.lineCostPerMile; // NPV right next to a line
    const breakEvenMi = npv0 <= 0 ? 0 : fin.lineCostPerMile > 0 ? npv0 / fin.lineCostPerMile : Infinity;
    const segs = lines.map((l) => l.map((p) => toLocal(c, p)));
    const step = (2 * HEAT_HALF_M) / HEAT_N;
    const cells: { b: [LatLng, LatLng]; npv: number; mi: number }[] = [];
    for (let iy = 0; iy < HEAT_N; iy++) {
      for (let ix = 0; ix < HEAT_N; ix++) {
        const x = -HEAT_HALF_M + (ix + 0.5) * step;
        const y = -HEAT_HALF_M + (iy + 0.5) * step;
        let best = Infinity;
        for (const s of segs) {
          for (let k = 0; k < s.length - 1; k++) {
            const [ax, ay] = s[k], [bx, by] = s[k + 1];
            const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
            const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
            if (d < best) best = d;
          }
        }
        const mi = best / M_PER_MILE;
        cells.push({
          b: [toLatLng(c, [x - step / 2, y - step / 2]), toLatLng(c, [x + step / 2, y + step / 2])],
          npv: npv0 - mi * fin.lineCostPerMile,
          mi,
        });
      }
    }
    // NPV is linear in the sale price: NPV(p) = A·p − costs, so the break-even price at each cell is p0 − NPV/A.
    let A = 0;
    for (let t = 1; t <= YEARS; t++) {
      A += (annualKwh * Math.pow(1 - fin.degradation, t - 1) * Math.pow(1 + fin.escalation, t - 1)) / Math.pow(1 + fin.discount, t);
    }
    const priceAt = (npv: number) => (A > 0 ? fin.ppaRate - npv / A : Infinity);
    const prices = cells.map((x) => priceAt(x.npv)).filter(isFinite).sort((a, b) => a - b);
    // colour scale for losing cells: from the cheapest break-even price (or today's price) up to the 95th percentile
    const rampLo = Math.max(fin.ppaRate, prices[0] ?? fin.ppaRate);
    const rampHi = Math.max(rampLo + 0.002, prices[Math.floor(prices.length * 0.95)] ?? rampLo);
    const profitableShare = cells.filter((x) => x.npv > 0).length / cells.length;
    return {
      cells: cells.map((x) => ({ ...x, price: priceAt(x.npv) })),
      npv0, breakEvenMi, rampLo, rampHi, profitableShare, noLines: lines.length === 0,
      priceAtLine: priceAt(npv0), priceAt1Mi: priceAt(npv0 - fin.lineCostPerMile),
    };
  }, [showHeat, results, grid, fin.lineCostPerMile, fin.ppaRate, fin.degradation, fin.escalation, fin.discount, annualKwh]);

  useEffect(() => {
    const ly = layers.current;
    if (!ly) return;
    ly.heat.clearLayers();
    if (!heat) return;
    for (const cell of heat.cells) {
      // green = profitable at today's sale price; otherwise yellow (almost there) → red (needs a much higher price)
      let color = 'hsl(0, 85%, 48%)';
      if (isFinite(cell.price)) {
        if (cell.price <= fin.ppaRate) color = 'hsl(140, 75%, 42%)';
        else {
          const t = Math.min(1, (cell.price - heat.rampLo) / (heat.rampHi - heat.rampLo));
          color = `hsl(${Math.round(52 * (1 - t))}, 90%, 50%)`;
        }
      }
      L.rectangle(cell.b, { renderer: ly.canvas, stroke: false, interactive: false, fillColor: color, fillOpacity: 0.5 }).addTo(ly.heat);
    }
  }, [heat, fin.ppaRate]);

  function toggleHeat() {
    const next = !showHeat;
    setShowHeat(next);
    const map = mapRef.current;
    if (next && map && center) {
      const lo = toLatLng(center, [-HEAT_HALF_M, -HEAT_HALF_M]);
      const hi = toLatLng(center, [HEAT_HALF_M, HEAT_HALF_M]);
      map.flyToBounds([lo, hi], { duration: 0.8 });
      if (layers.current && !map.hasLayer(layers.current.heat)) layers.current.heat.addTo(map);
    }
  }
  const res = results?.[mode];
  const best = results
    ? (Object.entries(results) as [Mode, FinResult][]).filter(([m]) => siteType === 'ground' || m !== 'lease').sort((a, b) => b[1].npv - a[1].npv)[0][0]
    : null;

  const gc = center ?? START;
  const gearth = `https://earth.google.com/web/@${gc[0]},${gc[1]},120a,700d,35y,0h,45t,0r`;

  return (
    <>
    {view === 'landing' && <Landing onScenario={startScenario} onStart={() => showApp()} />}
    <div className={`app ${view === 'landing' ? 'hidden' : ''}`}>
      <section className="map-wrap">
        <div ref={mapEl} className="map" />
        <form className="search" onSubmit={search}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search an address, farm, or 'lat, lng'" aria-label="Search location" />
          <button type="submit">Go</button>
          {searchMsg && <span className="search-msg">{searchMsg}</span>}
        </form>
        <div className="map-tools">
          {!drawing ? (
            <button className="primary" onClick={startDraw}>{points.length ? 'Redraw plot' : 'Draw your plot'}</button>
          ) : (
            <>
              <span className="hint">Click the map to place corners ({points.length})</span>
              <button onClick={() => setPoints((p) => p.slice(0, -1))} disabled={!points.length}>Undo</button>
              <button className="primary" onClick={finishDraw} disabled={points.length < 3}>Finish</button>
              <button onClick={() => { setDrawing(false); setPoints([]); }}>Cancel</button>
            </>
          )}
          {closed && <span className="hint subtle">Drag corners to adjust · drag small dots to add corners · double-click a corner to delete</span>}
        </div>
        {heat && (
          <div className="legend">
            <b>Where selling to the grid pays</b>
            <div className="legend-scale">
              <span className="pos">Profitable</span>
              <i />
              <span className="neg">Needs a higher price</span>
            </div>
            <div className="legend-ticks">
              <span>≤ {(fin.ppaRate * 100).toFixed(1)}¢</span>
              <span>{(heat.rampLo * 100).toFixed(1)}¢</span>
              <span>{(heat.rampHi * 100).toFixed(1)}¢+</span>
            </div>
            <p className="muted" style={{ marginTop: 2 }}>Colour = sale price per kWh needed to break even over {YEARS} years.</p>
            {heat.noLines
              ? <p>No power lines are mapped within ~4 mi, so grid sale here needs a long new line.</p>
              : heat.breakEvenMi <= 0
                ? <p>At {(fin.ppaRate * 100).toFixed(1)}¢/kWh this system loses money everywhere. It breaks even at <b>{(heat.priceAtLine * 100).toFixed(1)}¢</b> next to a power line, <b>{(heat.priceAt1Mi * 100).toFixed(1)}¢</b> 1 mi away.</p>
                : <p>At {(fin.ppaRate * 100).toFixed(1)}¢/kWh this system pays off within <b>{heat.breakEvenMi === Infinity ? 'any distance' : fmtDist(heat.breakEvenMi)}</b> of a power line ({Math.round(heat.profitableShare * 100)}% of this area).</p>}
            <p className="muted">Darker = further from break-even. Same system and sunlight as your plot; only the distance to the nearest mapped line changes. Ignores line capacity and land use.</p>
            <button className="link" onClick={toggleHeat}>Hide heat map</button>
          </div>
        )}
      </section>

      <aside className="panel">
        <header className="brand">
          <button className="wordmark" onClick={() => setView('landing')} title="Back to home"><span className="sunmark" />SunPlot</button>
          <p>Trace a field or roof. See the panels, the power, and the deal.</p>
        </header>
        {scenarioNote && closed && <p className="note">{scenarioNote}</p>}

        {!closed && (
          <div className="card empty">
            <h2>Start here</h2>
            <ol>
              <li>Search a place or pan the satellite map.</li>
              <li>Click <b>Draw your plot</b>, then click each corner of the field or roof.</li>
              <li>Click <b>Finish</b>, then drag corners to fine-tune the borders.</li>
            </ol>
          </div>
        )}

        {closed && (
          <>
            <div className="card">
              <div className="card-head"><h2>1 · Plot & panels</h2>
                <a className="link" href={gearth} target="_blank" rel="noreferrer">View in Google Earth ↗</a></div>
              {badShape && <p className="warn">The outline crosses itself. Drag a corner so the edges don't cross.</p>}
              {layout.tooLarge && <p className="warn">That plot is over ~1,000 acres. Outline a smaller area.</p>}
              <div className="seg">
                {(['ground', 'roof'] as SiteType[]).map((s) => (
                  <button key={s} className={siteType === s ? 'on' : ''} onClick={() => changeSite(s)}>{s === 'ground' ? 'Field (ground-mount)' : 'Flat roof'}</button>
                ))}
              </div>
              <div className="stats">
                <div><b>{acres < 10 ? acres.toFixed(2) : acres.toFixed(1)}</b><span>acres · {Math.round(areaM).toLocaleString()} m²</span></div>
                <div><b>{layout.panelCount.toLocaleString()}</b><span>of {layout.maxPanels.toLocaleString()} panels that fit</span></div>
                <div><b>{kw >= 1000 ? (kw / 1000).toFixed(2) + ' MW' : kw.toFixed(1) + ' kW'}</b><span>system size (DC)</span></div>
              </div>
              {!badShape && !layout.tooLarge && layout.maxPanels === 0 && <p className="warn">No full row of panels fits. Make the plot larger or reduce the edge setback.</p>}
              <label className="slider">
                <span>Solar coverage: <b>{coverage}%</b> of the space that fits panels <em className="muted">(the rest is left for access lanes and equipment)</em></span>
                <input type="range" min={0} max={100} value={coverage} onChange={(e) => setCoverage(Number(e.target.value))} />
              </label>
              <div className="grid3">
                <Field label="Panel tilt" value={tilt} onChange={setTilt} min={0} max={60} suffix="°" />
                <Field label="Row density (GCR)" value={gcr} onChange={setGcr} step={0.05} min={0.2} max={0.95} />
                <Field label="Edge setback" value={setback} onChange={setSetback} step={0.5} min={0} max={50} suffix="m" />
              </div>
            </div>

            <div className="card ai">
              <div className="card-head"><h2>2 · AI site check</h2>
                <button className="primary" onClick={analyze} disabled={ai.status === 'loading' || badShape}>{ai.status === 'loading' ? 'Reading imagery…' : ai.status === 'done' ? 'Re-run' : 'Analyze with AI'}</button></div>
              <p className="muted">The AI studies the current satellite image of your outline and flags trees, buildings, water, roads and roof equipment that would block panels.</p>
              {ai.status === 'off' && <p className="warn">AI is not connected yet (no API key on the server). Everything else on this page is live; set coverage by hand for now.</p>}
              {ai.status === 'error' && <p className="warn">{ai.msg}</p>}
              {ai.status === 'done' && (
                <div className="ai-out">
                  <div className="ai-top">
                    <img src={ai.data.imageUrl} alt="Satellite image the AI analyzed" />
                    <div>
                      <span className={`badge ${ai.data.confidence}`}>{ai.data.confidence} confidence</span>
                      <p className="ai-sum">{ai.data.summary}</p>
                      <p><b>{Math.round(ai.data.usablePercent)}%</b> of the plot looks usable · suggests <b>{Math.round(ai.data.recommendedCoveragePercent)}%</b> coverage</p>
                      <button onClick={() => setCoverage(Math.round(ai.data.recommendedCoveragePercent))}>Apply AI coverage</button>
                    </div>
                  </div>
                  {ai.data.landCover.length > 0 && (
                    <div className="bars">{ai.data.landCover.map((c, i) => (
                      <div key={i} className="bar"><span>{c.type}</span><div><i style={{ width: `${Math.max(0, Math.min(100, c.percentOfPlot))}%` }} /></div><em>{Math.round(c.percentOfPlot)}%</em></div>
                    ))}</div>
                  )}
                  {ai.data.obstructions.length > 0 && <p><b>Obstructions:</b> {ai.data.obstructions.join(' · ')}</p>}
                  {ai.data.concerns.length > 0 && <p><b>Watch out for:</b> {ai.data.concerns.join(' · ')}</p>}
                  {ai.data.imageQuality && <p className="muted">Image note: {ai.data.imageQuality}</p>}
                  <p className="muted small">AI can misread shadows, old imagery or crop rows. Check its findings against what you know about the land.</p>
                </div>
              )}
            </div>

            <div className="card">
              <h2>3 · Energy</h2>
              <div className="usage">
                <Field label="Your electricity use (from your power bill)" value={usage} onChange={setUsage} step={100} min={0} max={50_000_000} suffix="kWh / month" />
                {usageCalc ? (
                  <p>Solar covers <b>{Math.round(Math.min(1, usageCalc.coverPct) * 100)}%</b> of your yearly use. You'd use <b>{Math.round(usageCalc.selfShare * 100)}%</b> of the output yourself and sell back <b>{Math.round(usageCalc.exportKwh).toLocaleString()} kWh/yr</b> ({Math.round(usageCalc.battShare * 100)}% used yourself with batteries).</p>
                ) : (
                  <p className="muted small">Enter your monthly use to see how much solar you'd use yourself and how much you'd sell back to the grid. Leave at 0 to use the default shares.</p>
                )}
              </div>
              {prod.status === 'loading' && <p className="muted">Running NREL's PVWatts solar model for this exact location…</p>}
              {prod.status === 'error' && <p className="warn">Solar model unavailable ({prod.msg}). Try again in a minute.</p>}
              {prod.status === 'idle' && <p className="muted">Place some panels to estimate output.</p>}
              {prod.status === 'done' && (
                <>
                  <div className="stats">
                    <div><b>{prod.annual >= 1e6 ? `${(prod.annual / 1e6).toFixed(1)} GWh` : prod.annual >= 1e4 ? `${Math.round(prod.annual / 1000).toLocaleString()} MWh` : `${Math.round(prod.annual).toLocaleString()} kWh`}</b><span>per year</span></div>
                    <div><b>{(prod.annual / HOUSEHOLD_KWH).toLocaleString(undefined, { maximumFractionDigits: prod.annual < HOUSEHOLD_KWH * 10 ? 1 : 0 })}</b><span>homes' worth of power</span></div>
                    <div><b>{((prod.annual / 1000) * CO2_T_PER_MWH).toLocaleString(undefined, { maximumFractionDigits: 0 })} t</b><span>CO₂ avoided / yr</span></div>
                  </div>
                  <div className="months">{prod.monthly.map((v, i) => {
                    const top = Math.max(...prod.monthly, usage);
                    return (
                      <div key={i} title={`Solar ${Math.round(v).toLocaleString()} kWh${usage ? ` · use ${usage.toLocaleString()} kWh` : ''}`}>
                        <div className="mbars">
                          <i style={{ height: `${(v / top) * 100}%` }} />
                          {usage > 0 && <i className="use" style={{ height: `${(usage / top) * 100}%` }} />}
                        </div>
                        <span>{'JFMAMJJASOND'[i]}</span>
                      </div>
                    );
                  })}</div>
                  {usage > 0 && <p className="muted small"><span className="key sun" /> solar output <span className="key use" /> your use</p>}
                  <p className="muted small">NREL PVWatts v8{prod.station ? `, weather station: ${prod.station}` : ''}. South-facing, {tilt}° tilt, 14% system losses.</p>
                </>
              )}
            </div>

            <div className="card">
              <h2>4 · Grid or storage</h2>
              {gridStatus === 'loading' && <p className="muted">Finding nearby power lines and substations…</p>}
              {gridStatus === 'error' && <p className="warn">Power-line data unavailable right now; the grid option assumes no new line.</p>}
              {grid && gridStatus === 'idle' && (
                <p>Nearest power line: <b>{grid.nearestLineMi === null ? 'none within ~4 mi' : fmtDist(grid.nearestLineMi)}</b>
                  {fmtKv(grid.nearestLineKv) && ` (${fmtKv(grid.nearestLineKv)})`} · Nearest substation: <b>{grid.nearestSubMi === null ? 'none within ~12 mi' : `${grid.nearestSubMi.toFixed(1)} mi`}</b>
                  {grid.nearestSubMi !== null && grid.nearestSubName !== 'Substation' && <> ({grid.nearestSubName})</>}
                  <span className="muted small"> · orange lines on the map, from HIFLD + OpenStreetMap (may be incomplete)</span></p>
              )}
              <button className="heat-btn" onClick={toggleHeat} disabled={!results || !grid}>
                {showHeat ? 'Hide grid-profit heat map'
                  : gridStatus === 'loading' ? 'Heat map: loading power lines…'
                  : !results ? 'Heat map: waiting for the energy estimate…'
                  : gridStatus === 'error' ? 'Heat map unavailable (no power-line data)'
                  : 'Show where selling to the grid is profitable'}
              </button>
              <div className="modes">
                {MODES.filter((m) => siteType === 'ground' || m.id !== 'lease').map((m) => (
                  <button key={m.id} className={`mode ${mode === m.id ? 'on' : ''}`} onClick={() => setMode(m.id)}>
                    <b>{m.title}{best === m.id && <span className="best">Best value</span>}</b>
                    <span>{m.blurb}</span>
                    {results && <em className={results[m.id].npv >= 0 ? 'pos' : 'neg'}>{compact(results[m.id].npv)} over {YEARS} yrs</em>}
                  </button>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-head"><h2>5 · Profitability</h2>
                <button className="link" onClick={() => setShowAssumptions((s) => !s)}>{showAssumptions ? 'Hide' : 'Edit'} assumptions</button></div>
              {!ready && <p className="muted">Waiting for a panel layout and energy estimate…</p>}
              {res && (
                <>
                  <div className="kpis">
                    <div><span>Upfront cost</span><b>{compact(res.netCapex)}</b>{res.incentive > 0 && <em>after {compact(res.incentive)} incentive</em>}</div>
                    <div><span>Year-1 income</span><b>{compact(res.year1Revenue - res.year1Om)}</b><em>{mode === 'lease' ? 'rent' : `after ${compact(res.year1Om)} upkeep`}</em></div>
                    <div><span>Payback</span><b>{res.paybackYear === null ? `> ${YEARS} yrs` : res.paybackYear === 0 ? 'Immediate' : `${res.paybackYear.toFixed(1)} yrs`}</b></div>
                    <div><span>{YEARS}-yr value (NPV)</span><b className={res.npv >= 0 ? 'pos' : 'neg'}>{compact(res.npv)}</b><em>at {(fin.discount * 100).toFixed(1)}% discount</em></div>
                    {res.lcoe !== null && <div><span>Cost per kWh</span><b>{(res.lcoe * 100).toFixed(1)}¢</b><em>levelized</em></div>}
                    {mode === 'grid' && <div><span>Grid hookup</span><b>{compact(res.interconnectCost)}</b><em>{grid?.nearestLineMi != null ? `${fmtDist(grid.nearestLineMi)} of new line` : 'line distance unknown'}</em></div>}
                    {mode === 'battery' && <div><span>Battery</span><b>{Math.round(kw * fin.batteryHours).toLocaleString()} kWh</b><em>{fin.batteryHours} hrs of storage</em></div>}
                  </div>
                  <CashChart data={res.cumulative} />
                </>
              )}
              {showAssumptions && (
                <div className="assume">
                  <Field label="Installed solar cost" value={fin.costPerW} onChange={setF('costPerW')} step={0.05} min={0.3} max={6} prefix="$" suffix="/W" />
                  <Field label="Incentive / tax credit" value={fin.incentivePct} onChange={setF('incentivePct')} min={0} max={70} suffix="%" />
                  <Field label="Upkeep (O&M)" value={fin.omPerKwYr} onChange={setF('omPerKwYr')} min={0} max={100} prefix="$" suffix="/kW·yr" />
                  <Field label="Grid sale price (PPA)" value={fin.ppaRate} onChange={setF('ppaRate')} step={0.005} min={0} max={1} prefix="$" suffix="/kWh" />
                  <Field label="Your retail rate" value={fin.retailRate} onChange={setF('retailRate')} step={0.005} min={0} max={1} prefix="$" suffix="/kWh" />
                  <Field label="Export credit" value={fin.exportRate} onChange={setF('exportRate')} step={0.005} min={0} max={1} prefix="$" suffix="/kWh" />
                  <Field label="Share used on site" value={fin.selfUseShare} onChange={setF('selfUseShare')} step={0.05} min={0} max={1} />
                  <Field label="Battery size" value={fin.batteryHours} onChange={setF('batteryHours')} step={0.5} min={0} max={12} suffix="hrs" />
                  <Field label="Battery cost" value={fin.batteryCostPerKwh} onChange={setF('batteryCostPerKwh')} step={10} min={50} max={2000} prefix="$" suffix="/kWh" />
                  <Field label="Share used with battery" value={fin.batterySelfUseShare} onChange={setF('batterySelfUseShare')} step={0.05} min={0} max={1} />
                  <Field label="Land lease rate" value={fin.leaseRatePerAcre} onChange={setF('leaseRatePerAcre')} step={50} min={0} max={10000} prefix="$" suffix="/acre·yr" />
                  <Field label="New power line cost" value={fin.lineCostPerMile} onChange={setF('lineCostPerMile')} step={10000} min={0} max={5e6} prefix="$" suffix="/mile" />
                  <Field label="Interconnection equipment" value={fin.interconnectPerKw} onChange={setF('interconnectPerKw')} step={10} min={0} max={1000} prefix="$" suffix="/kW" />
                  <Field label="Power price growth" value={fin.escalation} onChange={setF('escalation')} step={0.005} min={-0.05} max={0.1} suffix="/yr" />
                  <Field label="Discount rate" value={fin.discount} onChange={setF('discount')} step={0.005} min={0} max={0.2} />
                  <Field label="Panel degradation" value={fin.degradation} onChange={setF('degradation')} step={0.001} min={0} max={0.03} suffix="/yr" />
                  <p className="muted small">Defaults are rough North Carolina planning values, not quotes. Federal solar tax credits changed in 2025, so the incentive starts at 0%; enter any credit or grant you actually qualify for.</p>
                </div>
              )}
            </div>
          </>
        )}

        <footer className="foot">
          Illustrative estimates only. Not engineering, legal, or financial advice. Satellite: Esri. Production: NREL. Power lines: HIFLD / OpenStreetMap. AI: Claude.
        </footer>
      </aside>
    </div>
    </>
  );
}

type Scenario = { id: string; title: string; blurb: string; place: string; center: LatLng; w: number; h: number; site: SiteType; zoom: number };
const SCENARIOS: Scenario[] = [
  { id: 'farm', title: 'Farm near Zebulon', blurb: '~15-acre field, ground-mount', place: 'Zebulon, NC', center: [35.8452, -78.3086], w: 320, h: 200, site: 'ground', zoom: 16 },
  { id: 'home', title: 'Home in Apex', blurb: 'Single-family roof', place: 'Apex, NC', center: [35.7327, -78.8503], w: 16, h: 11, site: 'roof', zoom: 20 },
  { id: 'bigbox', title: 'Big-box roof in Raleigh', blurb: 'Commercial flat roof', place: 'Raleigh, NC', center: [35.8655, -78.5765], w: 120, h: 85, site: 'roof', zoom: 18 },
];

function Landing({ onScenario, onStart }: { onScenario: (s: Scenario) => void; onStart: () => void }) {
  // Illustrative card: 15 acres at the app's default $900/acre/yr lease with a 2%/yr escalator
  const acres = 15, rate = 900;
  const yr1 = acres * rate;
  const total = yr1 * ((Math.pow(1.02, YEARS) - 1) / 0.02);
  return (
    <div className="landing">
      <header className="topbar">
        <span className="wordmark"><span className="sunmark" />SunPlot</span>
        <nav>
          <a href="#how">How it works</a>
          <a href="#who">Owners &amp; investors</a>
          <button className="btn dark" onClick={onStart}>Open the map</button>
        </nav>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">Make solar energy economical · Wake County, NC</p>
          <h1>Your land has a <em>second harvest.</em></h1>
          <p className="sub">Trace your field or roof on a satellite map. SunPlot shows how many panels fit, what they'd produce and earn, and how an investor-funded lease can put solar on it for <b>$0 upfront</b>.</p>
          <div className="scenarios">
            {SCENARIOS.map((s) => (
              <button key={s.id} className="scenario" onClick={() => onScenario(s)}>
                <b>{s.title} →</b>
                <span>{s.blurb}</span>
              </button>
            ))}
          </div>
          <p className="hero-own">Or <button onClick={onStart}>draw your own site</button>.</p>
        </div>
        <aside className="hero-card">
          <h3>Example: a 15-acre field</h3>
          <p className="muted">Illustrative, at a ${rate}/acre/yr land lease with a 2% yearly increase.</p>
          <div className="hc-row"><span>Owner pays upfront</span><b className="green">$0</b></div>
          <div className="hc-row"><span>Lease income, year 1</span><b className="amber">${yr1.toLocaleString()}</b></div>
          <div className="hc-row"><span>Lease income over {YEARS} years</span><b>${Math.round(total / 1000).toLocaleString()}k</b></div>
          <div className="hc-bar">
            <i style={{ width: '55%', background: 'var(--sun)' }} />
            <i style={{ width: '15%', background: 'var(--green)' }} />
            <i style={{ width: '30%', background: 'var(--line-2)' }} />
          </div>
          <div className="hc-legend">
            <span style={{ ['--c' as string]: 'var(--sun)' }}>Panels</span>
            <span style={{ ['--c' as string]: 'var(--green)' }}>Setbacks</span>
            <span style={{ ['--c' as string]: 'var(--line-2)' }}>Access &amp; unusable</span>
          </div>
        </aside>
      </section>

      <section className="band" id="how">
        <div className="band-inner">
          <h2>From satellite photo to signed lease</h2>
          <p className="lede">Every number comes from your own outline and public data: Esri satellite imagery, the national lab's solar model (NREL PVWatts) and federal power-line maps.</p>
          <div className="steps">
            <div className="step"><div className="num">1</div><h4>Trace your site</h4><p>Click the corners of a field or roof on current satellite imagery, then drag to fine-tune. Panels are laid out in real rows with setbacks.</p></div>
            <div className="step"><div className="num">2</div><h4>AI checks the land</h4><p>Claude reads the satellite image for trees, buildings, water and roof equipment, and says how confident it is. You decide whether to apply its estimate.</p></div>
            <div className="step"><div className="num">3</div><h4>Compare the deals</h4><p>Sell to the grid, use it yourself, add batteries, or lease to an investor. See payback, 25-year value and a grid-profit heat map.</p></div>
          </div>
        </div>
      </section>

      <section className="band" id="who">
        <div className="band-inner two">
          <div className="who">
            <h4>For owners</h4>
            <ul>
              <li>Farms, homes, churches and businesses in Wake County</li>
              <li>See your site's real panel capacity in minutes</li>
              <li>Know what a fair lease looks like before a developer calls</li>
              <li>$0 upfront with an investor-funded lease</li>
            </ul>
          </div>
          <div className="who green">
            <h4>For investors</h4>
            <ul>
              <li>Screen sites by size, production and grid distance</li>
              <li>Payback, NPV and cost per kWh with editable assumptions</li>
              <li>Leases keep deals NC-legal: in North Carolina only the utility may sell retail power</li>
              <li>Coming next: a board of listed sites to browse and inquire</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="band cta-band">
        <div className="band-inner">
          <h2>See what your land could grow.</h2>
          <button className="btn amber" onClick={onStart}>Open the map →</button>
        </div>
      </section>

      <footer className="site-foot">Illustrative estimates only. Not engineering, legal, or financial advice. Satellite: Esri. Production: NREL. AI: Claude.</footer>
    </div>
  );
}

function CashChart({ data }: { data: number[] }) {
  const W = 360, H = 130, P = 6;
  const min = Math.min(0, ...data), max = Math.max(0, ...data);
  const span = max - min || 1;
  const x = (i: number) => P + (i / (data.length - 1)) * (W - 2 * P);
  const y = (v: number) => P + ((max - v) / span) * (H - 2 * P);
  const d = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${x(data.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative cash flow over 25 years">
        <path d={area} className="chart-area" />
        <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} className="chart-zero" />
        <path d={d} className="chart-line" />
      </svg>
      <div className="chart-x"><span>Today</span><span>Cumulative cash by year {data.length - 1}: <b>{compact(data[data.length - 1])}</b></span></div>
    </div>
  );
}
