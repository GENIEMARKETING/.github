#!/usr/bin/env node
/**
 * qa-file-bug.mjs — turn raw live-QA suite outputs into DEDUPLICATED GitHub
 * Issues (the agency's bug log) + one Slack summary card.
 *
 * Called by the `report` job of .github/workflows/qa-live.yml. Zero deps
 * (node >= 20: global fetch + crypto). Reads every recognized file under
 * QA_RAW_DIR:
 *   pw-*.json                  Playwright JSON reporter (smoke/a11y/consent/checkout)
 *   lighthouse-assertions.json lhci assertion-results (error-level fails only)
 *   zap.json                   ZAP baseline JSON (risk >= medium only)
 *   lychee.json                lychee fail_map (broken links)
 *   k6-failed.json + k6-summary.json  k6 threshold breach marker + p95 detail
 *
 * Bug-record contract (consumed by sessions/QA-TRIAGE.md and Tools/qa/qa-report.mjs):
 *   title:  [qa] <suite>: <check> (fp:<hash12>)
 *   labels: qa-bot, sev:<severity>, qa:open (lifecycle: qa:open → qa:pr-open →
 *           qa:fixed → qa:promoted; also qa:flaky, qa:wontfix, regression)
 *   body:   fenced yaml block with fingerprint/site/layer/suite/check/severity/
 *           first_seen/last_seen/occurrences/run_url/error_excerpt
 *
 * Dedupe (from mistakes-registry/pipeline/capture-hook.md's matching idea):
 *   same fingerprint open   → bump occurrences/last_seen + comment
 *   closed < 7 days ago     → reopen + `regression` label
 *   closed >= 7 days / none → create
 *
 * Exit: 1 when QA_FAIL_ON_FINDINGS=true and a NEW/REOPENED critical|high
 * finding exists (the workflow goes red only for fresh serious problems).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const {
  GITHUB_TOKEN,
  QA_SLACK_WEBHOOK = '',
  QA_REPO,
  QA_SITE_URL = '',
  QA_LAYER = 'nightly',
  QA_RUN_URL = '',
  QA_RAW_DIR = 'qa-raw',
  QA_FAIL_ON_FINDINGS = 'true',
} = process.env;

if (!GITHUB_TOKEN || !QA_REPO) {
  console.error('GITHUB_TOKEN and QA_REPO are required');
  process.exit(2);
}
const SITE = QA_REPO.split('/')[1];
const API = `https://api.github.com/repos/${QA_REPO}`;
const NOW = new Date().toISOString();

// ---------- collect raw files ----------
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(QA_RAW_DIR);
const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};
const clean = (s = '') =>
  String(s).replace(/\[[0-9;]*m/g, '').split('\n').slice(0, 15).join('\n').slice(0, 2000);

// ---------- parsers → findings ----------
/** @type {{suite:string,check:string,severity:string,excerpt:string}[]} */
const findings = [];

function pwSuiteName(file = '') {
  if (/checkout/.test(file)) return 'pw-checkout-live';
  if (/consent/.test(file)) return 'pw-consent';
  if (/a11y/.test(file)) return 'pw-a11y';
  if (/smoke/.test(file)) return 'pw-smoke';
  return 'pw-live';
}
const PW_SEV = { 'pw-checkout-live': 'critical', 'pw-consent': 'critical', 'pw-smoke': 'high', 'pw-a11y': 'high', 'pw-live': 'medium' };

function walkPwSuite(suite, out) {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const bad = (t.results ?? []).filter((r) => r.status !== 'passed' && r.status !== 'skipped');
      // Only count as a finding when NO retry passed.
      const passed = (t.results ?? []).some((r) => r.status === 'passed');
      if (bad.length && !passed) {
        out.push({
          file: spec.file ?? suite.file ?? '',
          title: spec.title,
          project: t.projectName ?? '',
          error: bad[0].error?.message ?? bad[0].errors?.[0]?.message ?? bad[0].status,
        });
      }
    }
  }
  for (const child of suite.suites ?? []) walkPwSuite(child, out);
}

