/**
 * Read the usage log and say what it shows.
 *
 * Two sources, one report: a SQLite file on disk (`--db`, or the data directory this
 * config points at), or a running server's `/usage.json` (`--remote`). The remote form
 * exists because the file lives on a server in WAL mode, and copying a WAL-mode database
 * off a box while it is being written is the classic way to get a torn one.
 *
 *   npx tsx scripts/usage-report.ts --days 30
 *   npx tsx scripts/usage-report.ts --remote https://mcp.example.com --token "$TOKEN"
 *
 * Percentiles are honest about what they are: `avg` is exact (a sum over a count), and the
 * p95 column is the worst per-tool p95 in the window, because true percentiles cannot be
 * recombined from per-group ones and quoting a number that looks exact but is not is worse
 * than quoting a bound that is.
 */
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { nodeSqliteAvailable } from '../src/features/search/factory.js';
import type { DailyRow } from '../src/lib/usage/rollup.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const days = Math.max(1, Number(arg('days') ?? 30));
const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

async function rows(): Promise<DailyRow[]> {
  const remote = arg('remote');
  if (remote) {
    const token = arg('token') ?? process.env.ZOTEUS_METRICS_TOKEN;
    const res = await fetch(`${remote.replace(/\/$/, '')}/usage.json?days=${days}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`${remote} answered ${res.status} ${res.statusText}`);
    return ((await res.json()) as { rows: DailyRow[] }).rows;
  }
  if (!nodeSqliteAvailable()) throw new Error(`node:sqlite is unavailable on ${process.version}`);
  const path = arg('db') ?? join(loadConfig(process.env).dataDir, 'usage.sqlite');
  const { SqliteUsageStore } = await import('../src/lib/usage/store.js');
  const store = SqliteUsageStore.open({ path });
  const out = store.dailyRows(from);
  await store.close();
  return out;
}

const pad = (s: string | number, n: number): string => String(s).padStart(n);
const padEnd = (s: string, n: number): string => s.padEnd(n);

function report(all: DailyRow[]): string {
  const tools = all.filter((r) => r.kind === 'tool');
  const auth = all.filter((r) => r.kind === 'auth');
  const out: string[] = [];
  const last = all.at(-1)?.day ?? from;
  out.push(`Zoteus usage · ${from} → ${last} (${days} days)`, '');

  const byDay = new Map<string, DailyRow[]>();
  for (const r of tools) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  out.push(
    `${padEnd('day', 12)}${pad('users', 6)}${pad('calls', 7)}${pad('errors', 8)}${pad('avg ms', 8)}`,
  );
  for (const [day, rs] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    const calls = rs.reduce((n, r) => n + r.calls, 0);
    const users = new Set(rs.map((r) => r.userId).filter((u) => u !== null)).size;
    const errors = rs.reduce((n, r) => n + r.errors, 0);
    const avg = calls ? Math.round(rs.reduce((n, r) => n + r.msSum, 0) / calls) : 0;
    out.push(`${padEnd(day, 12)}${pad(users, 6)}${pad(calls, 7)}${pad(errors, 8)}${pad(avg, 8)}`);
  }
  if (!byDay.size) out.push('(no tool calls recorded in this window)');

  const group = (rs: DailyRow[], key: (r: DailyRow) => string) => {
    const m = new Map<
      string,
      { calls: number; errors: number; msSum: number; p95: number; days: Set<string> }
    >();
    for (const r of rs) {
      const k = key(r);
      const g = m.get(k) ?? { calls: 0, errors: 0, msSum: 0, p95: 0, days: new Set<string>() };
      g.calls += r.calls;
      g.errors += r.errors;
      g.msSum += r.msSum;
      g.p95 = Math.max(g.p95, r.msP95);
      g.days.add(r.day);
      m.set(k, g);
    }
    return [...m].sort((a, b) => b[1].calls - a[1].calls);
  };

  out.push(
    '',
    'Top tools' +
      ' '.repeat(19) +
      `${pad('calls', 7)}${pad('errors', 8)}${pad('avg ms', 8)}${pad('p95 max', 9)}`,
  );
  for (const [name, g] of group(tools, (r) => r.name).slice(0, 15)) {
    const avg = g.calls ? Math.round(g.msSum / g.calls) : 0;
    out.push(
      `  ${padEnd(name, 26)}${pad(g.calls, 7)}${pad(g.errors, 8)}${pad(avg, 8)}${pad(g.p95, 9)}`,
    );
  }

  const users = group(
    tools.filter((r) => r.userId !== null),
    (r) => String(r.userId),
  );
  if (users.length) {
    out.push(
      '',
      'By user' + ' '.repeat(21) + `${pad('calls', 7)}${pad('errors', 8)}${pad('days', 7)}  active`,
    );
    for (const [id, g] of users) {
      const span = [...g.days].sort();
      out.push(
        `  ${padEnd(id, 26)}${pad(g.calls, 7)}${pad(g.errors, 8)}${pad(g.days.size, 7)}  ${span[0]} → ${span.at(-1)}`,
      );
    }
  }

  if (auth.length) {
    out.push('', 'Auth steps');
    for (const [name, g] of group(auth, (r) => r.name))
      out.push(`  ${padEnd(name, 26)}${pad(g.calls, 7)}`);
  }
  return out.join('\n');
}

const all = await rows();
process.stdout.write(has('json') ? `${JSON.stringify(all, null, 2)}\n` : `${report(all)}\n`);
