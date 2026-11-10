#!/usr/bin/env node
// 自查：在临时目录里搭一个“GitHub”和两台“电脑”，把口令走一遍，包括两边同时推。
// 用法：node kit/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kit.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-'));
let failed = 0;

function sh(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}
const kit = (cwd, args, input) => sh(process.execPath, [KIT, ...args], cwd, input);
function check(name, cond, detail = '') {
  if (cond) console.log(`通过  ${name}`);
  else { failed++; console.log(`没过  ${name}\n${detail}`); }
}
const ID = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];

// 搭环境
const remote = path.join(tmp, 'remote.git');
const A = path.join(tmp, 'a');
const B = path.join(tmp, 'b');
sh('git', ['init', '-q', '--bare', '-b', 'main', remote], tmp);
sh('git', ['clone', '-q', remote, A], tmp);
fs.mkdirSync(path.join(A, 'state'), { recursive: true });
fs.writeFileSync(path.join(A, 'state', 'people.json'), JSON.stringify({ people: [
  { id: 'lead', name: '队长', github: 'lead-gh', gitName: 'lead-gh', gitEmail: 'lead@example.invalid', publisher: true },
  { id: 'mate', name: '队友', github: 'mate-gh', gitName: 'mate-gh', gitEmail: 'mate@example.invalid' },
] }, null, 2));
fs.writeFileSync(path.join(A, 'old-plan.md'), '# 旧方案\n');
sh('git', ['checkout', '-q', '-b', 'main'], A);
sh('git', ['add', '-A'], A);
sh('git', [...ID, 'commit', '-q', '-m', 'init'], A);
sh('git', ['push', '-q', '-u', 'origin', 'main'], A);
sh('git', ['clone', '-q', remote, B], tmp);

const L = ['--who', 'lead', '--agent', 'cursor'];
const M = ['--who', 'mate', '--agent', 'kiro'];
let r;

r = kit(A, ['claim', ...L, '--task', '做第一关', '--paths', 'levels/one, shell/camera']);
check('队长认领', r.ok && r.out.includes('已认领'), r.out);

r = kit(B, ['claim', ...M, '--task', '改镜头', '--paths', 'shell/camera/orbit']);
check('队友认领撞车会被拦住', !r.ok && r.out.includes('撞了'), r.out);

r = kit(B, ['claim', ...M, '--task', '做第二关', '--paths', 'levels/two']);
check('队友认领别的地方能过', r.ok, r.out);

// 两边都不先同步，直接各记一条：后推的那边要自动接在前面那条后面
r = kit(A, ['decide', ...L, '--no-sync', '主视角用俯视', '--topic', '镜头']);
check('队长记决定', r.ok, r.out);
r = kit(B, ['decide', ...M, '--no-sync', '主角是奶蛙', '--topic', '主角']);
check('队友同时记决定，不丢不盖', r.ok && r.out.includes('已推上'), r.out);

r = kit(A, ['onepager']);
check('两条决定两边都看得到', r.out.includes('主视角用俯视') && r.out.includes('主角是奶蛙'), r.out);

const first = fs.readdirSync(path.join(A, 'state', 'decisions')).find((f) => f.includes('lead')).replace('.md', '');
r = kit(A, ['decide', ...L, '主视角改成第三人称', '--topic', '镜头', '--replaces', first, '--void', 'old-plan.md']);
check('新决定取代旧决定', r.ok, r.out);
r = kit(B, ['onepager']);
check('被取代的不再出现在一页纸里', r.out.includes('主视角改成第三人称') && !r.out.includes('主视角用俯视'), r.out);
check('旧文档盖了已作废', fs.readFileSync(path.join(B, 'old-plan.md'), 'utf8').startsWith('> **已作废**'));

r = kit(B, ['feedback', ...M, '手机上不是全屏', '--version', 'v3']);
check('记反馈', r.ok, r.out);

r = kit(A, ['ingest', ...L, '--source', 'GPT'], '【决定卡】\n- 定了：一局九十秒\n- 反馈：开场对话太多\n随便一行\n');
check('决定卡贴回', r.ok && r.out.includes('已贴回 2 条'), r.out);

r = kit(A, ['done', ...L, '--did', '第一关能走了', '--half', '没有', '--verify', '打开 index.html', '--next', '加怪', '--pitfalls', '地面不平']);
check('队长收工', r.ok && r.out.includes('已收工'), r.out);

r = kit(B, ['status', ...M]);
check('队友对表能看到队长的小结和决定', r.out.includes('第一关能走了') && r.out.includes('一局九十秒') && r.out.includes('开场对话太多'), r.out);
check('队长的认领已放开', /队长（发布人）[^\n]*\n\s+在做：没有认领/.test(r.out), r.out);

r = kit(A, ['status', ...L]);
const strip = (s) => s.replace(/== 对表[^\n]*\n/, '').replace(/认领还剩[^）]*/g, '');
check('同一句对表，两台机器答的一样', strip(r.out) === strip(kit(B, ['status', ...M]).out));

r = kit(A, ['schedule', ...L, '--name', '演习', '--start', '2020-01-01 09:00', '--deadline', '2099-01-01 18:00']);
check('登记比赛时间', r.ok && r.out.includes('下一个时间点'), r.out);

const log = sh('git', ['log', '--format=%an|%b', '-n', '30'], B).out;
check('提交写明是谁和哪个 agent', log.includes('谁做的: 队长 / cursor') || sh('git', ['pull', '-q'], B).ok && sh('git', ['log', '--format=%an|%b'], B).out.includes('谁做的: 队长 / cursor'));
check('提交署名用的是 people.json 里的名字', sh('git', ['log', '--format=%an'], B).out.includes('mate-gh'));

r = kit(A, ['claim', '--task', 'x']);
check('没写是谁会被拦住', !r.ok && r.out.includes('不知道你是替谁干活的'), r.out);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n有 ${failed} 项没过。` : '\n全部通过。');
process.exit(failed ? 1 : 0);
