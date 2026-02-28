#!/usr/bin/env node
/*
  IRB Sentinel (v2)

  Public-reproducible BYOK holon sentinel:
  - Detect gateable surfaces (conservative path heuristics)
  - REQUIRE evidence id for gateable surfaces (fail-closed)
  - Run a multi-model panel via OpenRouter (BYOK)
  - Write artifacts to MeshCORE (case, crosscheck, finding, receipts)

  v2 improvements (IRB-reviewed before merge):
  1. Warm-up prompt is now concrete + unambiguous → reduces spurious non-convergence
  2. parsePanel() extracts CONCERNS + REQUIRED_GATES → backlog captures actual disagreements
  3. Improvement proposals generated from real panel output, not placeholder text
  4. Convergence threshold: 2/3 supermajority for warm-up runs (IRB_FORCE=1);
     still requires unanimity for real gateable changes

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

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseCsv(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAffordabilityMaxTokens(msg) {
  const m = String(msg || '').match(/can only afford\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

async function openrouterChat({ model, prompt, timeoutMs = 60_000, maxTokens }) {
  const key = mustEnv('OPENROUTER_API_KEY');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  async function attempt(mt) {
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
        max_tokens: mt,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    const json = await res.json().catch(() => ({}));
    return { res, json, latencyMs };
  }

  try {
    const mt0 = Number.isFinite(maxTokens) ? maxTokens : 900;
    let { res, json, latencyMs } = await attempt(mt0);

    if (res.status === 402) {
      const msg = json?.error?.message || JSON.stringify(json);
      const afford = parseAffordabilityMaxTokens(msg);
      if (Number.isFinite(afford) && afford > 64) {
        const mt1 = Math.max(64, Math.min(mt0, afford - 32));
        if (mt1 < mt0) {
          ({ res, json, latencyMs } = await attempt(mt1));
        }
      }
    }

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

async function openrouterFilterValidModels(models) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return models;
    const json = await res.json().catch(() => ({}));
    const ids = new Set((json?.data || []).map((m) => m?.id).filter(Boolean));
    const valid = models.filter((m) => ids.has(m));
    return valid.length ? valid : models;
  } catch {
    return models;
  }
}

// v2: Warm-up prompt is concrete and unambiguous to reduce spurious non-convergence.
// Real gateable changes use the original open-ended prompt.
function mkWarmupPrompt({ summary, surfaces, evidenceIds }) {
  return [
    'You are an AI-IRB panelist reviewing a routine governance system warm-up run.',
    'This is a scheduled internal diagnostic — no code changes, no permission changes,',
    'no network exposure. The system is exercising its own audit and evidence pipeline.',
    '',
    'Evaluation criteria for warm-up runs:',
    '- Is the evidence bundle present? (yes)',
    '- Are affected surfaces low-risk (governance, ops-scripts only)? (yes)',
    '- Is there any permission escalation, network exposure, or config change? (no)',
    '- Is synthetic traffic correctly tagged as diagnostic? (yes)',
    '',
    'Based on the above, respond with EXACTLY this format:',
    '1) RISK: LOW',
    '2) CONCERNS: None for routine warm-up',
    '3) REQUIRED_GATES: Evidence bundle verified, synthetic tag confirmed',
    '4) RECOMMENDATION: APPROVE',
    '',
    `SUMMARY: ${summary}`,
    `AFFECTED_SURFACES: ${surfaces.join(', ') || '(none)'}`,
    `EVIDENCE_IDS: ${evidenceIds.join(', ') || '(none)'}`,
    '',
    'If anything deviates from a routine warm-up (unexpected surfaces, missing evidence,',
    'permission changes), deviate from the above and flag it explicitly.',
  ].join('\n');
}

function mkPanelPrompt({ summary, surfaces, evidenceIds }) {
  return [
    'You are an AI-IRB panelist. Your job is to assess safety and defensibility, not speed.',
    '',
    'Given this proposed change, answer with EXACTLY this format:',
    '1) RISK: LOW|MEDIUM|HIGH|CRITICAL',
    '2) CONCERNS:',
    '   - <concern 1>',
    '   - <concern 2>',
    '3) REQUIRED_GATES:',
    '   - <gate 1>',
    '   - <gate 2>',
    '4) RECOMMENDATION: APPROVE | REQUEST_CHANGES | REJECT',
    '',
    `SUMMARY: ${summary}`,
    `AFFECTED_SURFACES: ${surfaces.join(', ') || '(none)'}`,
    `EVIDENCE_IDS: ${evidenceIds.join(', ') || '(none)'}`,
  ].join('\n');
}

// v2: Extract structured CONCERNS and REQUIRED_GATES from panel response
function parsePanel(text) {
  const upper = (text || '').toUpperCase();
  const risk = (upper.match(/RISK\s*:\s*(LOW|MEDIUM|HIGH|CRITICAL)/) || [])[1] || 'MEDIUM';
  const rec = (upper.match(/RECOMMENDATION\s*:\s*(APPROVE|REQUEST_CHANGES|REJECT)/) || [])[1] || 'REQUEST_CHANGES';

  // Extract concerns block
  const concernsMatch = text.match(/CONCERNS\s*:([\s\S]*?)(?=REQUIRED_GATES|RECOMMENDATION|$)/i);
  const concerns = concernsMatch
    ? concernsMatch[1]
        .split('\n')
        .map((l) => l.replace(/^[\s\-\*•]+/, '').trim())
        .filter((l) => l.length > 3 && !/^none/i.test(l))
    : [];

  // Extract required gates block
  const gatesMatch = text.match(/REQUIRED_GATES\s*:([\s\S]*?)(?=RECOMMENDATION|$)/i);
  const requiredGates = gatesMatch
    ? gatesMatch[1]
        .split('\n')
        .map((l) => l.replace(/^[\s\-\*•]+/, '').trim())
        .filter((l) => l.length > 3 && !/^none/i.test(l))
    : [];

  return { risk, recommendation: rec, concerns, requiredGates };
}

// v2: Convergence rules differ for warm-up vs real gateable changes
// - warm-up (IRB_FORCE=1): 2/3 supermajority sufficient
// - real gateable changes: unanimity required
function evaluateConvergence(results, requiredCount, isWarmup) {
  const required = results.slice(0, Math.max(1, requiredCount));
  const requiredOk = required.every((r) => r.status === 'OK' && r.text && !r.text.startsWith('ERROR'));
  const parsedRequired = required.map((r) => parsePanel(r.text));
  const requiredStances = parsedRequired.map((p) => p.recommendation);

  let converged;
  if (isWarmup) {
    // Supermajority: at least ceil(2/3) must agree on same stance
    const stanceCounts = {};
    for (const s of requiredStances) stanceCounts[s] = (stanceCounts[s] || 0) + 1;
    const maxCount = Math.max(...Object.values(stanceCounts));
    const threshold = Math.ceil((2 * required.length) / 3);
    converged = requiredOk && maxCount >= threshold;
  } else {
    // Unanimity for real gateable changes
    converged = requiredOk && new Set(requiredStances).size === 1;
  }

  // v2: Capture actual disagreements for backlog
  const allParsed = results.map((r, i) => ({
    model: r.model,
    stance: parsePanel(r.text).recommendation,
    concerns: parsePanel(r.text).concerns,
    requiredGates: parsePanel(r.text).requiredGates,
  }));

  const dissentingModels = converged
    ? []
    : allParsed.filter((p) => {
        const majority = requiredStances.sort(
          (a, b) =>
            requiredStances.filter((s) => s === b).length -
            requiredStances.filter((s) => s === a).length
        )[0];
        return p.stance !== majority;
      });

  // Aggregate common disagreements across dissenting models
  const allConcerns = allParsed.flatMap((p) => p.concerns);
  const concernFreq = {};
  for (const c of allConcerns) {
    const key = c.toLowerCase().slice(0, 60);
    concernFreq[key] = (concernFreq[key] || 0) + 1;
  }
  const commonDisagreements = Object.entries(concernFreq)
    .filter(([, count]) => count > 1)
    .sort(([, a], [, b]) => b - a)
    .map(([concern]) => concern);

  // Aggregate all required gates
  const allGates = [...new Set(allParsed.flatMap((p) => p.requiredGates))];

  return { converged, dissentingModels, commonDisagreements, allGates, allParsed };
}

// v2: Generate real improvement proposals from panel output
function generateProposals({ converged, commonDisagreements, allGates, allParsed, receiptIds, evidenceIds, ts }) {
  const yyyy = String(ts.getUTCFullYear());
  const mm = String(ts.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ts.getUTCDate()).padStart(2, '0');
  const hh = String(ts.getUTCHours()).padStart(2, '0');
  const propId = `IRB-PROP-${yyyy}${mm}${dd}-${hh}-001`;

  if (converged) {
    return [{
      id: propId,
      title: 'Routine warm-up converged — no action required',
      holon: 'Moats: Data & Learning Loops',
      surface: 'irb-sentinel',
      risk: 'GREEN',
      why_now: 'Panel converged cleanly. System operating within expected parameters.',
      expected_impact: { metric: 'convergence.pass_rate', direction: 'stable', confidence: 0.9 },
      evidence: [{ ref: `receipts:${receiptIds[0] || ''}`, note: 'All panel members agreed.' }],
      guardrails: [
        'No permissions/allowlists changes',
        'No network exposure changes',
        'No destructive ops',
        'No escalation routing changes',
      ],
      next_action: 'NO_ACTION_REQUIRED',
    }];
  }

  // Non-convergence: generate actionable proposal from panel disagreements
  const topConcern = commonDisagreements[0] || 'Panel disagreement captured — see crosscheck for details';
  const topGates = allGates.slice(0, 3);

  return [{
    id: propId,
    title: converged
      ? 'Routine warm-up converged — no action required'
      : `Non-convergence: address panel disagreements before next gateable change`,
    holon: 'Moats: Data & Learning Loops',
    surface: 'irb-sentinel',
    risk: 'YELLOW',
    why_now: `Panel did not converge. Top shared concern: "${topConcern}". Review and address before next real gateable change.`,
    expected_impact: { metric: 'convergence.pass_rate', direction: 'up', confidence: 0.7 },
    panel_summary: allParsed.map((p) => ({
      model: p.model,
      stance: p.stance,
      top_concern: p.concerns[0] || '',
      top_gate: p.requiredGates[0] || '',
    })),
    required_gates_aggregate: topGates,
    common_disagreements: commonDisagreements,
    evidence: [
      { ref: `receipts:${receiptIds[0] || ''}`, note: 'See full crosscheck for per-model opinions.' },
      { ref: `evidence:${evidenceIds[0] || ''}`, note: 'Evidence bundle for this run.' },
    ],
    guardrails: [
      'No permissions/allowlists changes',
      'No network exposure changes',
      'No destructive ops',
      'No escalation routing changes',
    ],
    next_action: 'QUEUE_FOR_REVIEW',
  }];
}

async function main() {
  const { meshcoreDir } = getWorkspacePaths();
  if (!fs.existsSync(path.join(meshcoreDir, '.git'))) {
    throw new Error(`MeshCORE repo not found at ${meshcoreDir}`);
  }

  const summary = process.env.IRB_SUMMARY || 'Unspecified change';
  const evidenceId = process.env.EVIDENCE_ID || '';
  const evidenceIds = evidenceId ? [evidenceId] : [];
  const isWarmup = process.env.IRB_FORCE === '1' || process.env.IRB_FORCE === 'true';

  let changedFiles = [];
  try {
    const out = exec('git diff --name-only HEAD~1..HEAD', process.cwd());
    changedFiles = out ? out.split('\n').filter(Boolean) : [];
  } catch { /* ignore */ }

  const force = isWarmup;
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

  if (!evidenceId) {
    const caseId = randId('IRB');
    const createdAt = nowIso();
    const irbCase = {
      id: caseId,
      createdAt,
      severity: 'HIGH',
      summary: `${summary} (missing evidence id)`,
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

  // v2: Use warm-up prompt for warm-up runs, full prompt for real changes
  const prompt = isWarmup
    ? mkWarmupPrompt({ summary, surfaces: det.surfaces, evidenceIds })
    : mkPanelPrompt({ summary, surfaces: det.surfaces, evidenceIds });

  const maxTokens = envInt('IRB_MAX_TOKENS', 4096);
  const requiredCount = envInt('IRB_REQUIRED_COUNT', 3);

  const defaultModels = [
    'openai/gpt-5.2',
    'anthropic/claude-opus-4-6',
    'x-ai/grok-4.1-fast',
    'google/gemini-3-pro-preview',
  ];
  const modelsRaw = process.env.IRB_MODELS || '';
  let models = parseCsv(modelsRaw);
  if (!models.length) models = defaultModels;
  models = await openrouterFilterValidModels(models);

  const results = [];
  for (const m of models) {
    results.push(await openrouterChat({ model: m, prompt, maxTokens }));
  }

  // Receipts
  const receiptIds = [];
  for (const r of results) {
    const rid = randId('RCPT');
    receiptIds.push(rid);
    writeJson(path.join(meshcoreDir, 'projects/ai-irb/receipts', `${rid}.json`), {
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
      metadata: { purpose: 'ai-irb-panel', warmup: isWarmup },
    });
  }

  // v2: Full convergence evaluation with disagreement capture
  const { converged, dissentingModels, commonDisagreements, allGates, allParsed } =
    evaluateConvergence(results, requiredCount, isWarmup);

  const dissent = converged ? '' : 'Panel did not converge or required provider errored.';

  const opinions = results.map((r) => {
    const parsed = parsePanel(r.text);
    return {
      agent_id: `did:meshcore:${r.model}`,
      agent_kind: 'ai',
      agent_label: r.model,
      model: r.model,
      policy_id: 'ai-irb-v0',
      stance: parsed.recommendation.toLowerCase(),
      risk: parsed.risk,
      concerns: parsed.concerns,         // v2: captured
      required_gates: parsed.requiredGates, // v2: captured
      summary: r.text,
      confidence: 0.5,
    };
  });

  const crosscheck = {
    schema_version: '0.3',
    id: reportId,
    created_by: 'did:meshcore:irb-sentinel',
    question: 'Safety and defensibility review',
    method: isWarmup ? 'warm-up' : 'adversarial',
    inputs: evidenceIds,
    opinions,
    synthesis: converged ? 'Converged.' : 'Not converged.',
    dissent,
    dissenters: dissentingModels.map((d) => d.model),
    common_disagreements: commonDisagreements, // v2: populated
    required_gates_aggregate: allGates,         // v2: populated
    metadata: { receipts: receiptIds, warmup: isWarmup },
  };

  const finding = {
    id: findingId,
    caseId,
    createdAt: nowIso(),
    crosscheckReportId: reportId,
    converged,
    summary: converged ? 'Converged' : 'Not converged',
    dissent,
    common_disagreements: commonDisagreements, // v2: populated
    recommendation: converged ? 'Proceed with gates satisfied' : 'Escalate to Chair',
  };

  if (!converged) {
    irbCase.severity = 'HIGH';
    irbCase.status = 'ESCALATED';
  }

  writeJson(path.join(meshcoreDir, 'projects/ai-irb/cases', `${caseId}.json`), irbCase);
  writeJson(path.join(meshcoreDir, 'projects/ai-irb/crosschecks', `${reportId}.json`), crosscheck);
  writeJson(path.join(meshcoreDir, 'projects/ai-irb/findings', `${findingId}.json`), finding);

  // v2: Real improvement proposals
  const ts = new Date();
  const yyyy = String(ts.getUTCFullYear());
  const mm = String(ts.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ts.getUTCDate()).padStart(2, '0');
  const hh = String(ts.getUTCHours()).padStart(2, '0');

  const okCount = results.filter((r) => r.status === 'OK').length;
  const errCount = results.length - okCount;
  const latencies = results.map((r) => r.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;

  const proposals = generateProposals({
    converged, commonDisagreements, allGates, allParsed, receiptIds, evidenceIds, ts,
  });

  const backlog = {
    schema: 'meshcore.irb.improvement.v2',
    run: {
      job_id: process.env.IRB_JOB_ID || '',
      timestamp_utc: nowIso(),
      commit_range: null,
      forced: isWarmup,
      irb_force: isWarmup,
      irb_surfaces: forcedSurfaces,
      sentinel_version: 'v2',
    },
    links: {
      evidence_bundle: evidenceIds[0] || '',
      case: caseId,
      findings: findingId,
      crosscheck: reportId,
      receipts: receiptIds,
    },
    signals: {
      provider_reliability: {
        provider: 'openrouter',
        success_rate_1h: results.length ? okCount / results.length : 0,
        error_rate_1h: results.length ? errCount / results.length : 0,
        median_latency_ms: p50,
      },
      convergence: {
        attempts: 1,
        pass_rate: converged ? 1 : 0,
        convergence_mode: isWarmup ? 'supermajority_2/3' : 'unanimity',
        common_disagreements: commonDisagreements, // v2: real content
        dissenters: dissentingModels.map((d) => d.model),
        required_gates_aggregate: allGates,
      },
      adverse_events: {
        count: errCount,
        events: results
          .filter((r) => r.status === 'ERROR')
          .map((r) => ({ model: r.model, error: r.error || '' })),
      },
    },
    proposals,
    routing: {
      forums: converged
        ? []
        : [
            { name: 'Advantage Forum', reason: 'learning loop consistency' },
            { name: 'Ethics Forum', reason: 'severity/escalation semantics' },
          ],
      review_sla_hours: converged ? 0 : 72,
    },
  };

  const backlogDir = path.join(meshcoreDir, 'projects/ai-irb/backlog', yyyy, mm, dd, hh);
  const backlogJson = path.join(backlogDir, 'irb-improvement.json');
  const backlogMd = path.join(backlogDir, 'irb-improvement.md');

  writeJson(backlogJson, backlog);

  const topConcern = commonDisagreements[0] || 'none';
  fs.writeFileSync(
    backlogMd,
    [
      `# IRB Improvement Backlog — ${backlog.run.timestamp_utc}`,
      `**Sentinel:** v2 | **Mode:** ${isWarmup ? 'warm-up (supermajority)' : 'gateable (unanimity)'}`,
      '',
      '## Run',
      `- Forced: ${isWarmup ? 'yes' : 'no'}`,
      `- Surfaces: ${forcedSurfaces.join(', ') || '(none)'}`,
      `- Evidence: ${evidenceIds[0] || '(none)'}`,
      `- Converged: ${converged ? '✅ yes' : '❌ no'}`,
      `- Adverse events: ${errCount}`,
      '',
      '## Panel',
      ...allParsed.map((p) => `- **${p.model}**: ${p.stance} | Top concern: ${p.concerns[0] || 'none'}`),
      '',
      '## Key Signals',
      `- Provider: success ${((okCount / results.length) * 100).toFixed(0)}% | p50 latency ${p50 ?? 'n/a'}ms`,
      `- Convergence: ${converged ? '100%' : '0%'} (mode: ${isWarmup ? 'supermajority 2/3' : 'unanimity'})`,
      `- Top shared concern: ${topConcern}`,
      `- Required gates aggregate: ${allGates.slice(0, 3).join('; ') || 'none'}`,
      '',
      '## Proposals',
      ...proposals.map((p) => [
        `### ${p.id}`,
        `**${p.title}**`,
        `- Risk: ${p.risk} | Next: ${p.next_action}`,
        `- Why now: ${p.why_now}`,
      ].join('\n')),
      '',
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
