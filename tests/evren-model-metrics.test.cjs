const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (mod, filename) => {
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, filename);
};
const { callEvrenApiWithMeta } = require('../lib/evren.ts');
const { normalizeVersionEntry } = require('../lib/db.types.ts');
const { readRoutePolicy, formatRoutePolicy, formatVersionRoutePolicy, formatDisabledDetectionNote } = require('../lib/evren-route-policy.ts');
const tc = { type: 'multi_turn', turns: ['hello', 'quieter'], eval_context: { flash_model: 'wrong', disable_p0: true, disable_p1: 'true', memory_context: 'fixture' } };
const base = { flash_model: 'gemini-3.8-flash', total_tokens: 87, reasoning_tokens: 80 };
const legacy = { ...base, route_controls_version: 1, disable_p0: false, disable_p1: false };
const policy = (p0 = false, p1 = false) => ({ ...base, route_controls_version: 2,
  global_p0_enabled: p0, global_p1_enabled: p1, requested_disable_p0: false,
  requested_disable_p1: false, disable_p0: !p0, disable_p1: !p1 });
const version = (metrics, eval_config) => ({ version_id: 'v', version_name: 'candidate', eval_config,
  run_count_requested: 1, evidence_source: 'automated', comparison_basis_run_index: 1,
  runs: [{ run_id: 'r', run_index: 1, turns: metrics.map(m => ({ response: ['ok'], detected_flags: '', metrics: m })) }] });
async function withResponse(responses, check) {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    if (check) check(JSON.parse(options.body));
    return new Response(JSON.stringify({ evren_responses: responses, code_source: 'auto-eval @ test', eval_user_id: 'synthetic' }));
  };
  try { return await callEvrenApiWithMeta('https://eval.example.test', tc, 'gemini-3.8-flash'); }
  finally { global.fetch = originalFetch; }
}
const responses = (metrics) => [1, 2].map(() => ({ response: ['hello'], metrics }));

test('server policy request strips fixture switches and preserves full recorded evidence', async () => {
  const trace = { primary_agent: 'emotional_state', active_gates: ['p2_mission_rejection'], verifier_confidence: 0.8 };
  const rawFlags = '- safety_level = safe\n- emotional_category = regulated';
  const result = await withResponse(responses(policy()).map(r => ({ ...r, route_trace: trace, detected_flags: rawFlags })), body => {
    assert.equal(body.flash_model, 'gemini-3.8-flash');
    assert.deepEqual(body.messages, tc.turns);
    assert.equal(body.memory_context, 'fixture');
    assert.equal('disable_p0' in body, false);
    assert.equal('disable_p1' in body, false);
  });
  const run = { run_id: 'r', run_index: 1, turns: result.outputs.map(o => ({ response: o.evren_response,
    detected_flags: o.detected_states, route_trace: o.route_trace, metrics: o.metrics })),
    code_source: result.codeSource.text, eval_user_id: result.evalUserId, request_duration_seconds: result.requestDurationSeconds };
  const config = { flash_model: base.flash_model, route_policy: 'server' };
  const restored = normalizeVersionEntry(JSON.parse(JSON.stringify({ ...version([], config), runs: [run] })));
  assert.deepEqual(restored.runs[0], run);
  assert.deepEqual(restored.eval_config, config);
  assert.equal(restored.runs[0].turns[0].detected_flags, rawFlags);
  assert.deepEqual(restored.runs[0].turns[0].route_trace, trace);
  assert.equal(formatVersionRoutePolicy(restored), 'Actual P0: disabled · P1: disabled');
});

test('accepts legacy v1 and server v2 effective settings for all route combinations', async () => {
  for (const p0 of [false, true]) for (const p1 of [false, true]) {
    for (const metrics of [{ ...legacy, disable_p0: p0, disable_p1: p1 }, policy(p0, p1)]) {
      const result = await withResponse(responses(metrics));
      assert.deepEqual(result.outputs[0].metrics, metrics);
      assert.equal(readRoutePolicy(metrics).disableP0, metrics.disable_p0);
      assert.equal(readRoutePolicy(metrics).disableP1, metrics.disable_p1);
    }
  }
});

