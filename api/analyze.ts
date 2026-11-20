// POST /api/analyze  { polygon: [lat, lng][] }
// Fetches a current satellite image of the plot and asks Claude to judge what part of it can hold solar panels.
import Anthropic from '@anthropic-ai/sdk';

type LatLng = [number, number];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const R = 6378137;
const merc = ([lat, lng]: LatLng): [number, number] => [
  (lng * Math.PI * R) / 180,
  R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['siteType', 'landCover', 'usablePercent', 'recommendedCoveragePercent', 'obstructions', 'concerns', 'confidence', 'imageQuality', 'summary'],
  properties: {
    siteType: { type: 'string', enum: ['open_field', 'flat_roof', 'pitched_roof', 'parking_lot', 'forest', 'water', 'mixed', 'not_a_site'] },
    landCover: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'percentOfPlot'],
        properties: { type: { type: 'string' }, percentOfPlot: { type: 'number' } },
      },
    },
    usablePercent: { type: 'number', description: 'Share of the outlined plot that could hold panels without clearing trees, buildings, water or roads.' },
    recommendedCoveragePercent: { type: 'number', description: 'Suggested share of the possible panel positions to fill, after access lanes and obstructions.' },
    obstructions: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    imageQuality: { type: 'string', description: 'Clouds, blur, low resolution, or anything that limits the judgement.' },
    summary: { type: 'string', description: 'Two or three plain-language sentences for the landowner.' },
  },
} as const;

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return json({ error: 'AI_NOT_CONFIGURED' }, 503);

  let polygon: LatLng[];
  try {
    const body = await request.json();
    polygon = body.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 60) throw new Error();
    for (const p of polygon) {
      if (!Array.isArray(p) || Math.abs(p[0]) > 85 || Math.abs(p[1]) > 180) throw new Error();
    }
  } catch {
    return json({ error: 'Send polygon as 3–60 [lat, lng] points.' }, 400);
  }

  // square bounding box (web mercator) around the plot with padding
  const m = polygon.map(merc);
  const xs = m.map((p) => p[0]);
  const ys = m.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const half = (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 60) / 2) * 1.2;
  if (half > 8000) return json({ error: 'Plot is too large for one satellite image (max ~10 km across).' }, 400);
  const [minX, minY, maxX, maxY] = [cx - half, cy - half, cx + half, cy + half];
  const size = 1024;
  const imgUrl =
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export' +
    `?bbox=${minX},${minY},${maxX},${maxY}&bboxSR=3857&imageSR=3857&size=${size},${size}&format=jpg&f=image`;

  const img = await fetch(imgUrl);
  if (!img.ok || !(img.headers.get('content-type') ?? '').startsWith('image/')) {
    return json({ error: 'Could not load satellite imagery for this spot.' }, 502);
  }
  const b64 = Buffer.from(await img.arrayBuffer()).toString('base64');

  // plot outline in image pixel coordinates (0,0 = top-left)
  const outline = m
    .map(([x, y]) => `(${Math.round(((x - minX) / (2 * half)) * size)}, ${Math.round(((maxY - y) / (2 * half)) * size)})`)
    .join(', ');
  const widthM = Math.round(2 * half * Math.cos((polygon[0][0] * Math.PI) / 180));

  const client = new Anthropic();
  try {
    const params = {
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system:
        'You assess satellite images for solar panel siting. Be honest about uncertainty: if the image is blurry, cloudy, outdated-looking, or the outline does not cover land or a roof, say so and lower confidence. Never invent features you cannot see. Percentages are of the outlined plot only.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            {
              type: 'text',
              text:
                `This ${size}x${size} px satellite image covers about ${widthM} m across; north is up. ` +
                `The landowner outlined a plot with these vertices in pixel coordinates (x right, y down): ${outline}. ` +
                'Judge only the area inside that outline. Identify land cover, obstructions (trees, buildings, water, roads, steep ground, HVAC units on roofs), and what share could realistically hold panels.',
            },
          ],
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await client.beta.messages.create(params as any);
    if (res.stop_reason === 'refusal') return json({ error: 'The AI declined to assess this image.' }, 422);
    const text = (res.content as { type: string; text?: string }[]).find((b) => b.type === 'text')?.text;
    if (!text) return json({ error: 'The AI returned no assessment.' }, 502);
    const out = JSON.parse(text);
    const clamp = (n: unknown) => Math.max(0, Math.min(100, Number(n) || 0));
    out.usablePercent = clamp(out.usablePercent);
    out.recommendedCoveragePercent = clamp(out.recommendedCoveragePercent);
    return json({ ...out, imageUrl: imgUrl, model: res.model });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'AI is busy, try again in a moment.' }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: 'AI key is invalid.' }, 500);
    if (err instanceof Anthropic.APIError) return json({ error: `AI error ${err.status}` }, 502);
    return json({ error: 'AI assessment failed.' }, 500);
  }
}
