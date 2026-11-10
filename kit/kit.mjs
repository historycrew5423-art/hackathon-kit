#!/usr/bin/env node
// 口令对应的命令。只用 Node 自带的东西，Mac、Windows、云端沙盒都能跑。
// 用法：node kit/kit.mjs <命令> [参数]    不带命令会列出全部命令。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAIM_HOURS = 2; // 认领多久没动静就作废
const FLAGS = new Set(['no-sync', 'anyway', 'handoff', 'all', 'save']); // 这几个参数后面不跟内容

const say = (s = '') => console.log(s);
function fail(msg) {
  console.error('\n【出错】' + msg);
  process.exit(1);
}

// ---------- 基础 ----------

function findRoot() {
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, 'state', 'people.json'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const guess = path.dirname(HERE);
  if (fs.existsSync(path.join(guess, 'state', 'people.json'))) return guess;
  fail('找不到 state/people.json。请在仓库目录里运行这条命令。');
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opt[a.slice(2, eq)] = a.slice(eq + 1);
      else if (FLAGS.has(a.slice(2))) opt[a.slice(2)] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[a.slice(2)] = argv[++i];
      else opt[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// 时间一律按北京时间写，不管机器在哪个时区
function bj(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function fromBj(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s || '');
  return m ? new Date(`${m[1]}T${m[2]}:00+08:00`) : null;
}
const stamp = (d = new Date()) => bj(d).replace(/[-:]/g, '').replace(' ', '-'); // 20261110-2250
function howLong(ms) {
  const min = Math.round(Math.abs(ms) / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} 小时 ${min % 60} 分钟` : `${h} 小时`;
}

// 小文件的格式：第一行 "# 标题"，接着几行 "- 键: 值"，空一行后是正文
function readDoc(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const doc = { title: '', kv: {}, body: '' };
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++; // 跳过“已作废”这类盖章
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i] && lines[i].startsWith('# ')) doc.title = lines[i++].slice(2).trim();
  for (; i < lines.length; i++) {
    const m = /^- ([^:：]+)[:：]\s*(.*)$/.exec(lines[i]);
    if (!m) break;
    doc.kv[m[1].trim()] = m[2].trim();
  }
  doc.body = lines.slice(i).join('\n').trim();
  return doc;
}
function writeDoc(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const kv = Object.entries(doc.kv).map(([k, v]) => `- ${k}: ${v ?? ''}`).join('\n');
  fs.writeFileSync(file, `# ${doc.title}\n${kv}\n${doc.body ? '\n' + doc.body + '\n' : ''}`);
}
function listDocs(dir) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => f.endsWith('.md')).sort()
    .map((f) => ({ file: path.join(full, f), rel: `${dir}/${f}`, id: f.replace(/\.md$/, ''), ...readDoc(path.join(full, f)) }));
}
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ---------- 人和 agent ----------

function people() {
  const j = readJSON(path.join(ROOT, 'state', 'people.json'));
  if (!j || !Array.isArray(j.people)) fail('state/people.json 读不出来。');
  return j.people;
}
function findPerson(who) {
  return people().find((p) => [p.id, p.name, p.github].includes(who));
}
function whoAmI(opt) {
  const local = readJSON(path.join(ROOT, '.kit-local.json')) || {};
  const who = str(opt.who) || process.env.KIT_WHO || local.who;
  const agent = str(opt.agent) || process.env.KIT_AGENT || local.agent || '没写';
  const person = who && findPerson(who);
  if (!person) {
    const names = people().map((p) => `${p.id}（${p.name}）`).join('、');
    fail(`不知道你是替谁干活的。加上 --who，可选：${names}。\n也可以运行一次：node kit/kit.mjs whoami --who <人> --agent <工具名> --save`);
  }
  return { person, agent };
}

// ---------- git ----------