for (const p of files) {
  const base = p.split('/').pop();

  if (/^pw-.*\.json$/.test(base)) {
    const data = readJson(p);
    if (!data?.suites) continue;
    const fails = [];
    for (const s of data.suites) walkPwSuite(s, fails);
    for (const f of fails) {
      const suite = pwSuiteName(f.file);
      findings.push({
        suite,
        check: `${f.file} › ${f.title}${f.project ? ` [${f.project}]` : ''}`,
        severity: PW_SEV[suite],
        excerpt: clean(f.error),
      });
    }
  }

  if (base === 'lighthouse-assertions.json') {
    const data = readJson(p);
    if (!Array.isArray(data)) continue;
    for (const a of data) {
      if (a.passed || a.level !== 'error') continue; // warns stay in the artifact
      findings.push({
        suite: 'lighthouse',
        check: `${a.auditId ?? a.name} @ ${a.url ?? QA_SITE_URL}`,
        severity: 'medium',
        excerpt: clean(`expected ${a.operator ?? ''} ${a.expected}, got ${a.actual}`),
      });
    }
  }

  if (base === 'zap.json') {
    const data = readJson(p);
    for (const site of data?.site ?? []) {
      for (const alert of site.alerts ?? []) {
        const risk = Number(alert.riskcode);
        if (risk < 2) continue; // low/info = report-only noise
        findings.push({
          suite: 'zap',
          check: `${alert.pluginid} ${alert.alert ?? alert.name}`,
          severity: risk >= 3 ? 'high' : 'medium',
          excerpt: clean(`${alert.riskdesc}\n${alert.instances?.[0]?.uri ?? ''}`),
        });
      }
    }
  }

  if (base === 'lychee.json') {
    const data = readJson(p);
    const seen = new Set();
    let origin = '';
    try { origin = new URL(QA_SITE_URL).origin; } catch {}
    for (const fails of Object.values(data?.fail_map ?? {})) {
      for (const f of fails) {
        const url = f.url ?? String(f);
        if (seen.has(url)) continue;
        seen.add(url);
        const status = f.status?.code ?? f.status?.text ?? JSON.stringify(f.status ?? '');
        findings.push({
          suite: 'lychee',
          check: `broken link: ${url}`,
          severity: origin && url.startsWith(origin) ? 'medium' : 'low',
          excerpt: clean(`status: ${status}`),
        });
      }
    }
  }

  if (base === 'k6-failed.json') {
    const summary = readJson(join(QA_RAW_DIR, 'k6-summary.json')) ?? readJson(p.replace('k6-failed', 'k6-summary'));
    const lines = [];
    for (const [name, m] of Object.entries(summary?.metrics ?? {})) {
      if (name.startsWith('http_req_duration') && m['p(95)'] != null) {
        lines.push(`${name}: p95=${Math.round(m['p(95)'])}ms`);
      }
    }
    findings.push({
      suite: 'k6',
      check: 'checkout-latency thresholds breached (smoke profile)',
      severity: 'high',
      excerpt: clean(lines.join('\n') || 'see k6 artifact'),
    });
  }
}

console.log(`Parsed ${files.length} raw files → ${findings.length} findings`);

// QA_DRY_RUN=1 → print findings + fingerprints, no API/Slack calls (local testing).
if (process.env.QA_DRY_RUN === '1') {
  for (const f of findings) {
    const fp = createHash('sha256')
      .update([SITE, f.suite, f.check, f.excerpt.split('\n')[0]].join('|'))
      .digest('hex')
      .slice(0, 12);
    console.log(JSON.stringify({ fp, ...f }));
  }
  process.exit(0);
}

// ---------- GitHub issue dedupe ----------
const gh = async (path, init = {}) => {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'vinny-qa-bot',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!res.ok && res.status !== 422) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
};

const LABELS = [
  ['qa-bot', 'ededed', 'Filed by the automated live-QA harness'],
  ['qa:open', 'd73a4a', 'QA finding awaiting triage'],
  ['qa:pr-open', 'fbca04', 'Fix PR open'],
  ['qa:fixed', '0e8a16', 'Fix merged'],
  ['qa:promoted', '5319e7', 'Lesson promoted to the mistakes-registry'],
  ['qa:flaky', 'c5def5', 'Could not reproduce twice'],
  ['qa:wontfix', 'ffffff', 'Accepted behavior'],
  ['regression', 'b60205', 'Previously fixed, seen again'],
  ['sev:critical', 'b60205', ''], ['sev:high', 'd93f0b', ''], ['sev:medium', 'fbca04', ''], ['sev:low', 'c2e0c6', ''],
];
for (const [name, color, description] of LABELS) {
  await gh('/labels', { method: 'POST', body: JSON.stringify({ name, color, description }) }); // 422 = exists
}

