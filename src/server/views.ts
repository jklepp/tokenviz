import type { Dashboard, SettingsView } from '../report/dashboard.ts';

/**
 * The dashboard's markup.
 *
 * The visual language is taken from the design mockup -- palette, density, the
 * cost-basis disclosure bar, and charts drawn in CSS rather than by a library.
 * The panel set is not: the mockup describes one Commander fleet, and most
 * projects have no tasks, roles or promotions to show.
 */

/** A rate as the store holds it, so saving an unedited form changes nothing. */
export function rate(n: number): string {
  return String(Number(n.toFixed(4)));
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function human(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

const usd = (n: number) =>
  n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(2)}`;
const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
const dur = (ms: number | null) =>
  ms === null ? 'n/a' : ms >= 3600000 ? `${(ms / 3600000).toFixed(1)}h` : `${Math.round(ms / 60000)}m`;

const CSS = `
:root{color-scheme:light dark;
--bg:light-dark(#f3f4ef,#0d100f);--p:light-dark(#fff,#171b19);--s:light-dark(#f7f7f3,#202522);
--i:light-dark(#171917,#f4f6f2);--m:light-dark(#687069,#abb3ac);--l:light-dark(#dde0da,#333a35);
--o:light-dark(#e65e25,#ff7b40);--b:light-dark(#356dcc,#71a1ff);--u:light-dark(#7654b8,#ad8bea);
--g:light-dark(#23794b,#56cc89);--r:light-dark(#c0392b,#ff7d6e)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--i);font:16px/1.6 Inter,system-ui,-apple-system,sans-serif}
a{color:inherit}
.wrap{max-width:1280px;margin:0 auto;padding:0 0 40px}
.fh{display:flex;justify-content:space-between;align-items:center;padding:22px 26px;background:var(--p);border-bottom:1px solid var(--l)}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:38px;height:38px;display:grid;place-items:center;border-radius:10px;background:var(--o);color:#fff;font:700 13px ui-monospace,monospace}
h1{font-size:25px;margin:0}
h2{font-size:17px;margin:0}
.sub,.meta{color:var(--m);font-size:14px}
.nav{display:flex;gap:14px;font-size:14px}
.nav a{color:var(--m);text-decoration:none;padding:5px 10px;border:1px solid var(--l);border-radius:7px;font-size:14px}
.nav a.on{color:var(--i);border-color:var(--o)}
.basis{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 26px;background:var(--s);border-bottom:1px solid var(--l);font-size:14px;color:var(--m)}
.basis b{color:var(--i)}
.body{padding:24px 26px;display:grid;gap:22px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.card,.panel{background:var(--p);border:1px solid var(--l);border-radius:12px}
.card{padding:16px;min-width:0;overflow-wrap:anywhere}
.panel{padding:16px}
.label{font-size:14px;color:var(--m)}
.num{font-size:36px;font-weight:700;letter-spacing:-.04em;margin-top:5px;font-variant-numeric:tabular-nums}
.note{font-size:13px;color:var(--m);margin-top:4px}
.good{color:var(--g)}.bad{color:var(--r)}
.grid{display:grid;grid-template-columns:1.6fr .9fr;gap:20px;align-items:start}
.equal{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}
.title{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:12px}
.chart{height:337px;display:flex;align-items:end;gap:7px;border-bottom:1px solid var(--l)}
.day{height:100%;flex:1;display:flex;flex-direction:column;justify-content:end;min-width:0}
.value{font-size:11px;color:var(--m);text-align:center;margin-bottom:4px;white-space:nowrap;font-variant-numeric:tabular-nums}
.bar{background:var(--b);border-radius:5px 5px 0 0;border-top:3px solid var(--o);min-height:3px}
.day small{font-size:11px;color:var(--m);text-align:center;margin-top:7px;display:block}
.rows{display:grid;gap:13px}
.rowtop{display:flex;justify-content:space-between;font-size:14px}
.track{height:8px;background:var(--l);border-radius:99px;overflow:hidden;margin-top:6px}
.fill{height:100%;border-radius:inherit;background:var(--b)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th{color:var(--m);font-weight:500;text-align:left;padding:0 10px 11px;white-space:nowrap}
td{padding:11px 10px;border-top:1px solid var(--l)}
th:not(:first-child),td:not(:first-child){text-align:right}
td.l,th.l{text-align:left}
.tag{display:inline-block;padding:1px 6px;border-radius:5px;font-size:12px;border:1px solid var(--l);color:var(--m)}
.tag.warn{color:var(--o);border-color:var(--o)}
.foot{font-size:13px;line-height:1.7;color:var(--m);padding:0 26px}
.foot b{color:var(--i)}
form.set{display:grid;gap:14px}
fieldset{border:1px solid var(--l);border-radius:10px;padding:14px;margin:0}
legend{font-size:14px;color:var(--m);padding:0 6px}
input[type=number],input[type=date],input[type=text]{background:var(--s);color:var(--i);border:1px solid var(--l);border-radius:6px;padding:5px 7px;font:inherit;font-size:15px;width:100%;max-width:150px;text-align:right}
button{background:var(--o);color:#fff;border:0;border-radius:8px;padding:11px 22px;font:inherit;font-size:16px;cursor:pointer}
button.ghost{background:transparent;color:var(--i);border:1px solid var(--l)}
.flash{padding:12px 16px;border-radius:10px;border:1px solid var(--g);color:var(--g);background:var(--p);font-size:15px}
.flash.warn{border-color:var(--o);color:var(--o)}
.hint{font-size:13px;color:var(--m);margin-top:6px}
@media(max-width:900px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.grid,.equal{grid-template-columns:1fr}.chart{height:300px}}
`;

function shell(title: string, nav: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">${nav}${body}</div></body></html>`;
}

function header(project: string, page: 'dashboard' | 'settings', subtitle: string): string {
  const on = (p: string) => (p === page ? ' class="on"' : '');
  return `<div class="fh"><div class="brand"><div class="logo">TV</div><div>
<h1>${esc(project)}</h1><div class="sub">${esc(subtitle)}</div></div></div>
<div class="nav"><a href="/p/${encodeURIComponent(project)}"${on('dashboard')}>Dashboard</a>
<a href="/p/${encodeURIComponent(project)}/settings"${on('settings')}>Settings</a></div></div>`;
}

/**
 * The cost basis is stated on every page, not tucked into a footnote. These
 * dollars were never paid, and a reader who misses that will reconcile them
 * against a subscription invoice and conclude the tool is broken.
 */
function basisBar(d: Dashboard): string {
  const un =
    d.uncostedRequests > 0
      ? ` &middot; <span class="tag warn">${d.uncostedRequests.toLocaleString()} requests unpriced</span>`
      : '';
  const rec = d.reconciliation
    ? ` &middot; reconciles to Claude Code's own billing within <b>${pct(d.reconciliation.medianRelError)}</b> per session`
    : '';
  return `<div class="basis"><div>Cost basis: <b>API-equivalent</b>, at per-model rates &middot; not money paid, and not a subscription invoice${rec}</div>
<div>${esc(d.totals.firstDay ?? '')} to ${esc(d.totals.lastDay ?? '')}${un}</div></div>`;
}

function kpi(label: string, value: string, note = ''): string {
  return `<div class="card"><div class="label">${esc(label)}</div><div class="num">${value}</div>
${note ? `<div class="note">${note}</div>` : ''}</div>`;
}

function chart(d: Dashboard): string {
  const max = Math.max(1, ...d.days.map((x) => x.processed));
  const bars = d.days
    .map((x) => {
      const h = Math.max(2, Math.round((x.processed / max) * 100));
      const label = x.day.slice(5).replace('-', '/');
      return `<div class="day" title="${esc(x.day)}: ${human(x.processed)} tokens, ${usd(x.usd)}">
<div class="value">${human(x.processed)}</div><div class="bar" style="height:${h}%"></div><small>${esc(label)}</small></div>`;
    })
    .join('');
  return `<div class="panel"><div class="title"><h2>Daily consumption</h2><span class="meta">Processed tokens, cache reads included</span></div>
<div class="chart">${bars}</div></div>`;
}

function cachePanel(d: Dashboard): string {
  const t = d.totals;
  const ctx = t.input + t.cacheWrite + t.cacheRead;
  const row = (name: string, v: number, of: number) =>
    `<div><div class="rowtop"><span>${esc(name)}</span><span>${human(v)} &middot; ${((v / Math.max(of, 1)) * 100).toFixed(1)}%</span></div>
<div class="track"><div class="fill" style="width:${Math.min(100, (v / Math.max(of, 1)) * 100).toFixed(2)}%"></div></div></div>`;
  return `<div class="panel"><div class="title"><h2>Cache economics</h2><span class="meta">Context delivery</span></div>
<div class="rows">${row('Cache read', t.cacheRead, ctx)}${row('Cache write', t.cacheWrite, ctx)}${row('Fresh input', t.input, ctx)}</div>
<div class="note" style="margin-top:14px">Cache hit rate is measured against context, not processed tokens: output was never a candidate for caching.</div></div>`;
}

function slotPanel(d: Dashboard): string {
  const roles = d.slots.some((s) => s.role !== null);
  const rows = d.slots
    .map(
      (s) =>
        `<tr><td class="l">${esc(s.slot)}</td>${roles ? `<td class="l"><span class="tag">${esc(s.role)}</span></td>` : ''}
<td>${s.requests.toLocaleString()}</td><td>${human(s.processed)}</td><td>${d.cardsPresent ? usd(s.usd) : '&mdash;'}</td></tr>`,
    )
    .join('');
  return `<div class="panel"><div class="title"><h2>Attribution</h2><span class="meta">By ${roles ? 'slot and role' : 'worktree'}</span></div>
<div class="scroll"><table><thead><tr><th class="l">${roles ? 'Slot' : 'Worktree'}</th>${roles ? '<th class="l">Role</th>' : ''}<th>Requests</th><th>Processed</th><th>Cost</th></tr></thead>
<tbody>${rows}</tbody></table></div></div>`;
}

function modelPanel(d: Dashboard): string {
  const rows = d.models
    .map((m) => {
      const util =
        m.contextWindow && m.contextWindow > 0
          ? `${((m.peakContext / m.contextWindow) * 100).toFixed(0)}%`
          : '<span class="meta">set window</span>';
      return `<tr><td class="l">${esc(m.model ?? '(none)')} ${m.priced ? '' : '<span class="tag warn">unpriced</span>'}</td>
<td>${m.requests.toLocaleString()}</td><td>${human(m.processed)}</td><td>${human(m.output)}</td>
<td>${human(m.peakContext)}</td><td>${util}</td><td>${m.priced ? usd(m.usd) : '&mdash;'}</td></tr>`;
    })
    .join('');
  return `<div class="panel"><div class="title"><h2>Model ledger</h2><span class="meta">Peak context against the model's window</span></div>
<div class="scroll"><table><thead><tr><th class="l">Model</th><th>Requests</th><th>Processed</th><th>Output</th><th>Peak ctx</th><th>Util</th><th>Cost</th></tr></thead>
<tbody>${rows}</tbody></table></div></div>`;
}

function commanderPanels(d: Dashboard): string {
  const c = d.commander;
  if (!c) return '';
  const s = c.summary;

  const roleRows = c.roles
    .map(
      (r) =>
        `<tr><td class="l">${esc(r.role)}</td><td>${r.tasks}</td><td>${r.landed}</td>
<td>${r.takeovers}</td><td>${usd(r.usd)}</td><td>${usd(r.usd / Math.max(r.landed, 1))}</td></tr>`,
    )
    .join('');

  const taskRows = c.tasks
    .slice(0, 12)
    .map(
      (t) =>
        `<tr><td class="l">#${t.prNumber}</td><td class="l">${esc(t.slot)}</td>
<td class="l">${esc((t.title ?? t.taskSlug).slice(0, 52))}</td>
<td>${t.requests.toLocaleString()}</td><td>${dur(t.durationMs)}</td>
<td>${t.takeover ? '<span class="tag warn">takeover</span>' : ''}</td><td>${usd(t.costUSD)}</td></tr>`,
    )
    .join('');

  const total = s.totalUSD + s.noTaskSlotUSD + s.betweenTasksUSD;
  const split = (name: string, v: number, note: string) =>
    `<div><div class="rowtop"><span>${esc(name)}</span><span>${usd(v)} &middot; ${((v / Math.max(total, 1)) * 100).toFixed(0)}%</span></div>
<div class="track"><div class="fill" style="width:${((v / Math.max(total, 1)) * 100).toFixed(2)}%"></div></div>
<div class="note">${esc(note)}</div></div>`;

  return `
<div class="kpis">
${kpi('Land rate', pct(s.landRate), `${s.landed} of ${s.tasks} tasks`)}
${kpi('Autonomous success', pct(s.autonomousSuccessRate), `${s.withTakeover} tasks needed a human`)}
${kpi('Cost per landed task', usd(s.costPerLanded ?? 0), `${usd(s.costPerAutonomousSuccess ?? 0)} per autonomous success`)}
${kpi('p95 cost / duration', `${usd(s.p95CostUSD ?? 0)}`, `p50 ${usd(s.p50CostUSD ?? 0)} &middot; p95 duration ${dur(s.p95DurationMs)}`)}
</div>
<div class="grid">
  <div class="panel"><div class="title"><h2>Most expensive tasks</h2><span class="meta">Priority targets for context reduction</span></div>
  <div class="scroll"><table><thead><tr><th class="l">PR</th><th class="l">Slot</th><th class="l">Task</th><th>Requests</th><th>Duration</th><th></th><th>Cost</th></tr></thead>
  <tbody>${taskRows}</tbody></table></div></div>
  <div class="panel"><div class="title"><h2>Where spend goes</h2><span class="meta">All of it, not just the attributable part</span></div>
  <div class="rows">
  ${split('Attributed to tasks', s.totalUSD, 'Work inside a task window')}
  ${split('Orchestration overhead', s.noTaskSlotUSD, 'CEO and owner slots, which open no PRs')}
  ${split('Between tasks', s.betweenTasksUSD, 'Coder slots, cut off from any task by the silence timeout')}
  </div></div>
</div>
<div class="panel"><div class="title"><h2>By role</h2><span class="meta">Usage-based chargeback</span></div>
<div class="scroll"><table><thead><tr><th class="l">Role</th><th>Tasks</th><th>Landed</th><th>Takeovers</th><th>Cost</th><th>Per landed</th></tr></thead>
<tbody>${roleRows}</tbody></table></div></div>`;
}

export function dashboardPage(d: Dashboard): string {
  const t = d.totals;
  const cards = d.cardsPresent;
  const kpis = `<div class="kpis">
${kpi('Processed tokens', human(t.processed), `${t.requests.toLocaleString()} requests`)}
${kpi('API-equivalent cost', cards ? usd(d.costUSD) : '&mdash;', cards ? 'never paid; see cost basis' : 'no rate cards yet')}
${kpi('Cache hit rate', pct(d.cacheHitRate), `${human(t.cacheRead)} served from cache`)}
${kpi('Mean context', human(t.meanContext), `peak ${human(t.peakContext)}`)}
</div>`;

  const body = `${basisBar(d)}<div class="body">
${kpis}
${chart(d)}
<div class="grid">${slotPanel(d)}${cachePanel(d)}</div>
${modelPanel(d)}
${d.commander ? commanderPanels(d) : `<div class="panel"><div class="title"><h2>Tasks</h2></div><div class="meta">
This project has no workflow adapter, so there are no tasks, roles or outcomes to show. Everything above is
true of any project regardless of how it is worked.</div></div>`}
</div>
<div class="foot"><b>Cost is API-equivalent, not cash paid.</b> Per-model rates are applied to observed token
categories; subscription fees, hardware and hosting are excluded. Rates are effective-dated, so a price change
is a step in the series rather than a silent rewrite of the past.</div>`;

  return shell(
    `${d.project.slug} — TokenViz`,
    header(d.project.slug, 'dashboard', d.project.github_repo ?? d.project.root_path),
    body,
  );
}

export function settingsPage(s: SettingsView, flash?: { text: string; warn?: boolean }): string {
  const cardRows = s.cards
    .map(
      (c) => `<tr>
<td class="l">${esc(c.model)}</td>
<td class="l"><span class="meta">${esc(c.valid_from.slice(0, 10))}</span></td>
<td><input type="number" step="0.0001" min="0" name="input:${esc(c.model)}" value="${rate(c.input_per_mtok)}"></td>
<td><input type="number" step="0.0001" min="0" name="output:${esc(c.model)}" value="${rate(c.output_per_mtok)}"></td>
<td><input type="number" step="0.0001" min="0" name="cw5m:${esc(c.model)}" value="${rate(c.cache_write_5m_per_mtok)}"></td>
<td><input type="number" step="0.0001" min="0" name="cw1h:${esc(c.model)}" value="${rate(c.cache_write_1h_per_mtok)}"></td>
<td><input type="number" step="0.0001" min="0" name="read:${esc(c.model)}" value="${rate(c.cache_read_per_mtok)}"></td>
<td><input type="number" step="1000" min="0" name="ctx:${esc(c.model)}" value="${s.windows.get(c.model) ?? ''}"></td>
</tr>`,
    )
    .join('');

  const aliasRows = s.aliases
    .map(
      (a) =>
        `<tr><td class="l">${esc(a.request_model)}</td><td class="l">&rarr; ${esc(a.card_model)}</td>
<td class="l"><span class="meta">${esc(a.reason ?? '')}</span></td></tr>`,
    )
    .join('');

  const unpriced =
    s.unpriced.length === 0
      ? '<div class="meta">Every model seen has a card or an alias.</div>'
      : `<div class="meta">These models appear in transcripts with no card, so their requests are excluded from
every cost figure rather than priced by a neighbouring card:</div>
<div style="margin-top:8px">${s.unpriced.map((m) => `<span class="tag warn">${esc(m)}</span>`).join(' ')}</div>`;

  const body = `<div class="body">
${flash ? `<div class="flash${flash.warn ? ' warn' : ''}">${esc(flash.text)}</div>` : ''}

<form class="set" method="post" action="/p/${encodeURIComponent(s.project.slug)}/settings">
<fieldset><legend>Rates, in dollars per million tokens</legend>
<div class="scroll"><table><thead><tr>
<th class="l">Model</th><th class="l">Effective</th><th>Input</th><th>Output</th><th>Cache write 5m</th>
<th>Cache write 1h</th><th>Cache read</th><th>Context window</th></tr></thead>
<tbody>${cardRows || '<tr><td colspan="8" class="l"><span class="meta">No rate cards yet. Run <code>tokenviz rates --write</code>.</span></td></tr>'}</tbody></table></div>
<div class="hint">Saving edits the card currently in force. Everything is re-costed from these rates on the next page load,
because cost is computed on read rather than stored.</div>
</fieldset>

<fieldset><legend>Backdate a correction</legend>
<div class="meta">Editing above changes the current card. To fix a rate that was wrong in the past, give a date here:
a new card is written effective from it, and only requests on or after that date are re-costed. The change in total is reported.</div>
<div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
<label class="meta">Effective from <input type="date" name="valid_from"></label>
<span class="meta">Leave empty to edit the current card in place.</span></div>
</fieldset>

<div><button type="submit">Save rates</button></div>
</form>

<div class="panel"><div class="title"><h2>Model aliases</h2><span class="meta">Which card prices a recorded model</span></div>
<div class="scroll"><table><thead><tr><th class="l">Recorded as</th><th class="l">Priced by</th><th class="l">Why</th></tr></thead>
<tbody>${aliasRows || '<tr><td colspan="3" class="l"><span class="meta">None.</span></td></tr>'}</tbody></table></div></div>

<div class="panel"><div class="title"><h2>Unpriced models</h2></div>${unpriced}</div>
</div>
<div class="foot"><b>Rates are effective-dated.</b> A request is costed by the card in force at its own timestamp, so
correcting today's price does not silently rewrite what last month cost.</div>`;

  return shell(
    `Settings — ${s.project.slug}`,
    header(s.project.slug, 'settings', 'Rates and model settings'),
    body,
  );
}

export function projectsPage(rows: { slug: string; repo: string | null; requests: number }[]): string {
  const body = `<div class="body"><div class="panel"><div class="title"><h2>Projects</h2>
<span class="meta">Everything ingested into this store</span></div>
<div class="scroll"><table><thead><tr><th class="l">Project</th><th class="l">Repository</th><th>Requests</th></tr></thead><tbody>
${rows
  .map(
    (r) =>
      `<tr><td class="l"><a href="/p/${encodeURIComponent(r.slug)}">${esc(r.slug)}</a></td>
<td class="l"><span class="meta">${esc(r.repo ?? '—')}</span></td><td>${r.requests.toLocaleString()}</td></tr>`,
  )
  .join('')}
</tbody></table></div></div></div>`;
  return shell('TokenViz', header('TokenViz', 'dashboard', 'Projects'), body);
}
