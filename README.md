# SunPlot: solar site planner

**TRIANGULATE 2026 · Team 07 · Grand Challenge: Make Solar Energy Economical**

Live: https://triangulate-team-7.vercel.app

## The problem
Small landowners in North Carolina (farmers with marginal fields, churches and warehouses with big flat roofs)
get approached by solar developers but cannot judge whether their land or roof is any good, how much it could
earn, or whether to sell power to the grid, use it themselves or lease the land. Consultants cost thousands, and
home solar calculators assume one house roof, not a field.

## What it does
1. **Pick a plot** on current satellite imagery (search an address or pan) and draw its border. Drag corners to adjust it, and drag edge dots to add corners.
2. **Panel layout:** real 580 W modules are packed into rows inside the border, using tilt, row spacing (GCR) and an edge setback. A coverage slider sets how much of the space gets panels.
3. **AI site check:** Claude looks at the satellite image of the outline and reports land cover, obstructions (trees, buildings, water, roof equipment), the usable share and a suggested coverage, with a confidence level.
4. **Energy:** NREL PVWatts v8 (the US national-lab solar model) gives annual and monthly output for that exact location.
5. **Grid or storage:** OpenStreetMap power lines and substations near the plot give the distance to connect. Four options are compared side by side: sell to the grid, use on site, store it with batteries, or lease to a developer.
6. **Profitability:** upfront cost, year-1 income, payback, 25-year NPV, levelized cost per kWh and a cash-flow chart. Every assumption can be edited.

## What is live vs. assumed
- **Live:** satellite imagery (Esri), the solar model (NREL PVWatts), power-line data (OpenStreetMap), the layout geometry, the finance math and the AI image analysis (once `ANTHROPIC_API_KEY` is set).
- **Assumed (editable defaults):** installed cost, power prices, lease rate, line-extension cost, battery cost, discount rate. These are planning values, not quotes.

## How the AI can be wrong, and how we check it
- Old or cloudy imagery, shadows read as trees, crop rows read as panels. The AI reports image quality and confidence, and the user decides whether to apply its suggestion.
- The AI never sets the plot area or the money numbers. Area comes from the user's outline (geometry), energy comes from NREL, and money comes from our finance model. The AI only judges what is physically on the plot.
- Its output is schema-checked (structured JSON) and its percentages are clamped to 0–100.

## Stack
Vite + React + TypeScript, Leaflet, Vercel serverless functions (`/api/analyze`, `/api/pvwatts`), Anthropic Claude (vision), NREL PVWatts v8, OpenStreetMap Overpass, Esri World Imagery.

### Environment variables (Vercel → Settings → Environment Variables)
- `ANTHROPIC_API_KEY`: enables the AI site check
- `NREL_API_KEY` (optional): a free key from developer.nrel.gov; falls back to NREL's rate-limited `DEMO_KEY`