test('rejects unknown, inconsistent or malformed reported routing metadata on any turn', async () => {
  const invalid = [{ ...legacy, route_controls_version: 3 }, { ...legacy, disable_p0: 'false' },
    { ...policy(), global_p0_enabled: undefined }, { ...policy(), requested_disable_p1: undefined },
    { ...policy(), global_p1_enabled: 'false' }, { ...policy(), disable_p0: false },
    { ...policy(), requested_disable_p0: true }];
  for (const metrics of invalid) {
    await assert.rejects(withResponse([{ response: ['ok'], metrics: policy() }, { response: ['bad'], metrics }]), /routing settings/);
  }
});

test('still rejects model mismatch and incomplete conversation', async () => {
  for (const items of [[], [{ response: ['partial'], metrics: policy() }],
    responses({ ...policy(), flash_model: 'gemini-2.5-flash' }), [{ response: ['old'] }, { response: ['old'] }]]) {
    await assert.rejects(withResponse(items));
  }
});

test('historical requested flags remain distinct from actual settings and are not rewritten', () => {
  const old = version([null], { flash_model: base.flash_model, disable_p0: false, disable_p1: true });
  const restored = normalizeVersionEntry(JSON.parse(JSON.stringify(old)));
  assert.equal(formatVersionRoutePolicy(restored), 'Requested P0: enabled · P1: disabled (actual settings not reported)');
  assert.deepEqual(restored.eval_config, old.eval_config);
  assert.deepEqual(restored.runs[0].turns, old.runs[0].turns);
  assert.equal(formatVersionRoutePolicy(version([policy()], old.eval_config)), 'Actual P0: disabled · P1: disabled');
});

test('missing, partial and changing policy never becomes an invented enabled/disabled summary', () => {
  assert.equal(formatRoutePolicy(null), null);
  assert.equal(formatRoutePolicy({ route_controls_version: 2 }), null);
  assert.equal(formatVersionRoutePolicy(version([null])), 'Routing: not reported');
  assert.equal(formatVersionRoutePolicy(version([], { flash_model: base.flash_model, route_policy: 'server' })), 'Routing: server controlled (actual settings not reported)');
  assert.equal(formatVersionRoutePolicy(version([policy(), null])), 'Routing: partially recorded; see turn details');
  assert.equal(formatVersionRoutePolicy(version([policy(), policy(true, false)])), 'Routing varies by turn');
});

test('disabled-detection explanation depends on saved evidence, not current server assumptions', () => {
  assert.equal(formatDisabledDetectionNote(legacy), null);
  assert.equal(formatDisabledDetectionNote(null), null);
  assert.match(formatDisabledDetectionNote(policy()), /^P0\/P1 detection was disabled/);
  assert.match(formatDisabledDetectionNote(policy(true, false)), /^P1 detection was disabled/);
  assert.match(formatDisabledDetectionNote(policy(false, true)), /^P0 detection was disabled/);
  assert.equal(formatDisabledDetectionNote(policy(true, true)), null);
  const historical = { ...policy(true, true), requested_disable_p0: true, disable_p0: true };
  assert.equal(formatRoutePolicy(historical), 'Actual P0: disabled · P1: enabled');
});


test('missing optional route and flag evidence does not block complete replies', async () => {
  const result = await withResponse(responses(base));
  assert.equal(result.outputs.length, 2);
  assert.deepEqual(result.outputs[0].evren_response, ['hello']);
  assert.equal(result.outputs[0].route_trace, null);
  assert.equal(result.outputs[0].detected_states, '');
  assert.equal(formatVersionRoutePolicy(version([base, base])), 'Routing: not reported');
});
