'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const adapter = require('../scripts/lib/adapter');

const isWin = process.platform === 'win32';
// 用一个必然存在的命令充当「已安装的 CLI」，让探测结果与开发机装了什么无关
const FAKE_BIN = isWin ? 'cmd.exe' : '/bin/echo';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pipeline-adapter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function poolCfg(t, extra = {}) {
  const stateFile = path.join(tempRoot(t), 'cli-rotation.json');
  const cfg = adapter.loadCliConfig(ROOT, null, Object.assign({
    autoDetect: ['alpha', 'alias', 'beta', 'claude'],
    hostCommands: {
      alpha: { commands: [], env: 'AP_TEST_ALPHA', adapter: 'codebuddy', configDir: '.alpha' },
      alias: { commands: [], env: 'AP_TEST_ALPHA', adapter: 'codebuddy', configDir: '.alpha' },
      beta: { commands: [], env: 'AP_TEST_BETA', adapter: 'plain', configDir: '.beta' },
    },
    rotation: { enabled: true, stateFile },
  }, extra));
  for (const [key, value] of Object.entries({
    AP_TEST_ALPHA: FAKE_BIN,
    AP_TEST_BETA: FAKE_BIN,
    CLAUDE_CLI_CMD: FAKE_BIN,
  })) {
    const prev = process.env[key];
    process.env[key] = value;
    t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev; });
  }
  for (const key of ['AGENT_PIPELINE_HOST', 'AGENT_PIPELINE_ADAPTER', 'CODEX_CLI_CMD', 'AP_TEST_CLAUDE']) {
    const prev = process.env[key];
    delete process.env[key];
    t.after(() => { if (prev !== undefined) process.env[key] = prev; });
  }
  return { cfg, stateFile };
}

test('宿主池包含全部已装 CLI，别名折叠为一位', (t) => {
  const { cfg } = poolCfg(t);
  const pool = adapter.detectHosts(cfg);
  assert.deepEqual(pool.map((h) => h.key), ['alpha', 'beta', 'claude']);
  assert.deepEqual(pool.map((h) => h.adapter), ['codebuddy', 'plain', 'claude']);
});

test('未安装的 CLI 不入池；池空时不抛异常', (t) => {
  const { cfg } = poolCfg(t);
  delete process.env.AP_TEST_ALPHA;
  delete process.env.AP_TEST_BETA;
  delete process.env.CLAUDE_CLI_CMD;
  assert.deepEqual(adapter.detectHosts(cfg), []);
  const picked = adapter.pickHost(cfg, []);
  assert.equal(picked.host, null);
  assert.equal(picked.index, -1);
});

test('轮询按池序推进并把游标落到文件', (t) => {
  const { cfg, stateFile } = poolCfg(t);
  const pool = adapter.detectHosts(cfg);
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(adapter.pickHost(cfg, pool).host.key);
  assert.deepEqual(seq, ['alpha', 'beta', 'claude', 'alpha']);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.cursor, 1);
  assert.equal(state.lastKey, 'alpha');
  assert.deepEqual(state.uses, { alpha: 2, beta: 1, claude: 1 });
});

test('关闭轮询或只剩一个 CLI 时固定用首位，且不写游标', (t) => {
  const off = poolCfg(t, { rotation: { enabled: false } });
  const pool = adapter.detectHosts(off.cfg);
  assert.equal(adapter.pickHost(off.cfg, pool).host.key, 'alpha');
  assert.equal(adapter.pickHost(off.cfg, pool).host.key, 'alpha');
  assert.equal(fs.existsSync(off.stateFile), false);

  const single = adapter.detectHosts(off.cfg);
  assert.equal(adapter.pickHost(off.cfg, single.slice(0, 1)).rotated, false);
});

test('游标文件损坏时退回池首，不影响运行', (t) => {
  const { cfg, stateFile } = poolCfg(t);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, 'not json at all');
  const picked = adapter.pickHost(cfg, adapter.detectHosts(cfg));
  assert.equal(picked.host.key, 'alpha');
});

test('显式指定宿主时不参与轮询', (t) => {
  const { cfg } = poolCfg(t);
  process.env.AGENT_PIPELINE_HOST = 'beta';
  t.after(() => { delete process.env.AGENT_PIPELINE_HOST; });
  const runner = adapter.createRunner(cfg);
  assert.equal(runner.name, 'plain');
  assert.equal(runner.rotation.rotated, false);
  assert.equal(runner.rotation.reason, 'explicit-host');
});