// One listing (all states) → fingerprint map. Cheaper + no search-index lag.
const fpMap = new Map();
for (let page = 1; page <= 5; page++) {
  const batch = await gh(`/issues?labels=qa-bot&state=all&per_page=100&page=${page}`);
  if (!Array.isArray(batch) || batch.length === 0) break;
  for (const issue of batch) {
    const m = issue.title.match(/fp:([a-f0-9]{12})/);
    if (m && (!fpMap.has(m[1]) || new Date(issue.created_at) > new Date(fpMap.get(m[1]).created_at))) {
      fpMap.set(m[1], issue);
    }
  }
  if (batch.length < 100) break;
}

const yamlBlock = (fp, f, firstSeen, occurrences) => `\`\`\`yaml
fingerprint: ${fp}
site: ${SITE}
target_url: ${QA_SITE_URL}
layer: ${QA_LAYER}
suite: ${f.suite}
check: ${JSON.stringify(f.check)}
severity: ${f.severity}
first_seen: ${firstSeen}
last_seen: ${NOW}
occurrences: ${occurrences}
run_url: ${QA_RUN_URL}
error_excerpt: |
${f.excerpt.split('\n').map((l) => `  ${l}`).join('\n')}
\`\`\``;

let created = 0, bumped = 0, reopened = 0, newSerious = 0;
for (const f of findings) {
  const fp = createHash('sha256')
    .update([SITE, f.suite, f.check, f.excerpt.split('\n')[0]].join('|'))
    .digest('hex')
    .slice(0, 12);
  const existing = fpMap.get(fp);
  const serious = f.severity === 'critical' || f.severity === 'high';

  if (existing && existing.state === 'open') {
    const prev = Number((existing.body?.match(/occurrences: (\d+)/) ?? [])[1] ?? 1);
    const firstSeen = (existing.body?.match(/first_seen: (\S+)/) ?? [])[1] ?? NOW;
    await gh(`/issues/${existing.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: yamlBlock(fp, f, firstSeen, prev + 1) }),
    });
    await gh(`/issues/${existing.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `Seen again (${QA_LAYER}, occurrence ${prev + 1}): ${QA_RUN_URL}` }),
    });
    bumped++;
  } else if (existing && Date.now() - new Date(existing.closed_at) < 7 * 864e5) {
    await gh(`/issues/${existing.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'open', labels: [...new Set([...existing.labels.map((l) => l.name), 'regression', 'qa:open'])] }),
    });
    await gh(`/issues/${existing.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `REGRESSION — reappeared after being closed: ${QA_RUN_URL}\n\n${yamlBlock(fp, f, NOW, 1)}` }),
    });
    reopened++;
    if (serious) newSerious++;
  } else {
    await gh('/issues', {
      method: 'POST',
      body: JSON.stringify({
        title: `[qa] ${f.suite}: ${f.check.slice(0, 140)} (fp:${fp})`,
        labels: ['qa-bot', `sev:${f.severity}`, 'qa:open'],
        body: `${yamlBlock(fp, f, NOW, 1)}\n\nFiled automatically by [qa-live](${QA_RUN_URL}). Triage: \`sessions/QA-TRIAGE.md\`.`,
      }),
    });
    created++;
    if (serious) newSerious++;
  }
}

// ---------- Slack card ----------
if (QA_SLACK_WEBHOOK) {
  const top = findings
    .filter((f) => f.severity === 'critical' || f.severity === 'high')
    .slice(0, 5)
    .map((f) => `• [${f.severity}] ${f.suite}: ${f.check}`)
    .join('\n');
  const text =
    `*QA ${QA_LAYER}* — ${SITE} (${QA_SITE_URL})\n` +
    `${findings.length} finding(s): ${created} new · ${reopened} regression · ${bumped} recurring` +
    (top ? `\n${top}` : findings.length === 0 ? '\n✅ all suites green' : '') +
    `\n<${QA_RUN_URL}|run> · <https://github.com/${QA_REPO}/issues?q=label%3Aqa-bot+is%3Aopen|open qa bugs>`;
  await fetch(QA_SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch((e) => console.error(`Slack post failed: ${e.message}`));
}

console.log(`Issues: ${created} created, ${reopened} reopened (regression), ${bumped} bumped; new serious: ${newSerious}`);
if (QA_FAIL_ON_FINDINGS === 'true' && newSerious > 0) {
  console.error(`Failing workflow: ${newSerious} NEW critical/high finding(s).`);
  process.exit(1);
}
