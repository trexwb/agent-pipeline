'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const protocol = require('../scripts/lib/manager-protocol');
const router = require('../scripts/lib/manager-router');

function reportBlock(report = {}) {
  const value = Object.assign({
    status: 'done',
    summary: '完成',
    completedTasks: ['T1'],
    evidence: ['node --check 通过'],
    issues: [],
    unverified: [],
    decisionsNeeded: [],
  }, report);
  return `===== REPORT =====\n${JSON.stringify(value, null, 2)}\n===== REPORT END =====`;
}

function workOrder() {
  return {
    objective: '完成目标阶段',
    requiredChanges: ['完成任务'],
    acceptanceChecks: ['证据可复现'],
    constraints: ['不跳过阶段'],
    outOfScope: ['无关重构'],
  };
}

function decisionBlock(decision) {
  return `===== DECISION =====\n${JSON.stringify(decision, null, 2)}\n===== DECISION END =====`;
}

const stages = [
  { id: '01', output: 'artifacts/01.md' },
  { id: '02', output: 'artifacts/02.md' },
  { id: '03', output: 'artifacts/03.md' },
];

function reviewContext(overrides = {}) {
  return Object.assign({
    mode: 'review',
    currentStageId: '02',
    targetStageId: '02',
    nextStageId: '03',
    isFinalFull: false,
    stages,
    report: { status: 'done' },
  }, overrides);
}

test('REPORT 被剥离并通过 schema 校验', () => {
  const parsed = protocol.parseSpecialistReport(`# 报告\n\n正文\n\n${reportBlock()}`);
  assert.equal(parsed.report.status, 'done');
  assert.ok(!parsed.body.includes('REPORT'));
  assert.throws(() => protocol.parseSpecialistReport(reportBlock({ status: 'unknown' })), /status/);
  assert.throws(() => protocol.parseSpecialistReport(reportBlock({ summary: '' })), /summary/);
});

test('项目经理不能跳阶段，最后阶段必须完成验收', () => {
  const proceed = { verdict: 'PROCEED', reason: '通过', nextStageId: '01', workOrder: workOrder() };
  assert.throws(() => protocol.parseManagerDecision(decisionBlock(proceed), reviewContext()), /紧邻/);
  const finalProceed = { verdict: 'PROCEED', reason: '通过', nextStageId: null, workOrder: workOrder() };
  assert.throws(() => protocol.parseManagerDecision(decisionBlock(finalProceed), reviewContext({ currentStageId: '03', isFinalFull: true })), /COMPLETE/);
  const missingReport = { verdict: 'PROCEED', reason: '通过', nextStageId: '03', workOrder: workOrder() };
  assert.throws(() => protocol.parseManagerDecision(decisionBlock(missingReport), reviewContext({ report: null })), /缺少有效 REPORT/);
});

test('返工预算与上游产物失效由状态机强制执行', () => {
  const state = router.freshState('demo', '/tmp/demo', 'config/pipeline.json', '01', { maxReworkRounds: 1, maxTotalReworks: 2 });
  assert.equal(router.canRework(state, '01'), true);
  router.recordRework(state, '01', 'REWORK', '缺证据');
  assert.equal(router.canRework(state, '01'), false);
  assert.equal(router.canRework(state, '02'), true);
  router.invalidateFrom(state, stages, 1);
  assert.deepEqual(state.invalidatedOutputs, ['artifacts/02.md', 'artifacts/03.md']);
  router.clearOutput(state, 'artifacts/02.md');
  assert.deepEqual(state.invalidatedOutputs, ['artifacts/03.md']);
  router.recordProceed(state, stages[1], '03', workOrder());
  assert.equal(state.nextWorkOrder.objective, '完成目标阶段');
  router.beginStage(state, stages[2]);
  assert.equal(state.nextWorkOrder, null);
});

