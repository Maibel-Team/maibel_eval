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

test('all four route combinations override fixture extras and survive version storage', async () => {
  const originalFetch = global.fetch;
  try {
    for (const disable_p0 of [false,true]) for (const disable_p1 of [false,true]) {
      const config = {flash_model:'gemini-3.8-flash',disable_p0,disable_p1};
      global.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.disable_p0,disable_p0);
        assert.equal(body.disable_p1,disable_p1);
        return new Response(JSON.stringify({evren_responses:[1,2].map(()=>({response:['ok'],metrics:{...metrics,...config,route_controls_version:1}}))}));
      };
      const result = await callEvrenApiWithMeta('https://eval.example.test', {...tc,eval_context:{disable_p0:!disable_p0,disable_p1:!disable_p1}}, config.flash_model, config);
      const restored = normalizeVersionEntry(JSON.parse(JSON.stringify({version_id:'v',version_name:'test',eval_config:config,runs:[{run_id:'r',run_index:1,turns:result.outputs}]})));
      assert.deepEqual(restored.eval_config, config);
      assert.equal(restored.runs[0].turns[0].metrics.disable_p0,disable_p0);
    }
  } finally { global.fetch=originalFetch; }
});

test('missing or mismatched backend controls fail instead of silently running baseline', async () => {
  const originalFetch=global.fetch;
  try {
    for (const returned of [metrics,{...metrics,disable_p0:false,disable_p1:false,route_controls_version:1}]) {
      global.fetch=async()=>new Response(JSON.stringify({evren_responses:[1,2].map(()=>({response:['ok'],metrics:returned}))}));
      await assert.rejects(callEvrenApiWithMeta('https://eval.example.test',tc,'gemini-3.8-flash',{disable_p0:true,disable_p1:true}),/P0\/P1 configuration/);
    }
  } finally { global.fetch=originalFetch; }
});

test('API validation rejects truthy strings and nullable controls', () => {
  const {validRouteControls}=load('lib/evren-models.ts');
  assert.equal(validRouteControls({}),true);
  assert.equal(validRouteControls({disable_p0:true,disable_p1:false}),true);
  for (const value of ['false','true',1,null]) assert.equal(validRouteControls({disable_p0:value}),false);
});