function git(args, o = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const res = { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  if (!res.ok && !o.ok) fail(`git ${args.join(' ')} 没成功：\n${res.err || res.out}`);
  return res;
}
const hasRemote = () => git(['remote'], { ok: true }).out.split('\n').includes('origin');
const branch = () => git(['rev-parse', '--abbrev-ref', 'HEAD'], { ok: true }).out || 'main';

function sync(opt = {}) {
  if (opt['no-sync'] || !hasRemote()) return;
  const f = git(['fetch', 'origin', '--prune'], { ok: true });
  if (!f.ok) { say('（提醒：连不上 GitHub，下面是本地的情况，可能不是最新的）'); return; }
  const b = branch();
  if (!git(['rev-parse', '--verify', '--quiet', `origin/${b}`], { ok: true }).ok) return; // 远端还没有这个分支
  if (!git(['rev-parse', '--verify', '--quiet', 'HEAD'], { ok: true }).ok) return; // 本地还没有任何提交
  const r = git(['pull', '--rebase', '--autostash', 'origin', b], { ok: true });
  if (!r.ok) {
    git(['rebase', '--abort'], { ok: true });
    fail('同步的时候，本地的改动和别人推上去的撞了。已经退回同步前的样子，什么都没丢。\n照规矩办：不许整个文件用自己的；十分钟解不开，就把活停到一个停车分支推上去，在现状板标“等人拍板”。');
  }
}

function commit(files, msg, me, all = false) {
  if (all) git(['add', '-A']);
  else git(['add', '--', ...files]);
  const staged = git(['diff', '--cached', '--name-only']).out;
  if (!staged) return false;
  const id = me.person.gitName
    ? ['-c', `user.name=${me.person.gitName}`, '-c', `user.email=${me.person.gitEmail}`]
    : [];
  const full = `${msg}\n\n谁做的: ${me.person.name} / ${me.agent}`;
  if (all) git([...id, 'commit', '-q', '-m', full]);
  else git([...id, 'commit', '-q', '-m', full, '--', ...files]);
  return true;
}

function push() {
  if (!hasRemote()) { say('（这个仓库还没连上 GitHub，改动只存在本地）'); return; }
  const b = branch();
  for (let i = 0; i < 3; i++) {
    if (git(['push', '-q', '-u', 'origin', b], { ok: true }).ok) { say('已推上 GitHub。'); return; }
    const p = git(['pull', '--rebase', '--autostash', 'origin', b], { ok: true });
    if (!p.ok) { git(['rebase', '--abort'], { ok: true }); break; }
  }
  fail('没推上去。改动已经提交在本地，没有丢。等网络好了再运行一次这条命令，或者运行 git push。');
}

// ---------- 现状板、已定的事 ----------

const boardFile = (id) => path.join(ROOT, 'state', 'board', `${id}.md`);
function readBoard(person) {
  const f = boardFile(person.id);
  if (!fs.existsSync(f)) return { title: person.name, kv: {}, body: '' };
  return readDoc(f);
}
function claimState(kv) {
  if (!kv['在做']) return { active: false };
  const t = fromBj(kv['认领时间']);
  if (!t) return { active: true, expired: false };
  const left = t.getTime() + CLAIM_HOURS * 3600e3 - Date.now();
  return { active: left > 0, expired: left <= 0, left };
}
const splitPaths = (s) => str(s).split(/[,，、]/).map((x) => x.trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
function overlaps(a, b) {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
function validDecisions() {
  return listDocs('state/decisions').filter((d) => (d.kv['状态'] || '有效') === '有效');
}
function uniqueId(dir, base) {
  let id = base;
  for (let n = 2; fs.existsSync(path.join(ROOT, dir, `${id}.md`)); n++) id = `${base}-${n}`;
  return id;
}

function schedule() {
  const s = readJSON(path.join(ROOT, 'state', 'schedule.json'));
  if (!s || !s.deadline) return null;
  const start = fromBj(s.start);
  const end = fromBj(s.deadline);
  if (!start || !end) return null;
  const h = 3600e3;
  const points = [
    ['第一版上线，有网址和二维码', start.getTime() + 1 * h],
    ['方块版能玩', start.getTime() + 3 * h],
    ['素材截止', end.getTime() - 5 * h],
    ['停止加功能，只修问题', end.getTime() - 3 * h],
    ['录备用视频，出离线包', end.getTime() - 2 * h],
    ['只修会卡死的问题，先交草稿', end.getTime() - 1 * h],
    ['提交截止', end.getTime()],
  ].sort((x, y) => x[1] - y[1]);
  return { name: s.name || '比赛', start, end, points };
}

// ---------- 打印 ----------

function onePagerText() {
  const ds = validDecisions();
  if (!ds.length) return '（还没有定下来的事）';
  const groups = new Map();
  for (const d of ds) {
    const t = d.kv['话题'] || '其他';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(d);
  }
  const out = [];
  for (const [topic, list] of groups) {
    out.push(`【${topic}】`);
    for (const d of list) {
      out.push(`- ${d.title}（${d.kv['谁定的'] || '?'}，${d.kv['时间'] || '?'}，编号 ${d.id}）`);
      if (d.body && d.body !== d.title) out.push(...d.body.split('\n').map((l) => '  ' + l));
    }
  }
  return out.join('\n');
}

function boardText() {
  const out = [];
  for (const p of people()) {
    const b = readBoard(p);
    const kv = b.kv;
    const c = claimState(kv);
    const head = `${p.name}${p.publisher ? '（发布人）' : ''}`;
    if (!Object.keys(kv).length) { out.push(`- ${head}：还没写过`); continue; }
    out.push(`- ${head}：更新于 ${kv['更新'] || '?'}，agent 是 ${kv['agent'] || '?'}`);
    if (kv['在做']) {
      const tag = c.expired ? '【认领已过期，可以接手，先问一声】' : c.left ? `（认领还剩 ${howLong(c.left)}）` : '';
      out.push(`  在做：${kv['在做']} ${tag}`);
      if (kv['会动']) out.push(`  会动：${kv['会动']}`);
    } else out.push('  在做：没有认领');
    if (kv['下一步']) out.push(`  下一步：${kv['下一步']}`);
    if (kv['等谁拍板']) out.push(`  等谁拍板：${kv['等谁拍板']}`);
  }
  return out.join('\n');
}

function scheduleText() {
  const s = schedule();
  if (!s) return '现在没有登记比赛。';
  const now = Date.now();
  const out = [`${s.name}：${bj(s.start)} 开始，${bj(s.end)} 截止。`];
  const next = s.points.find((p) => p[1] > now);
  const prev = [...s.points].reverse().find((p) => p[1] <= now);
  if (now < s.start.getTime()) out.push(`还没开始，离开赛还有 ${howLong(s.start.getTime() - now)}。`);
  else if (!next) out.push('已经过了截止时间。');
  else {
    if (prev) out.push(`已经过了的时间点：${prev[0]}（${bj(new Date(prev[1]))}）。没做到就是落后了。`);
    out.push(`下一个时间点：${next[0]}（${bj(new Date(next[1]))}），还有 ${howLong(next[1] - now)}。`);
  }
  return out.join('\n');
}

function strandedText() {
  if (!hasRemote()) return '';
  const r = git(['for-each-ref', 'refs/remotes/origin', '--format=%(refname:short)', '--no-merged=HEAD'], { ok: true });
  const list = r.out.split('\n').filter((x) => x && x !== 'origin/HEAD' && x !== 'origin');
  return list.length ? list.map((x) => `- ${x}`).join('\n') : '';
}

function printStatus(opt) {
  sync(opt);
  say(`== 对表 ${bj()}（北京时间） ==`);
  say('\n【比赛和时间】');
  say(scheduleText());
  say('\n【已定的事】（只列现在有效的；agent 不许把定好的改回去）');
  say(onePagerText());
  say('\n【现状板】');
  say(boardText());
  const fb = listDocs('state/feedback').filter((d) => (d.kv['处理'] || '待处理') === '待处理');
  say(`\n【还没处理的试玩反馈】${fb.length ? '' : '没有'}`);
  for (const d of fb) say(`- ${d.body.split('\n')[0]}（${d.kv['谁说的'] || '?'}，版本 ${d.kv['版本'] || '?'}，${d.rel}）`);
  const logs = listDocs('state/log').slice(-3).reverse();
  say(`\n【最近的收工小结】${logs.length ? '' : '没有'}`);
  for (const d of logs) say(`- ${d.title}：做到哪：${d.kv['做到哪'] || '?'}；下一步：${d.kv['下一步'] || '?'}（${d.rel}）`);
  const st = strandedText();
  if (st) { say('\n【还没进主线的分支】（活停在这里，线上没有）'); say(st); }
  say('\n【线上是哪一版】还没接上，等“上线”命令建好。');
}

// ---------- 命令 ----------

const COMMANDS = {
  status: {
    help: '对表：谁在做什么、定了什么、离下一个时间点多久',
    run({ opt }) { printStatus(opt); },
  },

  start: {
    help: '开工：同步并读现状。读完用三句话复述，等人点头，再认领',
    run({ opt }) {
      printStatus(opt);
      say('\n== 接下来 ==');
      say('1. 用三句话向人复述：现在什么情况、我打算做什么、会动哪些地方。');
      say('2. 等人点头。');
      say('3. 认领：node kit/kit.mjs claim --who <人> --agent <工具名> --task "做什么" --paths "会动的目录,用逗号隔开"');
      say('4. 干完或者要停：node kit/kit.mjs done ...（见 skill/phases/daily.md）');
    },
  },

  claim: {
    help: '认领：在现状板写明做什么、会动哪里，并推上去',
    run({ opt }) {
      const me = whoAmI(opt);
      const task = str(opt.task);
      if (!task) fail('要写 --task "做什么"。');
      sync(opt);
      const mine = splitPaths(opt.paths);
      const clashes = [];
      for (const p of people()) {
        if (p.id === me.person.id) continue;
        const kv = readBoard(p).kv;
        if (!claimState(kv).active) continue;
        for (const a of mine) for (const b of splitPaths(kv['会动'])) if (overlaps(a, b)) clashes.push(`${p.name} 正在动 ${b}（${kv['在做']}）`);
      }
      if (clashes.length && !opt.anyway) {
        fail(`和别人的认领撞了：\n- ${clashes.join('\n- ')}\n避开这些地方，或者等对方收工。两个人说好了要一起动，就加 --anyway。`);
      }
      const b = readBoard(me.person);
      b.title = me.person.name;
      b.kv = { ...b.kv, 更新: bj(), agent: me.agent, 在做: task, 会动: mine.join(', '), 认领时间: bj(), 下一步: str(opt.next) || b.kv['下一步'] || '', 等谁拍板: b.kv['等谁拍板'] || '' };
      writeDoc(boardFile(me.person.id), b);
      const rel = `state/board/${me.person.id}.md`;
      commit([rel], `认领：${task}`, me);
      push();
      say(`已认领：${task}。${CLAIM_HOURS} 小时没动静会自动作废，没做完就再认领一次。`);
    },
  },

  done: {
    help: '收工：写五行小结、更新现状板、放开认领（加 --handoff 是交接，不放开认领）',
    run({ opt }) {
      const me = whoAmI(opt);
      const did = str(opt.did);
      if (!did) fail('要写 --did "做到哪"。五行是：--did 做到哪  --half 哪些改了一半  --verify 怎么验证  --next 下一步  --pitfalls 有什么坑');
      sync(opt);
      const id = uniqueId('state/log', `${stamp()}-${me.person.id}`);
      const rel = `state/log/${id}.md`;
      writeDoc(path.join(ROOT, rel), {
        title: `${bj()} ${me.person.name} / ${me.agent}${opt.handoff ? '（交接）' : ''}`,
        kv: { 做到哪: did, 改了一半的: str(opt.half) || '没有', 怎么验证: str(opt.verify) || '没写', 下一步: str(opt.next) || '没写', 有什么坑: str(opt.pitfalls) || '没有' },
        body: '',
      });
      const b = readBoard(me.person);
      b.title = me.person.name;
      const keep = Boolean(opt.handoff);
      b.kv = {
        ...b.kv, 更新: bj(), agent: keep ? `${me.agent}（交接中，等下一个 agent 接）` : me.agent,
        在做: keep ? b.kv['在做'] || '' : '', 会动: keep ? b.kv['会动'] || '' : '', 认领时间: keep ? bj() : '',
        下一步: str(opt.next) || '', 等谁拍板: opt.wait === undefined ? b.kv['等谁拍板'] || '' : str(opt.wait),
      };
      writeDoc(boardFile(me.person.id), b);
      const files = [rel, `state/board/${me.person.id}.md`];
      commit(files, `${keep ? '交接' : '收工'}：${did}`, me, Boolean(opt.all));
      push();
      const other = git(['status', '--porcelain'], { ok: true }).out.split('\n').filter((l) => l.trim());
      if (other.length) {
        say('\n提醒：还有没提交的改动，别的 agent 看不到：');
        for (const l of other.slice(0, 20)) say('  ' + l);
        say('是这次的活就提交并推上去，或者重新运行 done 并加 --all。');
      }
      say(keep ? '已交接。下一个 agent 先运行 start，用三句话复述再动手。' : '已收工，认领已放开。');
    },
  },

  decide: {
    help: '定了：记一条决定（--replaces 编号 取代旧的；--void 文件 给旧文档盖“已作废”）',
    run({ pos, opt }) {
      const me = whoAmI(opt);
      const text = pos.join(' ').trim();
      if (!text) fail('要写决定的内容，比如：decide "主视角用俯视" --topic 镜头');
      sync(opt);
      const files = addDecision(me, text, opt);
      commit(files, `定了：${text.slice(0, 40)}`, me);
      push();
    },
  },

  feedback: {
    help: '反馈：记一条试玩反馈，带上版本号',
    run({ pos, opt }) {
      const me = whoAmI(opt);
      const text = pos.join(' ').trim();
      if (!text) fail('要写反馈的原话，比如：feedback "手机上不是全屏"');
      sync(opt);
      const files = addFeedback(me, text, opt);
      commit(files, `反馈：${text.slice(0, 40)}`, me);
      push();
    },
  },

  ingest: {
    help: '把聊天工具输出的“决定卡”贴回仓库（--file 文件，或者从标准输入读）',
    run({ opt }) {
      const me = whoAmI(opt);
      const text = opt.file ? fs.readFileSync(path.resolve(str(opt.file)), 'utf8') : fs.readFileSync(0, 'utf8');
      const items = [];
      for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
        const m = /^\s*(?:[-*]\s*)?(定了|反馈)\s*[:：]\s*(.+)$/.exec(line);
        if (m) items.push([m[1], m[2].trim()]);
      }
      if (!items.length) fail('没找到以“定了：”或“反馈：”开头的行。决定卡的格式见 skill/phases/chat-tools.md。');
      sync(opt);
      const files = [];
      const source = str(opt.source) || '聊天工具';
      for (const [kind, t] of items) {
        if (kind === '定了') files.push(...addDecision(me, t, { ...opt, note: `来自${source}的决定卡` }));
        else files.push(...addFeedback(me, t, opt));
      }
      commit(files, `收口：从${source}贴回 ${items.length} 条`, me);
      push();
      say(`已贴回 ${items.length} 条。`);
    },
  },

  onepager: {
    help: '一页纸：由“已定的事”拼出来的一页说明',
    run({ opt }) { sync(opt); say(onePagerText()); },
  },

  opening: {
    help: '开场白：贴给只能聊天的工具（网页版 GPT、Claude），末尾带收口口令',
    run({ opt }) {
      sync(opt);
      say('（把下面整段贴给聊天工具）\n');
      say('你在帮一个两人小队做 3D 网页游戏黑客松。请用中文、大白话交流，不用术语。有不好的地方直说，给选项时讲清利弊。');
      say('\n下面是已经定下来的事，不要推翻。觉得哪条有问题，直接说出来，由人决定改不改。\n');
      say(onePagerText());
      say('\n现在两个人各自在做的事：\n');
      say(boardText());
      say('\n这次想聊的问题：' + (str(opt.question) || '（在这里写问题）'));
      say('\n聊完后我会说“收口”。听到“收口”，请只输出下面这种格式的决定卡，每条一行，不要别的话：\n');
      say('【决定卡】');
      say('- 定了：（一句话写清一条决定）');
      say('- 定了：（有几条写几条）');
      say('- 反馈：（聊天中我对游戏提出的意见，原话）');
    },
  },

  schedule: {
    help: '登记比赛时间：--name 名字 --start "2026-12-01 18:00" --deadline "2026-12-02 18:00"（北京时间）',
    run({ opt }) {
      const me = whoAmI(opt);
      if (!fromBj(str(opt.start)) || !fromBj(str(opt.deadline))) fail('时间要写成 "2026-12-01 18:00" 这样，按北京时间。--start 和 --deadline 都要有。');
      sync(opt);
      const rel = 'state/schedule.json';
      fs.writeFileSync(path.join(ROOT, rel), JSON.stringify({ name: str(opt.name) || '比赛', start: str(opt.start), deadline: str(opt.deadline) }, null, 2) + '\n');
      commit([rel], `登记比赛时间：${str(opt.name) || '比赛'}`, me);
      push();
      say(scheduleText());
    },
  },

  whoami: {
    help: '登记这台机器是替谁干活的：--who lead|mate --agent 工具名 --save',
    run({ opt }) {
      const me = whoAmI(opt);
      if (opt.save) {
        fs.writeFileSync(path.join(ROOT, '.kit-local.json'), JSON.stringify({ who: me.person.id, agent: me.agent }, null, 2) + '\n');
        say('已记在这台机器上（.kit-local.json，不会进仓库）。');
      }
      say(`你是替 ${me.person.name} 干活的，工具是 ${me.agent}。`);
    },
  },

  doctor: {
    help: '体检：这台机器能不能干活、缺什么',
    run({ opt }) {
      const rows = [];
      const add = (ok, what, fix = '') => rows.push(`${ok ? '行' : '不行'}  ${what}${ok || !fix ? '' : '  → ' + fix}`);
      const major = Number(process.versions.node.split('.')[0]);
      add(major >= 18, `Node ${process.versions.node}`, '装 Node 18 或更新的版本');
      const gv = spawnSync('git', ['--version'], { encoding: 'utf8' });
      add(gv.status === 0, gv.status === 0 ? gv.stdout.trim() : 'git', '装 git');
      const name = git(['config', 'user.name'], { ok: true }).out;
      add(Boolean(name), `git 署名：${name || '没设'}`, '没设的话，提交会带上这台电脑的系统账户名。本套命令提交时会自动用 state/people.json 里的名字，其他提交要自己设');
      add(hasRemote(), '仓库连着 GitHub（origin）', '还没连，改动只在本地');
      if (hasRemote()) {
        const ls = git(['ls-remote', '--heads', 'origin'], { ok: true });
        add(ls.ok, '能读 GitHub 上的仓库', '检查网络和登录');
        const dry = git(['push', '--dry-run', 'origin', branch()], { ok: true });
        add(dry.ok, '能往 GitHub 推', '没有写权限，或者没登录。推不上去的工具改用“投递包”（还没建）');
      }
      const local = readJSON(path.join(ROOT, '.kit-local.json')) || {};
      const who = str(opt.who) || process.env.KIT_WHO || local.who;
      add(Boolean(who && findPerson(who)), `知道替谁干活：${who || '不知道'}`, '运行 whoami --who <人> --agent <工具名> --save');
      const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
      add(gh.status === 0, 'gh 已登录（建仓库、开 Pages 要用；只写代码用不到）', '用不到可以不管');
      say(`== 体检 ${bj()} ==`);
      say(`系统：${process.platform}`);
      for (const r of rows) say(r);
    },
  },
};

function addDecision(me, text, opt) {
  const id = uniqueId('state/decisions', `${stamp().slice(4)}-${me.person.id}`); // 1110-2250-lead
  const rel = `state/decisions/${id}.md`;
  const files = [rel];
  const kv = {
    编号: id, 时间: bj(), 谁定的: str(opt.by) || me.person.name, 记录: `${me.person.name} / ${me.agent}`,
    话题: str(opt.topic) || '其他', 状态: '有效',
  };
  const replaces = str(opt.replaces);
  if (replaces) {
    const old = path.join(ROOT, 'state', 'decisions', `${replaces}.md`);
    if (!fs.existsSync(old)) fail(`找不到要取代的那条：${replaces}。运行 onepager 看编号。`);
    const d = readDoc(old);
    d.kv['状态'] = `已被 ${id} 取代`;
    writeDoc(old, d);
    kv['取代'] = replaces;
    files.push(`state/decisions/${replaces}.md`);
  }
  const title = str(opt.title) || (text.length > 40 ? text.slice(0, 40) + '…' : text);
  const body = [text, str(opt.note)].filter(Boolean).join('\n\n');
  writeDoc(path.join(ROOT, rel), { title, kv, body });
  for (const v of splitPaths(opt.void)) {
    const f = path.join(ROOT, v);
    if (!fs.existsSync(f)) fail(`找不到要盖“已作废”的文件：${v}`);
    const old = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, `> **已作废**（${bj()}）。现在算数的是 ${rel}。\n\n${old}`);
    files.push(v);
  }
  say(`已记下，编号 ${id}：${title}`);
  return files;
}

function addFeedback(me, text, opt) {
  const id = uniqueId('state/feedback', `${stamp()}-${me.person.id}`);
  const rel = `state/feedback/${id}.md`;
  writeDoc(path.join(ROOT, rel), {
    title: text.length > 40 ? text.slice(0, 40) + '…' : text,
    kv: { 时间: bj(), 谁说的: str(opt.by) || me.person.name, 记录: `${me.person.name} / ${me.agent}`, 版本: str(opt.version) || '还没有版本号', 处理: '待处理' },
    body: text,
  });
  say(`已记下反馈：${text.slice(0, 40)}`);
  return [rel];
}

// ---------- 入口 ----------

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || !COMMANDS[cmd]) {
  if (cmd && cmd !== 'help') console.error(`没有这条命令：${cmd}\n`);
  say('用法：node kit/kit.mjs <命令> [参数]\n');
  for (const [k, v] of Object.entries(COMMANDS)) say(`  ${k.padEnd(9)} ${v.help}`);
  say('\n大多数命令要写明是谁：--who lead|mate --agent 工具名（比如 cursor、kiro、workbuddy）。');
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
const ROOT = findRoot();
COMMANDS[cmd].run(parseArgs(rest));