const fakeAgentSource = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
if (process.argv.includes('--version')) { console.log('fake-agent 1.0.0'); process.exit(0); }
const prompt = process.argv[process.argv.length - 1] || '';
const scenario = process.env.FAKE_SCENARIO || 'happy';
const counterFile = process.env.FAKE_COUNTER_FILE;
function count(key) {
  let data = {};
  if (counterFile && fs.existsSync(counterFile)) data = JSON.parse(fs.readFileSync(counterFile, 'utf8'));
  data[key] = (data[key] || 0) + 1;
  if (counterFile) { fs.mkdirSync(path.dirname(counterFile), { recursive: true }); fs.writeFileSync(counterFile, JSON.stringify(data)); }
  return data[key];
}
function order() { return { objective: '完成目标阶段', requiredChanges: ['修复问题'], acceptanceChecks: ['复验通过'], constraints: ['最小改动'], outOfScope: ['无关重构'] }; }
if (prompt.includes('===== 项目经理执行模式 =====')) {
  const routing = (prompt.split('===== 项目经理路由上下文 =====')[1] || prompt).split('===== 当前阶段产物 =====')[0];
  const mode = (routing.match(/"mode": "([^"]+)"/) || [])[1];
  const current = (routing.match(/"currentStageId": "([^"]+)"/) || [])[1];
  const next = (routing.match(/"nextStageId": "([^"]+)"/) || [])[1];
  const target = (routing.match(/"targetStageId": "([^"]+)"/) || [])[1];
  const reviewCount = mode === 'review' ? count('review:' + current) : 0;
  let decision;
  if (mode === 'dispatch') {
    decision = { verdict: 'PROCEED', reason: '需求足以开工', nextStageId: target, workOrder: order() };
  } else if (scenario === 'budget' && current === '01-product-plan') {
    decision = { verdict: 'REWORK', reason: '仍未达到验收标准', nextStageId: current, workOrder: order() };
  } else if (scenario === 'escalate' && current === '05-code-review') {
    decision = { verdict: 'ESCALATE', reason: '需要人工授权', escalation: { question: '是否接受临时风险？', whyCannotDecide: '涉及业务风险豁免', options: ['拒绝并修复', '接受临时风险'], recommendation: '拒绝并修复', impact: '影响上线范围', evidence: ['审查报告 C1'], resumeStageId: '04-develop', recommendedAmend: '人工决定：拒绝风险并修复 C1。', workOrder: Object.assign(order(), { requiredChanges: ['修复 C1'] }) } };
  } else if (scenario === 'rework' && current === '05-code-review' && reviewCount === 1) {
    decision = { verdict: 'REWORK', reason: '缺少复验证据', nextStageId: current, workOrder: order() };
  } else if (scenario === 'return' && current === '06-test' && reviewCount === 1) {
    decision = { verdict: 'RETURN_UPSTREAM', reason: '实现与验收口径不一致', nextStageId: '04-develop', workOrder: order() };
  } else if (current === '07-deploy' || current === '05-pr-summary') {
    decision = { verdict: 'COMPLETE', reason: '验收通过', acceptance: { summary: '可交付，部署动作未实际执行。', remainingRisks: ['待部署'] } };
  } else {
    decision = { verdict: 'PROCEED', reason: '验收通过', nextStageId: next, workOrder: order() };
  }
  console.log('# 项目经理决策\\n\\n' + decision.reason);
  console.log('===== DECISION =====\\n' + JSON.stringify(decision, null, 2) + '\\n===== DECISION END =====');
} else {
  if (prompt.includes('项目经理任务书')) count('with-work-order');
  if (prompt.includes('修复 C1')) count('order:04-develop');
  if (scenario === 'missing-report') {
  console.log('# 阶段产物\\n\\n没有结构化报告。');
} else if (scenario === 'verdict-fail') {
  console.log('# 验证报告\\n\\nVERDICT: FAIL');
} else if (scenario === 'no-verdict') {
  console.log('# 验证报告\\n\\n缺少结论标记。');
} else {
  const report = { status: 'done', summary: 'fake 阶段完成', completedTasks: ['T1'], evidence: ['fake 命令通过'], issues: [], unverified: [], decisionsNeeded: [] };
  console.log('# 阶段产物\\n\\n由 fake agent 生成。');
  console.log('===== REPORT =====\\n' + JSON.stringify(report, null, 2) + '\\n===== REPORT END =====');
}
}
`;

function createHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pipeline-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeAgent = path.join(root, 'fake-agent.js');
  fs.writeFileSync(fakeAgent, fakeAgentSource);
  const cliConfig = path.join(root, 'cli.json');
  fs.writeFileSync(cliConfig, JSON.stringify({
    adapter: 'plain',
    host: 'auto',
    autoDetect: [],
    plain: { command: `${process.execPath} ${fakeAgent}`, promptMode: 'arg', extraArgs: [] },
  }));
  const projectDir = path.join(root, 'project');
  const workDir = path.join(root, 'work');
  const counterFile = path.join(root, 'counter.json');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  function run(scenario = 'happy', extraArgs = [], includeRequirement = true) {
    return spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'run-pipeline.js'),
      '--project-name', 'demo',
      '--project-dir', projectDir,
      '--work-dir', workDir,
      ...(includeRequirement ? ['--requirement', '测试需求'] : []),
      '--adapter', 'plain',
      '--cli-config', cliConfig,
      '--no-memory', '--no-knowledge', '--no-delegate',
      ...extraArgs,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: Object.assign({}, process.env, { FAKE_SCENARIO: scenario, FAKE_COUNTER_FILE: counterFile }),
      timeout: 120000,
    });
  }
  return { root, projectDir, workDir, counterFile, run };
}

function stateOf(workDir) {
  return JSON.parse(fs.readFileSync(path.join(workDir, 'artifacts', 'pm-project-state.json'), 'utf8'));
}

test('开发流水线正常完成并生成最终验收单', (t) => {
  const h = createHarness(t);
  const result = h.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = stateOf(h.workDir);
  assert.equal(state.status, 'complete');
  assert.deepEqual(state.invalidatedOutputs, []);
  assert.equal(Object.keys(state.completedStages).length, 7);
  const acceptance = fs.readFileSync(path.join(h.workDir, 'artifacts', '99-acceptance.md'), 'utf8');
  assert.match(acceptance, /可交付/);
  assert.match(acceptance, /待部署/);
});

test('审查未通过自动返工，验收后才继续', (t) => {
  const h = createHarness(t);
  const result = h.run('rework');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = stateOf(h.workDir);
  assert.equal(state.rework.total, 1);
  assert.equal(state.rework.byStage['05-code-review'], 1);
  const counters = JSON.parse(fs.readFileSync(h.counterFile, 'utf8'));
  assert.equal(counters['review:05-code-review'], 2);
});

test('测试验收可退回开发，并使下游旧结论失效', (t) => {
  const h = createHarness(t);
  const result = h.run('return');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = stateOf(h.workDir);
  assert.equal(state.status, 'complete');
  assert.equal(state.rework.total, 1);
  assert.deepEqual(state.invalidatedOutputs, []);
  assert.ok(state.history.some((item) => item.action === 'invalidate' && item.stageId === '04-develop'));
});

test('人工升级退出 42，并可通过决策 ID 保留状态恢复', (t) => {
  const h = createHarness(t);
  const escalated = h.run('escalate');
  assert.equal(escalated.status, 42, escalated.stdout + escalated.stderr);
  const pending = JSON.parse(fs.readFileSync(path.join(h.workDir, 'artifacts', 'pm-escalation.json'), 'utf8')).pending;
  assert.equal(pending.resumeStageId, '04-develop');
  assert.equal(stateOf(h.workDir).status, 'awaiting-human');
  assert.ok(stateOf(h.workDir).invalidatedOutputs.includes('artifacts/05-review.md'));
  assert.ok(stateOf(h.workDir).invalidatedOutputs.includes('artifacts/06-test-report.md'));
  assert.ok(stateOf(h.workDir).history.some((item) => item.verdict === 'ESCALATE'), JSON.stringify(stateOf(h.workDir).history));
  const resumed = h.run('happy', ['--resume-human', pending.decisionId, '--amend', '人工决定：修复 C1 后继续。'], false);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const state = stateOf(h.workDir);
  assert.equal(state.status, 'complete');
  assert.equal(state.pending, null);
  assert.deepEqual(state.invalidatedOutputs, []);
  const counters = JSON.parse(fs.readFileSync(h.counterFile, 'utf8'));
  assert.equal(counters['order:04-develop'], 1);
  assert.ok(state.history.some((item) => item.action === 'invalidate' && item.stageId === '04-develop'), resumed.stdout + resumed.stderr + JSON.stringify(state.history));
});

test('缺少 REPORT 时不能由项目经理放行', (t) => {
  const h = createHarness(t);
  const result = h.run('missing-report');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /缺少有效 REPORT/);
  assert.equal(fs.existsSync(path.join(h.workDir, 'artifacts', '99-acceptance.md')), false);
});

test('旧配置没有项目经理时仍按原阶段执行', (t) => {
  const h = createHarness(t);
  const pipeline = path.join(h.root, 'legacy-pipeline.json');
  fs.writeFileSync(pipeline, JSON.stringify({
    project: { name: '{projectName}', dir: '{projectDir}' },
    stages: [{
      id: '01-legacy', name: '旧阶段', agent: 'product-manager',
      promptFile: 'prompts/01-product-plan.md', input: [], output: 'artifacts/legacy.md', confirm: false,
    }],
  }));
  const result = h.run('no-verdict', ['--pipeline-config', pipeline]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(h.workDir, 'artifacts', 'legacy.md')));
  assert.equal(fs.existsSync(path.join(h.workDir, 'artifacts', 'pm-project-state.json')), false);
});

test('旧修复回炉在验证报告缺少 VERDICT 时失败关闭', (t) => {
  const h = createHarness(t);
  const pipeline = path.join(h.root, 'legacy-fix.json');
  fs.writeFileSync(pipeline, JSON.stringify({
    project: { name: '{projectName}', dir: '{projectDir}' },
    stages: [{
      id: '04-fix-test', name: '验证', agent: 'tester',
      promptFile: 'prompts/issue-04-fix-test.md', input: [], output: 'artifacts/legacy-test.md', confirm: false,
    }],
    retry: { checkStage: '04-fix-test', failPattern: 'VERDICT:\\s*FAIL', resumeStage: '03-fix-dev', maxRounds: 1 },
  }));
  const result = h.run('no-verdict', ['--pipeline-config', pipeline]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /缺少 VERDICT/);
});

test('旧修复回炉配置无效时失败关闭', (t) => {
  const h = createHarness(t);
  const pipeline = path.join(h.root, 'legacy-fix-invalid.json');
  fs.writeFileSync(pipeline, JSON.stringify({
    project: { name: '{projectName}', dir: '{projectDir}' },
    stages: [{
      id: '04-fix-test', name: '验证', agent: 'tester',
      promptFile: 'prompts/issue-04-fix-test.md', input: [], output: 'artifacts/legacy-test.md', confirm: false,
    }],
    retry: { checkStage: '04-fix-test', failPattern: 'VERDICT:\\s*FAIL', resumeStage: 'missing-stage', maxRounds: 1 },
  }));
  const result = h.run('verdict-fail', ['--pipeline-config', pipeline]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /回炉配置无效/);
});

test('修复流水线也由项目经理逐阶段验收并完成', (t) => {
  const h = createHarness(t);
  const result = h.run('happy', ['--pipeline', 'fix']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const state = stateOf(h.workDir);
  assert.equal(state.status, 'complete');
  assert.equal(Object.keys(state.completedStages).length, 5);
  assert.ok(fs.existsSync(path.join(h.workDir, 'artifacts', '99-acceptance.md')));
});

test('返工预算耗尽后升级人工，追加预算可继续', (t) => {
  const h = createHarness(t);
  const escalated = h.run('budget');
  assert.equal(escalated.status, 42, escalated.stdout + escalated.stderr);
  const pending = JSON.parse(fs.readFileSync(path.join(h.workDir, 'artifacts', 'pm-escalation.json'), 'utf8')).pending;
  assert.equal(pending.reasonType, 'rework-budget');
  assert.equal(stateOf(h.workDir).rework.total, 2);
  const resumed = h.run('happy', ['--resume-human', pending.decisionId, '--amend', '批准额外一轮返工。'], false);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const state = stateOf(h.workDir);
  assert.equal(state.status, 'complete');
  assert.equal(state.rework.extraApproved, 1);
  assert.equal(state.rework.total, 2);
});

test('部分执行从中断阶段恢复，不重跑已验收阶段', (t) => {
  const h = createHarness(t);
  const partial = h.run('happy', ['--to', '02-requirements']);
  assert.equal(partial.status, 0, partial.stdout + partial.stderr);
  assert.equal(stateOf(h.workDir).status, 'paused');
  assert.equal(stateOf(h.workDir).resumeStageId, '03-architecture');
  assert.equal(stateOf(h.workDir).nextWorkOrder.objective, '完成目标阶段');
  const initialCounters = JSON.parse(fs.readFileSync(h.counterFile, 'utf8'));
  assert.equal(initialCounters['with-work-order'], 2);
  const resumed = h.run('happy', [], false);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const counters = JSON.parse(fs.readFileSync(h.counterFile, 'utf8'));
  assert.equal(counters['review:01-product-plan'], 1);
  assert.equal(counters['review:02-requirements'], 1);
  assert.equal(counters['with-work-order'] - initialCounters['with-work-order'], 5);
  assert.equal(stateOf(h.workDir).status, 'complete');
});

test('演练模式展示项目经理阶段但不写管理状态', (t) => {
  const h = createHarness(t);
  const result = h.run('happy', ['--dry-run'], false);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pm-dispatch/);
  assert.match(result.stdout, /pm-review-07-deploy/);
  assert.equal(fs.existsSync(path.join(h.workDir, 'artifacts', 'pm-project-state.json')), false);
});
