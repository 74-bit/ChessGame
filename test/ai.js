/*
 * AI 测试：杀棋识别、合法性、搜索速度
 * 运行：bun test/ai.js
 */
const fs = require('fs');
const path = require('path');

const g = {};
const load = (f) => new Function('window', fs.readFileSync(path.join(__dirname, '../js', f), 'utf8'))(g);
load('rules.js');
load('ai.js');

const XQ = g.Xiangqi;
const AI = g.XiangqiAI;
const RED = 1, BLACK = -1;

let pass = true;
const check = (name, cond, extra) => {
  if (!cond) pass = false;
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + (extra || '')}`);
};

const MAP = { K: 1, A: 2, B: 3, N: 4, R: 5, C: 6, P: 7 };
function boardFrom(rows) {
  const bd = new Int8Array(90);
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const ch = rows[r][c];
      if (ch === '.') continue;
      const type = MAP[ch.toUpperCase()];
      bd[r * 9 + c] = (ch === ch.toLowerCase()) ? -type : type;
    }
  }
  return bd;
}
const name = (m) => `(${((m / 90) | 0) / 9 | 0},${((m / 90) | 0) % 9})->(${((m % 90) / 9) | 0},${(m % 90) % 9})`;

/* ---- 1. 一步杀 ---- */
{
  // 红方 R(5,8) 平到 (0,8) 后：黑将 (0,4) 被横线将军，
  // 底线两格与二线三格均被另一车控制 -> 将死
  // 红 R(1,0) 控二线、R(5,8) 平到 (0,8) 控底线 -> 将死
  const bd = boardFrom([
    '....k....',
    'R........',
    '.........',
    '.........',
    '.........',
    '........R',
    '.........',
    '.........',
    '.........',
    '...K.....'
  ]);
  const t0 = Date.now();
  const m = AI.search(bd, RED, 4, 3000);
  const dt = Date.now() - t0;

  // 这个局面里有多手必胜（将死或困毙均可），只断言结果性质
  check('AI 走出一手必胜着法', m !== null && (() => {
    if (m === null) return false;
    const cap = XQ.makeMove(bd, m);
    const replies = XQ.genLegalMoves(bd, BLACK);
    XQ.unmakeMove(bd, m, cap);
    return replies.length === 0;
  })(), `实际走 ${m === null ? 'null' : name(m)}`);
  check('必胜着法在极短时间内找到', dt < 200, `${dt}ms`);
  console.log(`  （耗时 ${dt}ms）`);
}

/* ---- 2. 被将军时必须应将 ---- */
{
  // 黑车在 (0,4) 直线上将军红帅 (9,4)？红帅在 (9,4)，中间放红仕挡
  const bd = boardFrom([
    '....k....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....K...r'
  ]);
  // 黑车 (9,8) 沿底线将军红帅 (9,4)
  check('构造局面确实被将军', XQ.inCheck(bd, RED));
  const m = AI.search(bd, RED, 4, 2000);
  check('被将军时能找到着法', m !== null);
  if (m !== null) {
    const cap = XQ.makeMove(bd, m);
    const stillCheck = XQ.inCheck(bd, RED);
    XQ.unmakeMove(bd, m, cap);
    check('应将后不再被将军', !stillCheck, `走了 ${name(m)}`);
  }
}

/* ---- 3. 白脸将属于非法着法，AI 不得走出 ---- */
{
  const bd = boardFrom([
    '....k....',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '.........',
    '....K....'
  ]);
  // 初始就已白脸，红方任何"让开"的着法都不该出现；
  // 这里直接验证合法着法生成器不会返回导致白脸的走法
  const legal = XQ.genLegalMoves(bd, RED);
  const bad = legal.filter((m) => {
    const cap = XQ.makeMove(bd, m);
    const r = XQ.isKingAttacked(bd, RED);
    XQ.unmakeMove(bd, m, cap);
    return r;
  });
  check('合法着法中无自将着法', bad.length === 0, `${bad.length} 步违规`);
}

/* ---- 4. 不送吃：白送车应被拒绝 ---- */
{
  // 红车 (5,0) 若走到 (4,0) 会被黑卒 (3,0) 白吃？卒只前进，改用车对峙
  // 黑车在 (0,0)，红车在 (5,0)，中间无子：红车走到 (4,0) 会被吃
  const bd = boardFrom([
    'r...k....',
    '.........',
    '.........',
    '.........',
    '.........',
    'R........',
    '.........',
    '.........',
    '.........',
    '....K....'
  ]);
  const m = AI.search(bd, RED, 4, 2000);
  const suicide = XQ.move(5 * 9 + 0, 4 * 9 + 0);
  check('不主动送车给对方吃', m !== suicide, `实际走了 ${name(m)}`);
}

/* ---- 5. 搜索速度 ---- */
{
  console.log('\n搜索速度（初始局面）：');
  for (const [label, depth, time] of [['简单', 2, 600], ['普通', 4, 1800], ['困难', 6, 4000]]) {
    const bd = XQ.parseFen(XQ.START_FEN);
    const t0 = Date.now();
    const m = AI.search(bd, RED, depth, time);
    const dt = Date.now() - t0;
    const legal = XQ.genLegalMoves(bd, RED).includes(m);
    check(`${label} depth=${depth} 返回合法着法`, m !== null && legal, `${name(m)} / ${dt}ms`);
    const st = AI.stats();
    console.log(`     耗时 ${dt}ms，搜索 ${st.nodes} 个结点，${st.aborted ? '时间到提前收手' : '完整搜完'}`);
  }
}

/* ---- 5b. 困毙（无棋可走）在象棋中同样判负，AI 应当认可 ---- */
{
  const bd = boardFrom([
    '....k....',
    'R........',
    '.........',
    '.........',
    '.........',
    '........R',
    '.........',
    '.........',
    '.........',
    '...K.....'
  ]);
  const m = AI.search(bd, RED, 4, 2000);
  const cap = XQ.makeMove(bd, m);
  const replies = XQ.genLegalMoves(bd, BLACK);
  XQ.unmakeMove(bd, m, cap);
  check('能识别必胜（将死或困毙）', replies.length === 0);
}

/* ---- 6. 自我对弈 40 回合，检查全程无非法着法 ---- */
{
  console.log('\n自我对弈：');
  const bd = XQ.parseFen(XQ.START_FEN);
  let side = RED;
  let plies = 0;
  let ok = true;
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) {
    const legal = XQ.genLegalMoves(bd, side);
    if (legal.length === 0) break;
    const m = AI.search(bd, side, 3, 400);
    if (m === null || !legal.includes(m)) { ok = false; console.log(`  ✗ 第 ${i + 1} 手非法: ${m}`); break; }
    XQ.makeMove(bd, m);
    side = -side;
    plies++;
  }
  check(`自我对弈 ${plies} 手全部合法`, ok);
  console.log(`  （耗时 ${Date.now() - t0}ms）`);
}

console.log(pass ? '\n全部通过 ✓' : '\n存在失败项 ✗');
process.exit(pass ? 0 : 1);
