#!/usr/bin/env node
/**
 * 多宿主安装器 —— 把 agent-pipeline 安装到 WorkBuddy / CodeBuddy / zCode / Marvis / Qoder
 *
 * 零 npm 依赖，Node >= 18，macOS / Linux / Windows 通用。
 *
 * 用法：
 *   node scripts/install.js --dry-run
 *   node scripts/install.js --platform auto --scope user
 *   node scripts/install.js --platform all --scope user
 *   node scripts/install.js --platform codebuddy,qoder --scope project --project-root /path/to/repo
 *   node scripts/install.js --platform auto --scope user --link
 *   node scripts/install.js --platform auto --scope user --uninstall
 *   node scripts/install.js --from-github                    # 从 GitHub 下载最新版本安装
 *   node scripts/install.js --from-github --version 1.0.0    # 下载指定版本
 *   node scripts/install.js --from-github --dry-run          # 只打印将下载的版本
 *
 * 说明：
 *   - 安装目录名固定为 SKILL.md frontmatter 的 name（agent-pipeline），满足 zCode 的
 *     「name 为小写 kebab-case 且与目录名一致」要求。
 *   - 源码目录保持只读友好：不写回源码，运行时产物也不在安装目录内生成。
 *   - 每个目标都写入全套兼容元数据（meta.json / _skillhub_meta.json / metadata.json），
 *     未被宿主识别的文件会被忽略，不影响加载。
 *   - --from-github 从 GitHub Releases 下载 zip 并解压到临时目录后安装。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  SKILL_NAME, CORE_PLATFORMS, PLATFORMS, EXCLUDE, detectedPlatforms,
} = require('./lib/platforms');
const V = require('./lib/version');

const ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();
const GITHUB_REPO = 'trexwb/agent-pipeline';

// ---------- 远程安装（--from-github） ----------
// 版本号会拼进下载 URL 与文件名，先严格校验，避免任意字符串进入命令行
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
function assertVersion(v) {
  if (!SEMVER_RE.test(String(v))) throw new Error(`版本号格式应为 x.y.z（如 1.3.0），收到：${v}`);
  return String(v);
}

// 外部命令一律走 argv 数组，不拼接 shell 字符串
function runTool(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 150000 }, opts || {}));
  if (r.error) throw new Error(`${cmd} 执行失败：${r.error.message}（请确认已安装并在 PATH 中）`);
  if (r.status !== 0) {
    throw new Error(`${cmd} 退出码 ${r.status}：${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
  return String(r.stdout || '');
}

function fetchLatestVersion() {
  let v = '';
  try {
    const info = runTool('curl', ['-sS', '--connect-timeout', '10', '--max-time', '20',
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`]);
    v = String(JSON.parse(info).tag_name || '').replace(/^v/, '');
    assertVersion(v);
  } catch (e) {
    throw new Error(`无法获取最新版本号：${e.message}\n请检查网络连接，或使用 --version <x.y.z> 指定版本`);
  }
  return v;
}

// 下载 zip 并解压到临时目录，返回临时目录与解出的源目录
function downloadAndExtract(version) {
  assertVersion(version);
  const zipName = `agent-pipeline-${version}.zip`;
  const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${zipName}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pipeline-'));
  const zipPath = path.join(tmpDir, zipName);
  const extractDir = path.join(tmpDir, 'extracted');
  console.log(`[下载] ${downloadUrl}`);
  try {
    runTool('curl', ['-L', '--fail', '--connect-timeout', '10', '--max-time', '120', '-o', zipPath, downloadUrl]);
    fs.mkdirSync(extractDir, { recursive: true });
    if (process.platform === 'win32') {
      runTool('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(extractDir)} -Force`]);
    } else {
      runTool('unzip', ['-q', zipPath, '-d', extractDir]);
    }
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`远程安装失败：${e.message}\n请确认版本 v${version} 已发布（GitHub Release 附带 ${zipName}）`);
  }
  console.log(`[解压] ${extractDir}`);
  return { extractDir, tmpDir, version };
}

// 宿主路径表来自 scripts/lib/platforms.js，安装与版本盘点共用同一份定义，避免漂移。

function usage() {
  return [
    '用法：node scripts/install.js [选项]',
    '',
    '  --platform <列表>   逗号分隔：' + Object.keys(PLATFORMS).join(' / ') + ' / auto / all',
    '                      auto=只装本机已检测到的宿主；all=五个主宿主（默认 auto）',
    '                      all / auto 可与具体平台组合，如 --platform all,common',
    '  --scope <范围>      user | project | both（默认 user）',
    '  --project-root <路径>  项目级安装的根目录（默认当前目录）',
    '  --link              建立目录软链而非复制（开发模式，改源码即时生效）',
    '  --force             覆盖已存在的同名安装',
    '  --uninstall         卸载（只删除含本 skill 的 SKILL.md 的目录）',
    '  --from-github       从 GitHub Releases 下载最新版本安装',
    '  --version <x.y.z>   与 --from-github 配合，下载指定版本（默认 latest）',
    '  --dry-run           只打印计划，不写任何文件',
    '  --help              显示本帮助',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function readSkillMeta() {
  const skillPath = path.join(ROOT, 'SKILL.md');
  if (!fs.existsSync(skillPath)) throw new Error('未找到 SKILL.md：' + skillPath);
  const text = fs.readFileSync(skillPath, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error('SKILL.md 缺少 YAML frontmatter');
  const field = (name) => {
    const r = m[1].match(new RegExp('^' + name + ':\\s*(.+)$', 'm'));
    return r ? r[1].trim().replace(/^['"]|['"]$/g, '') : '';
  };
  const name = field('name');
  if (!name) throw new Error('SKILL.md 缺少 name 字段');
  if (name !== SKILL_NAME) throw new Error('SKILL.md 的 name 与安装目录名不一致：' + name + ' != ' + SKILL_NAME);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('name 必须是小写 kebab-case：' + name);
  return {
    name,
    version: V.readVersion(ROOT), // 唯一权威来源：meta.json 的 version
    displayName: field('display_name') || name,
    description: field('description'),
  };
}

function readMetaJson() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'meta.json'), 'utf8'));
  } catch (e) { return {}; }
}

function buildMetadata(meta, skill) {
  return {
    'meta.json': Object.assign({}, meta, {
      name: skill.name,
      display_name: meta.display_name || skill.displayName,
      description: meta.description || skill.description,
      version: skill.version,
    }),
    '_skillhub_meta.json': {
      slug: skill.name,
      name: skill.displayName,
      version: skill.version,
      installedAt: Date.now(),
      source: 'local',
    },
    'metadata.json': {
      name: skill.name,
      description: skill.description,
      version: skill.version,
      category: 'development',
    },
  };
}

function copyTree(src, dest, metadata, dryRun) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  if (!dryRun) fs.mkdirSync(dest, { recursive: true });
  for (const e of entries) {
    if (EXCLUDE.has(e.name) || e.name.endsWith('.zip')) continue;
    // 元数据文件统一由 buildMetadata 生成，避免把源码里的旧版本带过去
    if (Object.prototype.hasOwnProperty.call(metadata, e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d, metadata, dryRun);
    else if (!dryRun) fs.copyFileSync(s, d);
  }
  for (const [file, data] of Object.entries(metadata)) {
    if (!dryRun) fs.writeFileSync(path.join(dest, file), JSON.stringify(data, null, 2) + '\n');
  }
}

function isOurSkill(dir) {
  const p = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(p)) return false;
  try {
    return /^name:\s*agent-pipeline\s*$/m.test(fs.readFileSync(p, 'utf8'));
  } catch (e) { return false; }
}

function removeTarget(dest, dryRun) {
  if (dryRun) return;
  const stat = fs.lstatSync(dest);
  if (stat.isSymbolicLink()) fs.unlinkSync(dest);
  else fs.rmSync(dest, { recursive: true, force: true });
}

function resolveTargets(args) {
  const raw = String(args.platform || 'auto');
  const requested = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set([...Object.keys(PLATFORMS), 'auto', 'all']);
  const bad = requested.filter((k) => !allowed.has(k));
  if (bad.length) {
    throw new Error('未知平台：' + bad.join(', ') + '（可用：' + Object.keys(PLATFORMS).join('/') + '/auto/all）');
  }
  // all / auto 可与其他平台名组合，按出现顺序展开并去重
  const keys = [];
  const seen = new Set();
  for (const k of requested) {
    const expanded = k === 'all' ? CORE_PLATFORMS : (k === 'auto' ? detectedPlatforms(HOME) : [k]);
    for (const p of expanded) if (!seen.has(p)) { seen.add(p); keys.push(p); }
  }
  if (!keys.length) throw new Error('未检测到任何宿主配置目录，请用 --platform 显式指定');

  const scope = String(args.scope || 'user');
  if (!['user', 'project', 'both'].includes(scope)) throw new Error('--scope 只能是 user / project / both');
  const projectRoot = path.resolve(String(args['project-root'] || process.cwd()));
  const explicit = !(requested.length === 1 && requested[0] === 'auto');
  const targets = [];

  for (const key of keys) {
    const def = PLATFORMS[key];
    if (scope === 'user' || scope === 'both') {
      let candidates = def.user;
      if (!explicit) candidates = candidates.filter((u) => fs.existsSync(path.join(HOME, u.detect)));
      else {
        const hit = candidates.filter((u) => fs.existsSync(path.join(HOME, u.detect)));
        if (hit.length) candidates = hit;
        else candidates = candidates.slice(0, 1);
      }
      for (const u of candidates) {
        targets.push({ platform: key, scope: 'user', dir: path.join(HOME, u.dir, SKILL_NAME) });
      }
    }
    if (scope === 'project' || scope === 'both') {
      for (const p of def.project) {
        targets.push({ platform: key, scope: 'project', dir: path.join(projectRoot, p, SKILL_NAME) });
      }
    }
  }
  // 目标落在源码目录内会造成复制时自引用递归；源码目录本身已经是 skill，无需再装一份
  for (const t of targets) {
    if (t.dir === ROOT || t.dir.startsWith(ROOT + path.sep)) {
      throw new Error('目标目录位于 skill 源码目录内：' + t.dir
        + '。请用 --project-root 指定另一个项目根目录（源码目录本身已是 skill）。');
    }
  }
  return targets;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return 0; }
  const dryRun = !!args['dry-run'];
  const uninstall = !!args.uninstall;
  const linkMode = !!args.link;
  const force = !!args.force;
  const fromGithub = !!args['from-github'];

  // --from-github：从 GitHub Releases 下载安装；--dry-run 只解析版本不下载
  let sourceRoot = ROOT;
  let sourceLabel = ROOT;
  let tmpCleanup = null;
  let remoteVersion = null;
  if (fromGithub) {
    if (linkMode) {
      console.error('错误：--from-github 不能与 --link 同时使用（远程下载无法建立软链）');
      return 1;
    }
    remoteVersion = args.version ? assertVersion(args.version) : fetchLatestVersion();
    if (dryRun) {
      sourceLabel = `待下载 https://github.com/${GITHUB_REPO}/releases/download/v${remoteVersion}/agent-pipeline-${remoteVersion}.zip`;
      console.log(`[远程安装] 演练模式：目标版本 v${remoteVersion}，不下载、不写入任何文件`);
    } else {
      const result = downloadAndExtract(remoteVersion);
      sourceRoot = result.extractDir;
      sourceLabel = result.extractDir;
      tmpCleanup = result.tmpDir;
      console.log(`[远程安装] 版本 v${remoteVersion}`);
    }
  }

  try {
    const skill = fromGithub
      ? { name: SKILL_NAME, version: remoteVersion, displayName: SKILL_NAME, description: '' }
      : readSkillMeta();
    if (!fromGithub) {
      const consistency = V.collect(sourceRoot);
      if (!consistency.consistent) {
        console.log('警告：源码版本位置不一致（权威版本 ' + consistency.expected + '），'
          + '建议先运行 node scripts/version.js sync');
      }
    }
    const metadata = fromGithub
      ? buildMetadata({}, skill)
      : buildMetadata(readMetaJson(), skill);
    const targets = resolveTargets(args);

    console.log('[agent-pipeline] ' + (dryRun ? '演练模式，不写入任何文件' : (uninstall ? '卸载' : '安装'))
      + ' | 版本 ' + skill.version + ' | 源目录 ' + sourceLabel);
    if (uninstall && linkMode) console.log('[提示] --uninstall 会忽略 --link');

    let ok = 0; let skipped = 0; let failed = 0;
    for (const t of targets) {
      const parts = path.parse(t.dir);
      const name = PLATFORMS[t.platform].label + ' / ' + t.scope;
      const exists = fs.existsSync(t.dir) || (() => {
        try { fs.lstatSync(t.dir); return true; } catch (e) { return false; }
      })();

      if (uninstall) {
        if (!exists) { console.log('  跳过  ' + name + '：' + t.dir + '（不存在）'); skipped++; continue; }
        if (!isOurSkill(t.dir)) {
          console.log('  跳过  ' + name + '：' + t.dir + '（不是本 skill，拒绝删除）'); skipped++; continue;
        }
        console.log('  卸载  ' + name + ' → ' + t.dir);
        if (!dryRun) {
          try { removeTarget(t.dir, false); ok++; }
          catch (e) { console.log('  失败  ' + e.message); failed++; }
        } else ok++;
        continue;
      }

      if (exists && !force) {
        console.log('  跳过  ' + name + '：' + t.dir + '（已存在，需 --force 覆盖）');
        skipped++; continue;
      }
      console.log('  ' + (linkMode ? '软链  ' : '安装  ') + name + ' → ' + t.dir
        + (exists ? '（覆盖）' : ''));

      if (dryRun) { ok++; continue; }
      try {
        fs.mkdirSync(parts.dir, { recursive: true });
        if (exists) removeTarget(t.dir, false);
        if (linkMode) {
          fs.symlinkSync(sourceRoot, t.dir, process.platform === 'win32' ? 'junction' : 'dir');
        } else {
          copyTree(sourceRoot, t.dir, metadata, false);
        }
        ok++;
      } catch (e) {
        console.log('  失败  ' + name + '：' + e.message);
        failed++;
      }
    }

    console.log('\n[agent-pipeline] 完成：' + ok + ' 项成功，' + skipped + ' 项跳过，' + failed + ' 项失败。');
    if (!dryRun && !uninstall && ok) {
      console.log('提示：部分宿主需重启或执行 /skills reload 才能发现新 skill；'
        + '用 --dry-run 可随时复查安装位置。');
      console.log('升级旧副本请加 --force；各宿主版本盘点：node scripts/version.js installed');
    }
    return failed ? 1 : 0;
  } finally {
    // 清理临时目录
    if (tmpCleanup) {
      try { fs.rmSync(tmpCleanup, { recursive: true, force: true }); } catch (e) { /* 忽略清理失败 */ }
    }
  }
}

try {
  process.exit(main());
} catch (e) {
  console.error('[agent-pipeline] 错误：' + e.message);
  console.error('\n' + usage());
  process.exit(1);
}