test('显式指定方言时取池中同方言首位，不参与轮询', (t) => {
  const { cfg } = poolCfg(t, { adapter: 'codebuddy' });
  const runner = adapter.createRunner(cfg);
  assert.equal(runner.name, 'codebuddy');
  assert.equal(runner.rotation.rotated, false);
  assert.equal(runner.rotation.reason, 'explicit-adapter');
});

test('自动模式连续两次 createRunner 会换到不同宿主', (t) => {
  const { cfg } = poolCfg(t);
  const first = adapter.createRunner(cfg);
  const second = adapter.createRunner(cfg);
  assert.equal(first.name, 'codebuddy');
  assert.equal(second.name, 'plain');
  assert.equal(second.rotation.index, 1);
  assert.equal(second.rotation.reason, 'round-robin');
});

test('未知宿主名降级为轮询并留下可打印的警告', (t) => {
  const { cfg } = poolCfg(t);
  process.env.AGENT_PIPELINE_HOST = 'nonexistent-ide';
  t.after(() => { delete process.env.AGENT_PIPELINE_HOST; });
  const runner = adapter.createRunner(cfg);
  assert.equal(runner.rotation.reason, 'round-robin');
  assert.match(cfg.hostWarning, /nonexistent-ide 不是已知宿主/);
});

test('超时、限额、模型不可用、连接异常都算可切换失败', () => {
  const cases = [
    [{ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGTERM' }, '', 'timeout'],
    [{ status: null, signal: 'SIGTERM' }, '', 'timeout'],
    [{ status: 1 }, 'HTTP 429 Too Many Requests', 'quota'],
    [{ status: 1 }, '该模型额度不足', 'quota'],
    [{ status: 1 }, 'Model "custom-local:x" not found', 'model-unavailable'],
    [{ status: 1 }, 'status: 503 service unavailable', 'model-unavailable'],
    [{ status: 1 }, 'connect ECONNREFUSED 127.0.0.1:443', 'connection'],
  ];
  for (const [result, stderr, expected] of cases) {
    assert.equal(adapter.classifyFailure(result, adapter.failureText(stderr, '')), expected, stderr || 'spawn 超时');
    assert.ok(adapter.FAILURE_LABELS[expected]);
  }
});

test('CLI 本身不可用与人为中断不触发切换', () => {
  assert.equal(adapter.classifyFailure({ error: { code: 'ENOENT' }, status: null }, ''), null);
  assert.equal(adapter.classifyFailure({ status: null, signal: 'SIGINT' }, ''), null);
  assert.equal(adapter.classifyFailure({ status: 1 }, '阶段产物写到一半被截断'), null);
});

test('失败文本以 stderr 优先，长 stdout 视为角色产物不参与判定', () => {
  assert.equal(adapter.failureText('quota exceeded', '产物里也提到 quota'), 'quota exceeded');
  assert.equal(adapter.failureText('', 'error: timed out'), 'error: timed out');
  assert.equal(adapter.failureText('', 'x'.repeat(2000)), '');
  // 角色产物里的 setTimeout / 500 条记录不应被当成 CLI 故障
  assert.equal(adapter.classifyFailure({ status: 1 }, adapter.failureText('', '建议把 setTimeout 改成 debounce，共 500 条')), null);
});

// ---------- 编排层集成：轮询可见性与超时/限额换候选 ----------
// codebuddy/plain 方言都要求「一个可执行文件名」，因此用 shebang 包装 node + stub.js；
// 集成用例走无 projectManager 的旧配置，让阶段能连续跑下去。
function integrationHarness(t) {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.codebuddy'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codebuddy', 'models.json'), JSON.stringify({
    models: [{ id: 'bad' }, { id: 'good' }],
  }));
  const stub = path.join(root, 'stub.js');
  fs.writeFileSync(stub, `#!/usr/bin/env node
'use strict';
if (process.argv.includes('--version')) { console.log('stub 1.0.0'); process.exit(0); }
const failsOn = process.env.STUB_FAILS_ON || '';
if (failsOn && process.argv.includes(failsOn)) {
  if (process.env.STUB_HANG === '1') setInterval(() => {}, 1000); // 保活不退出，等编排层超时杀进程
  else { process.stderr.write((process.env.STUB_ERROR || 'HTTP 429 Too Many Requests') + '\\n'); process.exit(1); }
  return;
}
console.log('# 阶段产物\\n\\n完成。');
process.exit(0);
`);
  const wrapper = path.join(root, 'stub.sh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const cliConfig = path.join(root, 'cli.json');
  fs.writeFileSync(cliConfig, JSON.stringify({
    adapter: 'auto',
    autoDetect: ['alpha', 'beta'],
    timeoutMs: 60000,
    modelAttemptTimeoutMs: 3000,
    hostCommands: {
      alpha: { commands: [], env: 'STUB_ALPHA', adapter: 'codebuddy', configDir: '.codebuddy' },
      beta: { commands: [], env: 'STUB_BETA', adapter: 'plain', configDir: '.beta' },
    },
    rotation: { enabled: true, stateFile: 'cli-rotation.json' },
  }));
  const legacy = path.join(root, 'pipeline-legacy.json');
  const pipeline = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'pipeline.json'), 'utf8'));
  delete pipeline.projectManager;
  fs.writeFileSync(legacy, JSON.stringify(pipeline, null, 2));
  const projectDir = path.join(root, 'project');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  function run(extraArgs = [], env = {}, input = 'y\ny\ny\n') {
    return spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'run-pipeline.js'),
      '--project-name', 'demo',
      '--project-dir', projectDir,
      '--work-dir', workDir,
      '--requirement', '测试需求',
      '--cli-config', cliConfig,
      '--pipeline-config', legacy,
      '--interactive',
      '--no-memory', '--no-knowledge', '--no-delegate',
      ...extraArgs,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      env: Object.assign({}, process.env, {
        STUB_ALPHA: wrapper,
        STUB_BETA: wrapper,
        HOME: home,
        USERPROFILE: home,
        AGENT_PIPELINE_HOST: '',
        AGENT_PIPELINE_ADAPTER: '',
      }, env),
      timeout: 120000,
    });
  }
  return { root, workDir, run };
}

