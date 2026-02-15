#!/usr/bin/env node
/*
  IRB Sentinel (v0)

  Purpose:
  - Detect whether a change touches gateable surfaces (path-based heuristic for now)
  - If so, open an IRB case in MeshCORE and run a multi-model crosscheck
  - Write artifacts into MeshCORE:
    - projects/ai-irb/cases/<caseId>.json
    - projects/ai-irb/crosschecks/<reportId>.json (decision.forum CrosscheckReport)
    - projects/ai-irb/findings/<findingId>.json

  Safety:
  - Does NOT modify system configs or expose network services.
  - Only writes files in MeshCORE and commits them.
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
  const exochainDir = path.join(devDir, 'exochain');
  const meshcoreDir = path.join(businessDir, 'meshcore');
  return { hardshellDir, exochainDir, meshcoreDir };
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

async function callOpenAI(prompt) {
  const key = mustEnv('OPENAI_API_KEY');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.2',
      input: prompt,
      reasoning: { effort: 'low' },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${JSON.stringify(json).slice(0, 500)}`);
  const text = (json.output_text || '').trim();
  return { provider: 'openai', model: json.model || 'gpt-5.2', text };
}

async function callAnthropic(prompt) {
  const key = mustEnv('ANTHROPIC_API_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Anthropic error: ${res.status} ${JSON.stringify(json).slice(0, 500)}`);
  const text = (json.content || []).map((b) => b.text || '').join('').trim();
  return { provider: 'anthropic', model: json.model || 'claude-sonnet-4-5', text };
}

async function callXAI(prompt) {
  const key = mustEnv('XAI_API_KEY');
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-4-1-fast-reasoning',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`xAI error: ${res.status} ${JSON.stringify(json).slice(0, 500)}`);
  const text = (json.choices?.[0]?.message?.content || '').trim();
  return { provider: 'xai', model: json.model || 'grok-4-1-fast-reasoning', text };
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
  const upper = text.toUpperCase();
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

  // determine change set in current repo
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

  const started = Date.now();
  const results = await Promise.all([
    callOpenAI(prompt).catch((e) => ({ provider: 'openai', model: 'gpt-5.2', text: `ERROR: ${e.message}` })),
    callAnthropic(prompt).catch((e) => ({ provider: 'anthropic', model: 'claude-sonnet-4-5', text: `ERROR: ${e.message}` })),
    callXAI(prompt).catch((e) => ({ provider: 'xai', model: 'grok-4-1-fast-reasoning', text: `ERROR: ${e.message}` })),
  ]);
  const latencyMs = Date.now() - started;

  const opinions = results.map((r) => {
    const parsed = parsePanel(r.text);
    return {
      agent_id: `did:meshcore:${r.provider}`,
      agent_kind: 'ai',
      agent_label: r.provider,
      model: r.model,
      policy_id: 'ai-irb-v0',
      stance: parsed.recommendation.toLowerCase(),
      summary: r.text,
      confidence: 0.5,
      risks: [],
    };
  });

  const stances = opinions.map((o) => (o.summary.startsWith('ERROR') ? 'ERROR' : o.stance));
  const converged = new Set(stances.filter((s) => s !== 'ERROR')).size === 1 && !stances.includes('ERROR');
  const dissent = converged ? '' : 'Panel did not fully converge or an agent errored.';

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
    metadata: { latencyMs },
  };

  const finding = {
    id: findingId,
    caseId,
    createdAt: nowIso(),
    crosscheckReportId: reportId,
    converged,
    summary: converged ? 'Converged' : 'Not converged',
    dissent,
    recommendation: converged ? 'Proceed with gates satisfied' : 'Escalate to Chair',
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

  // commit artifacts
  exec('git add projects/ai-irb/cases projects/ai-irb/crosschecks projects/ai-irb/findings', meshcoreDir);
  try {
    exec(`git commit -m "chore(ai-irb): open ${caseId}"`, meshcoreDir);
  } catch {
    // ignore
  }

  console.log(JSON.stringify({ caseId, reportId, findingId, converged, severity: irbCase.severity, latencyMs }, null, 2));

  if (irbCase.status === 'ESCALATED') process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
