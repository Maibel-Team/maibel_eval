const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
function load(relative) {
  const filename = path.resolve(relative);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  mod._compile(compiled, filename);
  return mod.exports;
}
const { callEvrenApiWithMeta } = load('lib/evren.ts');
const { normalizeVersionEntry } = load('lib/db.types.ts');
const tc = { type: 'multi_turn', turns: ['hello', 'quieter'], eval_context: { flash_model: 'wrong' } };
const metrics = { flash_model: 'gemini-3.8-flash', total_tokens: 87, reasoning_tokens: 80 };
test('selected model reaches backend and per-turn usage survives normalization', async () => {
  const originalFetch = global.fetch;
  let body;
  global.fetch = async (url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ evren_responses: [1,2].map(() => ({response:['hello'],metrics})), code_source: 'auto-eval @ test', eval_user_id:'synthetic' }));
  };
  try {
    const result = await callEvrenApiWithMeta('https://eval.example.test', tc, 'gemini-3.8-flash');
    assert.equal(body.flash_model, 'gemini-3.8-flash');
    assert.deepEqual(body.messages, tc.turns);
    assert.equal(result.outputs[0].metrics.reasoning_tokens,80);
    const run = {run_id:'r',run_index:1,turns:result.outputs.map(o=>({response:o.evren_response,metrics:o.metrics})),code_source:result.codeSource.text,eval_user_id:result.evalUserId,request_duration_seconds:result.requestDurationSeconds};
    const restored = normalizeVersionEntry(JSON.parse(JSON.stringify({version_id:'v',version_name:'candidate',runs:[run],run_count_requested:1,evidence_source:'automated'})));
    assert.deepEqual(restored.runs[0],run);
  } finally { global.fetch = originalFetch; }
});
test('old or incomplete backend response cannot masquerade as candidate run', async () => {
  const originalFetch = global.fetch;
  try {
    for (const responses of [[{response:['old']},{response:['old']}],[],[{response:['partial'],metrics}]]) {
      global.fetch = async () => new Response(JSON.stringify({evren_responses:responses}));
      await assert.rejects(callEvrenApiWithMeta('https://eval.example.test',tc,'gemini-3.8-flash'));
    }
  } finally { global.fetch = originalFetch; }
});
