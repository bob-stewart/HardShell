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

  const det = detectGateableSurfaces(changedFiles);
  if (!det.isGateable) {
    console.log('NO_GATEABLE_SURFACES_DETECTED');
    process.exit(0);
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
    'xai/grok-4-1',
    'google/gemini-3-pro'
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

  exec('git add projects/ai-irb/cases projects/ai-irb/crosschecks projects/ai-irb/findings projects/ai-irb/receipts', meshcoreDir);
  try { exec(`git commit -m "chore(ai-irb): open ${caseId}"`, meshcoreDir); } catch {}

  console.log(JSON.stringify({ caseId, reportId, findingId, converged, severity: irbCase.severity, receipts: receiptIds }, null, 2));

  if (irbCase.status === 'ESCALATED') process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
