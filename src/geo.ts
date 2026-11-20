// Geometry helpers: local flat projection (fine for plots up to a few km), area, panel layout.
export type LatLng = [number, number];

const R = 6378137;
const D2R = Math.PI / 180;

export function toLocal(origin: LatLng, p: LatLng): [number, number] {
  const x = (p[1] - origin[1]) * D2R * R * Math.cos(origin[0] * D2R);
  const y = (p[0] - origin[0]) * D2R * R;
  return [x, y];
}

export function toLatLng(origin: LatLng, xy: [number, number]): LatLng {
  const lat = origin[0] + (xy[1] / R) / D2R;
  const lng = origin[1] + (xy[0] / (R * Math.cos(origin[0] * D2R))) / D2R;
  return [lat, lng];
}

export function centroid(poly: LatLng[]): LatLng {
  const n = poly.length || 1;
  return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
}

export function areaM2(poly: LatLng[]): number {
  if (poly.length < 3) return 0;
  const o = centroid(poly);
  const pts = poly.map((p) => toLocal(o, p));
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function pointInPoly(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True if any two non-adjacent edges cross (a bow-tie shape gives a wrong area). */
export function selfIntersects(poly: LatLng[]): boolean {
  if (poly.length < 4) return false;
  const o = centroid(poly);
  const p = poly.map((q) => toLocal(o, q));
  const n = p.length;
  const cross = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      const a = p[i], b = p[(i + 1) % n], c = p[j], d = p[(j + 1) % n];
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

export interface LayoutOptions {
  panelWidthM: number; // east-west size of one module
  panelLengthM: number; // module length along the tilt
  tiltDeg: number;
  groundCoverageRatio: number; // module footprint depth / row pitch
  setbackM: number; // keep-out distance from the plot edge
  coverage: number; // 0..1 share of the possible panels to actually place
}

export interface Layout {
  maxPanels: number; // everything that fits
  panelCount: number; // after the coverage slider
  runs: LatLng[][]; // merged rectangles for drawing
  tooLarge: boolean;
}

const MAX_AREA_M2 = 4_000_000; // ~1,000 acres keeps the layout fast in the browser

export function layoutPanels(poly: LatLng[], opt: LayoutOptions): Layout {
  if (poly.length < 3) return { maxPanels: 0, panelCount: 0, runs: [], tooLarge: false };
  if (areaM2(poly) > MAX_AREA_M2) return { maxPanels: 0, panelCount: 0, runs: [], tooLarge: true };
  const o = centroid(poly);
  const pts = poly.map((p) => toLocal(o, p));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];

  const w = opt.panelWidthM;
  const depth = opt.panelLengthM * Math.cos(opt.tiltDeg * D2R);
  const pitch = Math.max(depth / Math.max(opt.groundCoverageRatio, 0.05), depth);
  const s = opt.setbackM;

  // rows from south to north; each row is a list of fitted column indices
  const rows: { y: number; cols: number[] }[] = [];
  for (let y = minY + s; y + depth + s <= maxY; y += pitch) {
    const cols: number[] = [];
    let i = 0;
    for (let x = minX + s; x + w + s <= maxX; x += w, i++) {
      const ok =
        pointInPoly(x - s, y - s, pts) &&
        pointInPoly(x + w + s, y - s, pts) &&
        pointInPoly(x - s, y + depth + s, pts) &&
        pointInPoly(x + w + s, y + depth + s, pts) &&
        pointInPoly(x + w / 2, y + depth / 2, pts);
      if (ok) cols.push(i);
    }
    if (cols.length) rows.push({ y, cols });
  }

  const maxPanels = rows.reduce((n, r) => n + r.cols.length, 0);
  let remaining = Math.round(maxPanels * Math.min(Math.max(opt.coverage, 0), 1));
  const panelCount = remaining;
  const runs: LatLng[][] = [];

  for (const r of rows) {
    if (remaining <= 0) break;
    const take = r.cols.slice(0, remaining);
    remaining -= take.length;
    // merge contiguous columns into one rectangle so big plots stay fast to draw
    let start = take[0];
    let prev = take[0];
    const flush = (a: number, b: number) => {
      const x0 = minX + s + a * w;
      const x1 = minX + s + (b + 1) * w;
      runs.push([
        toLatLng(o, [x0, r.y]),
        toLatLng(o, [x1, r.y]),
        toLatLng(o, [x1, r.y + depth]),
        toLatLng(o, [x0, r.y + depth]),
      ]);
    };
    for (let k = 1; k < take.length; k++) {
      if (take[k] !== prev + 1) {
        flush(start, prev);
        start = take[k];
      }
      prev = take[k];
    }
    flush(start, prev);
  }
  return { maxPanels, panelCount, runs, tooLarge: false };
}

/** Distance in metres from a point to the nearest segment of a polyline. */
export function distToPolylineM(p: LatLng, line: LatLng[]): number {
  const [px, py] = [0, 0];
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = toLocal(p, line[i]);
    const [bx, by] = toLocal(p, line[i + 1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
    if (d < best) best = d;
  }
  if (line.length === 1) best = Math.hypot(...toLocal(p, line[0]));
  return best;
}

export const M2_PER_ACRE = 4046.86;
export const M_PER_MILE = 1609.34;
