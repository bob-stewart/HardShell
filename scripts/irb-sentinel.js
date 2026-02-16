#!/usr/bin/env node
/*
  IRB Sentinel (v1)

  Public-reproducible BYOK holon sentinel:
  - Detect gateable surfaces (conservative path heuristics)
  - REQUIRE evidence id for gateable surfaces (fail-closed)
  - Run a multi-model panel via OpenRouter (BYOK)
  - Write artifacts to MeshCORE (case, crosscheck, finding, receipts)

  Safety:
  - Does NOT expose services publicly.
  - Does NOT change system config.
  - Only writes auditable artifacts into MeshCORE.
*/

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function randId(prefix) {
  return `${prefix}-${Math.random().toString(16).slice(2, 10)}`;
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function exec(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
}

function getWorkspacePaths() {
  const scriptDir = __dirname;
  const hardshellDir = path.resolve(scriptDir, '..');
  const devDir = path.resolve(hardshellDir, '..'); // Business/EXOCHAIN/dev
  const businessDir = path.resolve(devDir, '../..');
  const meshcoreDir = path.join(businessDir, 'meshcore');
  return { hardshellDir, devDir, businessDir, meshcoreDir };
}

function detectGateableSurfaces(changedFiles) {
  const surfaces = new Set();
  for (const f of changedFiles) {
    if (/(^|\/)\.github\//.test(f)) surfaces.add('ci');
    if (/(^|\/)scripts\//.test(f)) surfaces.add('ops-scripts');
    if (/(^|\/)environments\//.test(f)) surfaces.add('env-config');
    if (/openclaw\.json|config\/.*/.test(f)) surfaces.add('config');
    if (/allowlist|approval|exec|privilege|sudo/i.test(f)) surfaces.add('privilege');
    if (/key|token|secret|auth|oauth/i.test(f)) surfaces.add('auth');
    if (/bind|listen|port|ingress|firewall|tls|cert/i.test(f)) surfaces.add('network');
  }

  const gateable = ['privilege', 'auth', 'network', 'env-config', 'config'];
  const isGateable = gateable.some((s) => surfaces.has(s));
  return { isGateable, surfaces: [...surfaces] };
}

async function openrouterChat({ model, prompt, timeoutMs = 60_000 }) {
  const key = mustEnv('OPENROUTER_API_KEY');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 900,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        status: 'ERROR',
        provider: 'openrouter',
        model,
        latencyMs,
        error: `http=${res.status} body=${JSON.stringify(json).slice(0, 500)}`,
        text: `ERROR: openrouter ${res.status}`,
        tokensIn: 0,
        tokensOut: 0,
      };
    }
    const text = (json.choices?.[0]?.message?.content || '').trim();
    const usage = json.usage || {};
    return {
      status: 'OK',
      provider: 'openrouter',
      model,
      latencyMs,
      text,
      tokensIn: usage.prompt_tokens || 0,
      tokensOut: usage.completion_tokens || 0,
    };
  } catch (e) {
    const latencyMs = Date.now() - started;
    return {
      status: 'ERROR',
      provider: 'openrouter',
      model,
      latencyMs,
      error: String(e?.message || e),
      text: `ERROR: ${String(e?.message || e)}`,
      tokensIn: 0,
      tokensOut: 0,
    };
  } finally {
    clearTimeout(t);
  }
}

function mkPanelPrompt({ summary, surfaces, evidenceIds }) {
  return [
    'You are an AI-IRB panelist. Your job is to assess safety and defensibility, not speed.',
    '',
    'Given this proposed change, answer with:',
    '1) RISK: LOW|MEDIUM|HIGH|CRITICAL',
    '2) CONCERNS: bullet list',
    '3) REQUIRED_GATES: bullet list of gates/tests/evidence needed before approval',
    '4) RECOMMENDATION: APPROVE | REQUEST_CHANGES | REJECT',
    '',
    `SUMMARY: ${summary}`,
    `AFFECTED_SURFACES: ${surfaces.join(', ') || '(none)'}`,
    `EVIDENCE_IDS: ${evidenceIds.join(', ') || '(none)'}`,
  ].join('\n');
}

function parsePanel(text) {
  const upper = (text || '').toUpperCase();
  const risk = (upper.match(/RISK\s*:\s*(LOW|MEDIUM|HIGH|CRITICAL)/) || [])[1] || 'MEDIUM';
  const rec = (upper.match(/RECOMMENDATION\s*:\s*(APPROVE|REQUEST_CHANGES|REJECT)/) || [])[1] || 'REQUEST_CHANGES';
  return { risk, recommendation: rec };
}

async function main() {
  const { meshcoreDir } = getWorkspacePaths();
  if (!fs.existsSync(path.join(meshcoreDir, '.git'))) {
    throw new Error(`MeshCORE repo not found at ${meshcoreDir}`);
  }

  const summary = process.env.IRB_SUMMARY || 'Unspecified change';
  const evidenceId = process.env.EVIDENCE_ID || '';
  const evidenceIds = evidenceId ? [evidenceId] : [];

  // Determine change set in current repo
  let changedFiles = [];
  try {
    const out = exec('git diff --name-only HEAD~1..HEAD', process.cwd());
    changedFiles = out ? out.split('\n').filter(Boolean) : [];
  } catch {
    // ignore
  }

  const force = process.env.IRB_FORCE === '1' || process.env.IRB_FORCE === 'true';
  const forcedSurfaces = (process.env.IRB_SURFACES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const det = detectGateableSurfaces(changedFiles);
  if (!det.isGateable && !force) {
    console.log('NO_GATEABLE_SURFACES_DETECTED');
    process.exit(0);
  }

  if (force && forcedSurfaces.length) {
    det.surfaces = Array.from(new Set([...det.surfaces, ...forcedSurfaces]));
    det.isGateable = true;
  }

  // Fail-closed if no evidence id
  if (!evidenceId) {
    const caseId = randId('IRB');
    const createdAt = nowIso();
    const irbCase = {
      id: caseId,
      createdAt,
      severity: 'HIGH',
      summary: `${summary} (missing evidence id)` ,
      status: 'ESCALATED',
      affectedSurfaces: det.surfaces,
      evidenceIds: [],
      links: [],
    };
    const casePath = path.join(meshcoreDir, 'projects/ai-irb/cases', `${caseId}.json`);
    writeJson(casePath, irbCase);
    exec('git add projects/ai-irb/cases', meshcoreDir);
    try { exec(`git commit -m "chore(ai-irb): open ${caseId} (missing evidence)"`, meshcoreDir); } catch {}
    console.log(JSON.stringify({ caseId, escalated: true, reason: 'missing evidence id' }, null, 2));
    process.exit(3);
  }

  const caseId = randId('IRB');
  const reportId = randId('CR');
  const findingId = randId('FIND');

  const createdAt = nowIso();

  const irbCase = {
    id: caseId,
    createdAt,
    severity: 'MEDIUM',
    summary,
    status: 'IN_REVIEW',
    affectedSurfaces: det.surfaces,
    evidenceIds,
    links: [],
  };

  const prompt = mkPanelPrompt({ summary, surfaces: det.surfaces, evidenceIds });

  // Required trio + optional Gemini
  const models = [
    'openai/gpt-5.2',
    'anthropic/claude-opus-4-6',
    // OpenRouter canonical IDs (previous hyphenated IDs were invalid)
    'x-ai/grok-4.1-fast',
    'google/gemini-3-pro-preview'
  ];

  const results = [];
  for (const m of models) {
    results.push(await openrouterChat({ model: m, prompt }));
  }

  // Create receipts
  const receiptIds = [];
  for (const r of results) {
    const rid = randId('RCPT');
    receiptIds.push(rid);
    const receipt = {
      id: rid,
      createdAt: nowIso(),
      kind: 'llm-call',
      provider: r.provider,
      model: r.model,
      latencyMs: r.latencyMs,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      status: r.status,
      error: r.error || '',
      metadata: { purpose: 'ai-irb-panel' }
    };
    const rp = path.join(meshcoreDir, 'projects/ai-irb/receipts', `${rid}.json`);
    writeJson(rp, receipt);
  }

  const opinions = results.map((r) => {
    const parsed = parsePanel(r.text);
    return {
      agent_id: `did:meshcore:${r.model}`,
      agent_kind: 'ai',
      agent_label: r.model,
      model: r.model,
      policy_id: 'ai-irb-v0',
      stance: parsed.recommendation.toLowerCase(),
      summary: r.text,
      confidence: 0.5,
      risks: [],
    };
  });

  // Convergence rule: the required trio must be OK and must match recommendation.
  const required = results.slice(0, 3);
  const requiredOk = required.every((r) => r.status === 'OK' && r.text && !r.text.startsWith('ERROR'));
  const requiredStances = required.map((r) => parsePanel(r.text).recommendation);
  const converged = requiredOk && new Set(requiredStances).size === 1;

  const dissent = converged ? '' : 'Panel did not converge or required provider errored.';

  const crosscheck = {
    schema_version: '0.2',
    id: reportId,
    created_by: 'did:meshcore:irb-sentinel',
    question: 'Safety and defensibility review',
    method: 'adversarial',
    inputs: evidenceIds,
    opinions,
    synthesis: converged ? 'Converged.' : 'Not converged.',
    dissent,
    dissenters: [],
    metadata: { receipts: receiptIds }
  };

  const finding = {
    id: findingId,
    caseId,
    createdAt: nowIso(),
    crosscheckReportId: reportId,
    converged,
    summary: converged ? 'Converged' : 'Not converged',
    dissent,
    recommendation: converged ? 'Proceed with gates satisfied' : 'Escalate to Chair'
  };

  if (!converged) {
    irbCase.severity = 'HIGH';
    irbCase.status = 'ESCALATED';
  }

  const casePath = path.join(meshcoreDir, 'projects/ai-irb/cases', `${caseId}.json`);
  const crossPath = path.join(meshcoreDir, 'projects/ai-irb/crosschecks', `${reportId}.json`);
  const findPath = path.join(meshcoreDir, 'projects/ai-irb/findings', `${findingId}.json`);

  writeJson(casePath, irbCase);
  writeJson(crossPath, crosscheck);
  writeJson(findPath, finding);

  // Improvement backlog artifact (proposal-only, non-invasive)
  const ts = new Date();
  const yyyy = String(ts.getUTCFullYear());
  const mm = String(ts.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ts.getUTCDate()).padStart(2, '0');
  const hh = String(ts.getUTCHours()).padStart(2, '0');

  const okCount = results.filter((r) => r.status === 'OK').length;
  const errCount = results.length - okCount;
  const latencies = results
    .map((r) => r.latencyMs)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;

  const backlog = {
    schema: 'meshcore.irb.improvement.v1',
    run: {
      job_id: process.env.IRB_JOB_ID || '',
      timestamp_utc: nowIso(),
      commit_range: null,
      forced: true,
      irb_force: process.env.IRB_FORCE === '1' || process.env.IRB_FORCE === 'true',
      irb_surfaces: (process.env.IRB_SURFACES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    },
    links: {
      evidence_bundle: evidenceIds[0] || '',
      case: caseId,
      findings: findingId,
      crosscheck: reportId,
      receipts: receiptIds
    },
    signals: {
      provider_reliability: {
        provider: 'openrouter',
        success_rate_1h: results.length ? okCount / results.length : 0,
        error_rate_1h: results.length ? errCount / results.length : 0,
        median_latency_ms: p50
      },
      convergence: {
        attempts: 1,
        pass_rate: converged ? 1 : 0,
        common_disagreements: []
      },
      adverse_events: {
        count: errCount,
        events: results
          .filter((r) => r.status === 'ERROR')
          .map((r) => ({ model: r.model, error: r.error || '' }))
      }
    },
    proposals: [
      {
        id: `IRB-PROP-${yyyy}${mm}${dd}-${hh}-001`,
        title: 'TBD (auto-generated placeholder) — propose a safe improvement backed by receipts',
        holon: 'Moats: Data & Learning Loops',
        surface: 'irb-sentinel',
        risk: 'GREEN',
        why_now: 'Hourly loop running; collect signals and propose bounded improvements.',
        expected_impact: { metric: 'convergence.pass_rate', direction: 'up', confidence: 0.5 },
        evidence: [
          { ref: `receipts:${receiptIds[0] || ''}`, note: 'See receipts for provider reliability.' }
        ],
        guardrails: [
          'No permissions/allowlists changes',
          'No network exposure changes',
          'No destructive ops',
          'No escalation routing changes'
        ],
        next_action: 'QUEUE_FOR_REVIEW'
      }
    ],
    routing: {
      forums: [
        { name: 'Advantage Forum', reason: 'learning loop consistency' },
        { name: 'Ethics Forum', reason: 'severity/escalation semantics' }
      ],
      review_sla_hours: 72
    }
  };

  const backlogDir = path.join(meshcoreDir, 'projects/ai-irb/backlog', yyyy, mm, dd, hh);
  const backlogJson = path.join(backlogDir, 'irb-improvement.json');
  const backlogMd = path.join(backlogDir, 'irb-improvement.md');

  writeJson(backlogJson, backlog);
  fs.writeFileSync(
    backlogMd,
    [
      `# IRB Improvement Backlog — ${backlog.run.timestamp_utc}`,
      '',
      'Run:',
      `- Job: ${backlog.run.job_id || '(unset)'}`,
      `- Forced: ${backlog.run.irb_force ? 'yes' : 'no'}`,
      `- Surfaces: ${(backlog.run.irb_surfaces || []).join(', ') || '(none)'}`,
      `- Evidence: ${backlog.links.evidence_bundle || '(none)'}`,
      `- Converged: ${converged ? 'yes' : 'no'}`,
      `- Adverse events: ${errCount}`,
      '',
      'Key Signals:',
      `- Provider reliability: success ${(backlog.signals.provider_reliability.success_rate_1h * 100).toFixed(0)}% | p50 latency ${p50 ?? '(n/a)'}ms`,
      `- Convergence pass rate: ${converged ? '100%' : '0%'}`,
      '',
      'Proposals:',
      `1) ${backlog.proposals[0].id} — ${backlog.proposals[0].title}`,
      `   - Holon: ${backlog.proposals[0].holon}`,
      `   - Surface: ${backlog.proposals[0].surface}`,
      `   - Risk: ${backlog.proposals[0].risk}`,
      `   - Next: ${backlog.proposals[0].next_action}`,
      ''
    ].join('\n'),
    'utf8'
  );

  exec(
    'git add projects/ai-irb/cases projects/ai-irb/crosschecks projects/ai-irb/findings projects/ai-irb/receipts projects/ai-irb/backlog',
    meshcoreDir
  );
  try {
    exec(`git commit -m "chore(ai-irb): open ${caseId}"`, meshcoreDir);
  } catch {}

  console.log(
    JSON.stringify(
      { caseId, reportId, findingId, converged, severity: irbCase.severity, receipts: receiptIds, backlog: path.relative(meshcoreDir, backlogJson) },
      null,
      2
    )
  );

  if (irbCase.status === 'ESCALATED') process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
