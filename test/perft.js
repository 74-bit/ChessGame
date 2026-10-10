/*
 * 走法生成正确性测试（perft）
 * 中国象棋初始局面的标准节点数：
 *   depth 1 = 44
 *   depth 2 = 1920
 *   depth 3 = 79666
 *   depth 4 = 3290240
 * 运行：bun test/perft.js
 */
const fs = require('fs');
const path = require('path');

const global_ = {};
new Function('window', fs.readFileSync(path.join(__dirname, '../js/rules.js'), 'utf8'))(global_);
const XQ = global_.Xiangqi;

function perft(bd, side, depth) {
  if (depth === 0) return 1;
  const moves = XQ.genLegalMoves(bd, side);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) {
    const cap = XQ.makeMove(bd, m);
    n += perft(bd, -side, depth - 1);
    XQ.unmakeMove(bd, m, cap);
  }
  return n;
}

const EXPECTED = [1, 44, 1920, 79666, 3290240];
let pass = true;

for (let d = 1; d <= 4; d++) {
  const bd = XQ.parseFen(XQ.START_FEN);
  const t0 = Date.now();
  const got = perft(bd, 1, d);
  const ok = got === EXPECTED[d];
  if (!ok) pass = false;
  console.log(
    `perft(${d}) = ${got}  期望 ${EXPECTED[d]}  ${ok ? '✓' : '✗ 不一致'}  (${Date.now() - t0}ms)`
  );
}

/* ---- 规则细节单测 ---- */

function boardFrom(rows) {
  // rows: 10 个字符串，每个 9 个字符，'.' 表示空
  const bd = new Int8Array(90);
  const map = { K: 1, A: 2, B: 3, N: 4, R: 5, C: 6, P: 7 };
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const ch = rows[r][c];
      if (ch === '.') continue;
      const type = map[ch.toUpperCase()];
      bd[r * 9 + c] = (ch === ch.toLowerCase()) ? -type : type;
    }
  }
  return bd;
}

function targets(bd, side, from) {
  return XQ.genMoves(bd, side, [])
    .filter((m) => XQ.moveFrom(m) === from)
    .map((m) => XQ.moveTo(m));
}

function check(name, cond, extra) {
  if (!cond) pass = false;
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + (extra || '')}`);
}

/* 白脸将：中间无子时可将死对方 */
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
  check('白脸将 - 将被视为被攻击', XQ.isKingAttacked(bd, 1) === true);
  check('白脸将 - 生成飞将吃子着法', targets(bd, 1, 85).includes(4));
}

/* 蹩马腿 */
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
    '....K...N'
  ]);
  // 马在 (9,8) -> (7,7)，马腿在 (8,8)
  check('马腿通畅时能走两格', targets(bd, 1, 89).includes(7 * 9 + 7));
  bd[8 * 9 + 8] = XQ.P; // 塞住马腿
  check('蹩马腿后不能走', !targets(bd, 1, 89).includes(7 * 9 + 7));
}

/* 塞象眼 + 象不过河 */
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
    '....K..B.'
  ]);
  // 象在 (9,7) -> 可到 (7,5)，中点在 (8,6)
  check('象走田', targets(bd, 1, 88).includes(7 * 9 + 5));
  bd[8 * 9 + 6] = XQ.P;
  check('塞象眼后不能走', !targets(bd, 1, 88).includes(7 * 9 + 5));
  // 河界：红象不能到 row 4
  const bd2 = boardFrom([
    '....k....', '.........', '.........', '.........', '.........',
    '.....B...', '.........', '.........', '.........', '....K....'
  ]);
  const t = targets(bd2, 1, 5 * 9 + 5);
  check('象不能过河', t.every((sq) => (sq / 9 | 0) >= 5), JSON.stringify(t));
}

/* 炮：隔一子吃，不能隔子走 */
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
    '..C.K....'
  ]);
  bd[9 * 9 + 4] = 0; // 移开帅，方便观察
  bd[9 * 9 + 3] = 0;
  const t = targets(bd, 1, 9 * 9 + 2); // 炮在 (9,2)
  check('炮可沿空线平移', t.includes(9 * 9 + 8));
}

/* 过河兵可以横走：红方河界在 row 4/5 之间，兵到 row 4 即为过河 */
{
  const bd = boardFrom([
    '....k....', '.........', '.........', '.........', '....P....',
    '.........', '.........', '.........', '.........', '....K....'
  ]);
  const t = targets(bd, 1, 4 * 9 + 4);
  check('过河兵可前进', t.includes(3 * 9 + 4));
  check('过河兵可横走', t.includes(4 * 9 + 3) && t.includes(4 * 9 + 5));
  const bd2 = boardFrom([
    '....k....', '.........', '.........', '.........', '.........',
    '.........', '....P....', '.........', '.........', '....K....'
  ]);
  const t2 = targets(bd2, 1, 6 * 9 + 4);
  check('未过河兵不能横走', !t2.includes(6 * 9 + 3) && !t2.includes(6 * 9 + 5));
}

/* 困毙判负 */
{
  const bd = boardFrom([
    '....k....', '.........', '.........', '.........', '.........',
    '.........', '.........', '.........', '.........', '.R..K....'
  ]);
  // 黑将被红车逼到底线，检查状态判定函数不崩
  check('被将军时 inCheck 为真',
    XQ.inCheck(boardFrom([
      '....k....', '.........', '.........', '.........', '.........',
      '.........', '.........', '.........', '.........', '....K..R.'
    ]), -1) === true);
}

console.log(pass ? '\n全部通过 ✓' : '\n存在失败项 ✗');
process.exit(pass ? 0 : 1);
