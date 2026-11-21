import { useState } from 'react';

export type Listing = {
  id: string; name: string; town: string; type: 'Farm field' | 'Commercial roof' | 'Home roof';
  acres: number; kw: number; mwhYr: number; gridMi: number | null; lease: number;
  status: 'Available' | 'Under review' | 'Leased'; illustrative: boolean;
};

// Illustrative examples only (not real parcels or owners).
const SEED: Listing[] = [
  { id: 's1', name: 'Pasture off Pippin Rd', town: 'Zebulon', type: 'Farm field', acres: 22, kw: 3900, mwhYr: 5400, gridMi: 0.4, lease: 19800, status: 'Available', illustrative: true },
  { id: 's2', name: 'Fallow tobacco field', town: 'Wendell', type: 'Farm field', acres: 14, kw: 2400, mwhYr: 3350, gridMi: 1.1, lease: 12600, status: 'Available', illustrative: true },
  { id: 's3', name: 'Distribution center roof', town: 'Garner', type: 'Commercial roof', acres: 4.1, kw: 1000, mwhYr: 1330, gridMi: 0.1, lease: 9000, status: 'Under review', illustrative: true },
  { id: 's4', name: 'Church fellowship hall', town: 'Fuquay-Varina', type: 'Commercial roof', acres: 0.5, kw: 120, mwhYr: 160, gridMi: 0.1, lease: 1500, status: 'Available', illustrative: true },
  { id: 's5', name: 'Hay field near Swift Creek', town: 'Apex', type: 'Farm field', acres: 9, kw: 1500, mwhYr: 2100, gridMi: 2.3, lease: 8100, status: 'Leased', illustrative: true },
  { id: 's6', name: 'Retail strip roof', town: 'Knightdale', type: 'Commercial roof', acres: 1.6, kw: 380, mwhYr: 500, gridMi: 0.2, lease: 3400, status: 'Available', illustrative: true },
];

function load(key: string): Listing[] {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}

export function saveMyListing(l: Listing) {
  try {
    const cur = load('sunplot-listings').filter((x) => x.id !== l.id);
    localStorage.setItem('sunplot-listings', JSON.stringify([l, ...cur]));
  } catch { /* storage blocked: listing just won't persist */ }
}

const STATUSES = ['All', 'Available', 'Under review', 'Leased'] as const;

