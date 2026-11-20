// Simple 25-year project economics. Every number here is an editable assumption shown in the UI.
export type Mode = 'grid' | 'onsite' | 'battery' | 'lease';

export interface FinInputs {
  mode: Mode;
  kw: number;
  annualKwh: number;
  acres: number;
  costPerW: number; // installed solar cost, $/W DC
  ppaRate: number; // $/kWh paid by the utility/buyer when selling everything
  retailRate: number; // $/kWh you avoid paying when you use it yourself
  exportRate: number; // $/kWh credit for surplus sent to the grid
  selfUseShare: number; // 0..1 of production used on site (onsite mode)
  batteryKwh: number;
  batteryCostPerKwh: number;
  batterySelfUseShare: number; // 0..1 of production used on site with storage
  incentivePct: number; // tax credit / grant as % of solar + storage cost
  omPerKwYr: number;
  escalation: number; // yearly electricity price growth
  discount: number; // discount rate for NPV
  degradation: number; // yearly output loss
  leaseRatePerAcre: number;
  gridDistanceMi: number | null;
  lineCostPerMile: number;
  interconnectFixed: number;
}

export interface FinResult {
  capex: number;
  interconnectCost: number;
  incentive: number;
  netCapex: number;
  year1Revenue: number;
  year1Om: number;
  paybackYear: number | null;
  npv: number;
  lcoe: number | null;
  cumulative: number[]; // index 0 = start (−net capex), then each year
}

export const YEARS = 25;

export function runFinance(f: FinInputs): FinResult {
  if (f.mode === 'lease') {
    const rent = f.acres * f.leaseRatePerAcre;
    const cumulative = [0];
    let npv = 0;
    for (let t = 1; t <= YEARS; t++) {
      const r = rent * Math.pow(1.02, t - 1); // typical ~2%/yr lease escalator
      cumulative.push(cumulative[t - 1] + r);
      npv += r / Math.pow(1 + f.discount, t);
    }
    return { capex: 0, interconnectCost: 0, incentive: 0, netCapex: 0, year1Revenue: rent, year1Om: 0, paybackYear: 0, npv, lcoe: null, cumulative };
  }

  const solarCost = f.kw * 1000 * f.costPerW;
  const batteryCost = f.mode === 'battery' ? f.batteryKwh * f.batteryCostPerKwh : 0;
  let interconnectCost = 0;
  if (f.mode === 'grid') interconnectCost = f.interconnectFixed + (f.gridDistanceMi ?? 0) * f.lineCostPerMile;
  if (f.mode === 'onsite') interconnectCost = f.interconnectFixed * 0.2; // uses existing service; meter + permits
  const capex = solarCost + batteryCost + interconnectCost;
  const incentive = (solarCost + batteryCost) * f.incentivePct;
  const netCapex = capex - incentive;

  const valuePerKwh = (t: number) => {
    const esc = Math.pow(1 + f.escalation, t - 1);
    if (f.mode === 'grid') return f.ppaRate * esc;
    const self = f.mode === 'battery' ? f.batterySelfUseShare : f.selfUseShare;
    return (self * f.retailRate + (1 - self) * f.exportRate) * esc;
  };

  const cumulative = [-netCapex];
  let npv = -netCapex;
  let pvCost = netCapex;
  let pvKwh = 0;
  let paybackYear: number | null = null;
  let year1Revenue = 0;
  const year1Om = f.kw * f.omPerKwYr;

  for (let t = 1; t <= YEARS; t++) {
    const kwh = f.annualKwh * Math.pow(1 - f.degradation, t - 1);
    const revenue = kwh * valuePerKwh(t);
    const om = year1Om * Math.pow(1.02, t - 1);
    if (t === 1) year1Revenue = revenue;
    const net = revenue - om;
    const prev = cumulative[t - 1];
    const cur = prev + net;
    cumulative.push(cur);
    if (paybackYear === null && prev < 0 && cur >= 0) paybackYear = t - 1 + (-prev / net);
    const df = Math.pow(1 + f.discount, t);
    npv += net / df;
    pvCost += om / df;
    pvKwh += kwh / df;
  }
  if (netCapex <= 0) paybackYear = 0;
  return { capex, interconnectCost, incentive, netCapex, year1Revenue, year1Om, paybackYear, npv, lcoe: pvKwh > 0 ? pvCost / pvKwh : null, cumulative };
}

export const money = (n: number) =>
  (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 });
export const compact = (n: number) =>
  (n < 0 ? '−$' : '$') + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(n));