const posixOnly = isWin ? '需要 shebang 包装的可执行文件' : false;

test('演练日志打印轮询池与位次，两次运行换不同宿主', { skip: posixOnly }, (t) => {
  const h = integrationHarness(t);
  const first = h.run(['--dry-run', '--to', '01-product-plan']);
  const second = h.run(['--dry-run', '--to', '01-product-plan']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /宿主 CLI 轮询：本机池 \[alpha, beta\] → 本次 alpha（第 1\/2）/);
  assert.match(second.stdout, /本次 beta（第 2\/2）/);
  assert.match(second.stdout, /模型=CLI自带/);
  assert.equal(fs.existsSync(path.join(h.workDir, 'cli-rotation.json')), true);
});

test('自定义模型限额失败自动切候选，且坏模型在后续阶段沉底', { skip: posixOnly }, (t) => {
  const h = integrationHarness(t);
  const result = h.run(['--adapter', 'codebuddy', '--to', '03-architecture'], {
    STUB_FAILS_ON: 'custom-local:bad',
  });
  assert.match(result.stdout, /模型=custom-local:bad，CLI回退=custom-local:good，超时=3s/);
  assert.match(result.stdout, /执行失败：exit=1 signal=-（限额\/过载）/);
  assert.match(result.stdout, /模型 custom-local:bad 限额\/过载，自动切换候选 → custom-local:good/);
  const afterStageOne = result.stdout.slice(result.stdout.indexOf('[02-requirements]'));
  assert.match(afterStageOne, /\[02-requirements\][^\n]*模型=custom-local:good/);
  assert.ok(!/\[02-requirements\][^\n]*模型=custom-local:bad/.test(afterStageOne), '后续阶段不应再把已知坏模型排在首位');
});

test('命名模型按 modelAttemptTimeoutMs 截断并切换，不拖满整阶段预算', { skip: posixOnly }, (t) => {
  const h = integrationHarness(t);
  const started = Date.now();
  const result = h.run(['--adapter', 'codebuddy', '--to', '02-requirements'], {
    STUB_FAILS_ON: 'custom-local:bad',
    STUB_HANG: '1',
  });
  const elapsed = Date.now() - started;
  assert.match(result.stdout, /超时=3s/);
  assert.match(result.stdout, /执行失败：exit=null signal=SIGTERM（超时）/);
  assert.match(result.stdout, /模型 custom-local:bad 超时，自动切换候选 → custom-local:good/);
  assert.ok(elapsed < 25000, `应在模型尝试上限内切换，实际耗时 ${elapsed}ms`);
});