export default function InvestorBoard({ onHome, onMap }: { onHome: () => void; onMap: () => void }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('All');
  const [kind, setKind] = useState<'All' | 'Land' | 'Roof'>('All');
  const [nearGrid, setNearGrid] = useState(false);
  const [sort, setSort] = useState<'kw' | 'lease'>('kw');
  const [sel, setSel] = useState<Listing | null>(null);
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState({ name: '', email: '', note: '' });
  const [err, setErr] = useState('');

  const all = [...load('sunplot-listings'), ...SEED];
  const shown = all
    .filter((l) => status === 'All' || l.status === status)
    .filter((l) => kind === 'All' || (kind === 'Land' ? l.type === 'Farm field' : l.type !== 'Farm field'))
    .filter((l) => !nearGrid || (l.gridMi !== null && l.gridMi <= 0.5))
    .sort((a, b) => (sort === 'kw' ? b.kw - a.kw : b.lease - a.lease));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) { setErr('Add your name and a valid email.'); return; }
    setErr('');
    if (sel) setSent((s) => ({ ...s, [sel.id]: true }));
    setForm({ name: '', email: '', note: '' });
  }

  return (
    <div className="landing">
      <header className="topbar">
        <button className="wordmark" onClick={onHome}><span className="sunmark" />SunPlot</button>
        <nav><button className="btn" onClick={onMap}>List your site</button></nav>
      </header>
      <section className="band" style={{ borderTop: 0 }}>
        <div className="band-inner">
          <p className="eyebrow">Investor board · Wake County, NC</p>
          <h2>Sites ready for an investor-funded lease</h2>
          <p className="lede">Owners list fields and roofs; investors fund the install and pay the owner a lease, the NC-legal structure since only the utility may sell retail power. Seeded listings are illustrative examples, not real parcels. Sites you list from the map appear here (saved in this browser only).</p>

          <div className="pills">
            {STATUSES.map((s) => <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>{s}</button>)}
            <span className="sep" />
            {(['All', 'Land', 'Roof'] as const).map((k) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'All' ? 'Land + roof' : k}</button>)}
            <button className={nearGrid ? 'on' : ''} onClick={() => setNearGrid((v) => !v)}>≤ 0.5 mi to grid</button>
            <span className="sep" />
            <button className={sort === 'kw' ? 'on' : ''} onClick={() => setSort('kw')}>Sort: size</button>
            <button className={sort === 'lease' ? 'on' : ''} onClick={() => setSort('lease')}>Sort: lease</button>
          </div>

          <div className="board">
            <div className="listings">
              {shown.length === 0 && <div className="card empty"><p>No sites match these filters.</p></div>}
              {shown.map((l) => (
                <button key={l.id} className={`listing ${sel?.id === l.id ? 'on' : ''}`} onClick={() => setSel(l)}>
                  <div className="lt"><b>{l.name}</b><span className={`st ${l.status.replace(' ', '-').toLowerCase()}`}>{l.status}</span></div>
                  <span className="muted">{l.town} · {l.type}{l.illustrative ? ' · Illustrative' : ' · Listed by you'}</span>
                  <div className="lm">
                    <span><b>{l.kw >= 1000 ? `${(l.kw / 1000).toFixed(1)} MW` : `${Math.round(l.kw)} kW`}</b>size</span>
                    <span><b>{l.acres.toFixed(1)}</b>acres</span>
                    <span><b>${Math.round(l.lease / 1000)}k</b>lease/yr</span>
                    <span><b>{l.gridMi === null ? '—' : `${l.gridMi.toFixed(1)} mi`}</b>to grid</span>
                  </div>
                </button>
              ))}
            </div>
            <aside className="inspect">
              {!sel ? <div className="card empty"><p>Select a site to inspect it.</p></div> : (
                <div className="card">
                  <h2>{sel.name}</h2>
                  <p className="muted">{sel.town}, NC · {sel.type}{sel.illustrative ? ' · Illustrative example' : ''}</p>
                  <div className="kpis">
                    <div><span>System size</span><b>{sel.kw >= 1000 ? `${(sel.kw / 1000).toFixed(2)} MW` : `${Math.round(sel.kw)} kW`}</b></div>
                    <div><span>Energy / yr</span><b>{Math.round(sel.mwhYr).toLocaleString()} MWh</b></div>
                    <div><span>Owner lease / yr</span><b>${sel.lease.toLocaleString()}</b></div>
                  </div>
                  <h3 className="mini">Readiness checklist</h3>
                  <ul className="check">
                    <li className={sel.type === 'Farm field' ? 'warn' : 'ok'}>Zoning: {sel.type === 'Farm field' ? 'Wake County special use permit likely' : 'rooftop, typically permitted'}</li>
                    <li className={sel.gridMi !== null && sel.gridMi <= 0.5 ? 'ok' : 'warn'}>Interconnection: {sel.gridMi === null ? 'distance unknown' : `${sel.gridMi.toFixed(1)} mi to a mapped line`}</li>
                    <li className="todo">Shading: run the AI site check on the map</li>
                    <li className="todo">Title &amp; lease rights: owner to confirm</li>
                    <li className={sel.type === 'Home roof' ? 'ok' : 'todo'}>HOA: {sel.type === 'Home roof' ? 'NC HOAs cannot ban rooftop solar' : 'not applicable / confirm'}</li>
                  </ul>
                  {sent[sel.id] ? (
                    <p className="note">Interest sent! In a full version the owner would get your note. (Demo: nothing is emailed.)</p>
                  ) : (
                    <form className="interest" onSubmit={submit}>
                      <h3 className="mini">Express interest</h3>
                      <input placeholder="Your name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                      <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                      <textarea placeholder="Note to the owner (optional)" rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
                      {err && <p className="warn">{err}</p>}
                      <button className="btn dark" type="submit">Send interest</button>
                    </form>
                  )}
                </div>
              )}
            </aside>
          </div>
        </div>
      </section>
      <footer className="site-foot">Illustrative estimates only. Not engineering, legal, or financial advice. Satellite: Esri. Production: NREL. AI: Claude.</footer>
    </div>
  );
}
