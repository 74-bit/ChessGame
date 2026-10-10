/*
 * 中国象棋 AI
 *
 * 搜索：negamax + alpha-beta + 迭代加深 + 静态搜索(quiescence)
 *   - PVS：首个着法全窗口，其余先用零窗口试探，超出再重搜
 *   - LMR：靠后的安静着法先降深度搜，超出预期再补一次全深度
 *   - null-move 剪枝：不将军时先"白让一手"，对手仍占不到便宜就直接剪掉
 *   - 置换表：Zobrist 哈希 + 深度/边界校验，跨层甚至跨回合复用
 *   着法排序：置换表着法 → MVV-LVA → killer → history
 *
 * 两个贯穿全局的约定：
 *   1. 搜索内部用伪合法着法，靠"吃到将/帅即判胜"兜底。
 *      省掉每个结点 O(40) 次自将判定；根结点仍只走完全合法着法。
 *   2. 工厂函数写法，便于 toString() 后注入 Blob Worker，
 *      让搜索不占用主线程（否则动画会被卡住）。
 */
function XiangqiAIEngine(global) {
  'use strict';

  var XQ = global.Xiangqi;
  var K = 1, A = 2, B = 3, N = 4, R = 5, C = 6, P = 7;

  var MATE = 30000;
  var MATE_BOUND = MATE - 1000;
  var INF = 1e9;
  var MAXPLY = 64;

  /* 子力价值，索引 = 兵种 */
  var VALUES = [0, 10000, 200, 200, 400, 900, 450, 100];

  /* 位置价值表，红方视角，第 0 行 = 黑方底线（左右对称，黑方只需上下镜像） */
  var PST = {};

  PST[P] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    9, 9, 9, 11, 13, 11, 9, 9, 9,
    19, 24, 34, 42, 44, 42, 34, 24, 19,
    19, 24, 32, 37, 37, 37, 32, 24, 19,
    19, 23, 27, 29, 30, 29, 27, 23, 19,
    14, 18, 20, 27, 29, 27, 20, 18, 14,
    7, 0, 13, 0, 16, 0, 13, 0, 7,
    7, 0, 7, 0, 15, 0, 7, 0, 7,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0
  ];

  PST[R] = [
    14, 14, 12, 18, 16, 18, 12, 14, 14,
    16, 20, 18, 24, 26, 24, 18, 20, 16,
    12, 12, 12, 18, 18, 18, 12, 12, 12,
    12, 18, 16, 22, 22, 22, 16, 18, 12,
    12, 14, 12, 18, 18, 18, 12, 14, 12,
    12, 16, 14, 20, 20, 20, 14, 16, 12,
    6, 10, 8, 14, 14, 14, 8, 10, 6,
    4, 8, 6, 14, 12, 14, 6, 8, 4,
    8, 4, 8, 16, 8, 16, 8, 4, 8,
    -2, 10, 6, 14, 12, 14, 6, 10, -2
  ];

  PST[N] = [
    4, 8, 16, 12, 4, 12, 16, 8, 4,
    4, 10, 28, 16, 8, 16, 28, 10, 4,
    12, 14, 16, 20, 18, 20, 16, 14, 12,
    8, 24, 18, 24, 20, 24, 18, 24, 8,
    6, 16, 14, 18, 16, 18, 14, 16, 6,
    4, 12, 16, 14, 12, 14, 16, 12, 4,
    2, 6, 8, 6, 10, 6, 8, 6, 2,
    4, 2, 8, 8, 4, 8, 8, 2, 4,
    0, 2, 4, 4, -2, 4, 4, 2, 0,
    0, -4, 0, 0, 0, 0, 0, -4, 0
  ];

  PST[C] = [
    6, 4, 0, -10, -12, -10, 0, 4, 6,
    2, 2, 0, -4, -14, -4, 0, 2, 2,
    2, 2, 0, -10, -8, -10, 0, 2, 2,
    0, 0, -2, 4, 10, 4, -2, 0, 0,
    0, 0, 0, 2, 8, 2, 0, 0, 0,
    -2, 0, 4, 2, 6, 2, 4, 0, -2,
    0, 0, 0, 2, 4, 2, 0, 0, 0,
    4, 0, 8, 6, 10, 6, 8, 0, 4,
    0, 2, 4, 6, 6, 6, 4, 2, 0,
    0, 0, 2, 6, 6, 6, 2, 0, 0
  ];

  PST[A] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 1, 0, 1, 0, 0, 0,
    0, 0, 0, 0, 3, 0, 0, 0, 0,
    0, 0, 0, 1, 0, 1, 0, 0, 0
  ];

  PST[B] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 1, 0, 0, 0, 1, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 2, 0, 0, 0, 2, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 2, 0, 0, 0, 2, 0, 0
  ];

  PST[K] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, -4, -4, -4, 0, 0, 0,
    0, 0, 0, -2, -2, -2, 0, 0, 0,
    0, 0, 0, 2, 4, 2, 0, 0, 0
  ];

  /*
   * 从 side 视角评估局面（正数表示 side 占优）。
   *
   * 除了子力 + 位置表，还有两项能拉开差距、也真正影响胜负的因素：
   *   1. 缺士怕车 —— 对方车马炮越多，己方缺士象的代价越大
   *   2. 车占开放线 —— 所在纵线双方都没兵时，车的价值明显更高
   * 只做一次 90 格扫描，顺带把判断需要的素材统计出来，几乎不增加开销。
   */
  function evaluate(bd, side) {
    var score = 0;
    var guards = [0, 0];        /* 士 + 象 的剩余数量，上限 4 */
    var heavy = [0, 0];         /* 车马炮数量 */
    var rookCols = [[], []];
    var pawnCols = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]];
    var i, p, red, t, r, c, pr, v, k;

    for (i = 0; i < 90; i++) {
      p = bd[i];
      if (p === 0) continue;
      red = p > 0;
      t = red ? p : -p;
      r = (i / 9) | 0;
      c = i % 9;
      pr = red ? r : 9 - r;
      v = VALUES[t] + PST[t][pr * 9 + c];
      score += red ? v : -v;

      k = red ? 0 : 1;
      if (t === A || t === B) guards[k]++;
      else if (t === R || t === C || t === N) heavy[k]++;
      if (t === R) rookCols[k].push(c);
      if (t === P) pawnCols[k][c]++;
    }

    /* 缺士怕车：对方重子越多，己方少一个士/象越危险 */
    var redMissing = 4 - guards[0];
    var blackMissing = 4 - guards[1];
    if (heavy[1] >= 2 && redMissing > 0) {
      score -= redMissing * 11 * Math.min(heavy[1], 4) / 2;
    }
    if (heavy[0] >= 2 && blackMissing > 0) {
      score += blackMissing * 11 * Math.min(heavy[0], 4) / 2;
    }

    /* 车占开放线 */
    for (i = 0; i < rookCols[0].length; i++) {
      c = rookCols[0][i];
      if (!pawnCols[0][c] && !pawnCols[1][c]) score += 14;
      else if (!pawnCols[0][c]) score += 6;
    }
    for (i = 0; i < rookCols[1].length; i++) {
      c = rookCols[1][i];
      if (!pawnCols[0][c] && !pawnCols[1][c]) score -= 14;
      else if (!pawnCols[1][c]) score -= 6;
    }

    return side > 0 ? score : -score;
  }

  /* ---- Zobrist 哈希 ---- */
  var ZOB = [];
  var zobSide = 0;
  (function initZobrist() {
    var s = 0x9e3779b9 | 0;
    function rnd() {
      s ^= s << 13; s |= 0;
      s ^= s >>> 17;
      s ^= s << 5; s |= 0;
      return s;
    }
    for (var i = 0; i < 90; i++) {
      var row = new Int32Array(15);
      for (var j = 0; j < 15; j++) row[j] = rnd();
      ZOB.push(row);
    }
    zobSide = rnd();
  })();

  function computeKey(bd, side) {
    var k = 0;
    for (var i = 0; i < 90; i++) {
      var p = bd[i];
      if (p !== 0) k ^= ZOB[i][p + 7];
    }
    return side < 0 ? (k ^ zobSide) : k;
  }

  /* ---- 置换表 ---- */
  var TT_BITS = 19;
  var TT_SIZE = 1 << TT_BITS;
  var TT_MASK = TT_SIZE - 1;
  var ttKey = new Int32Array(TT_SIZE);
  var ttMove = new Int32Array(TT_SIZE);
  var ttScore = new Int32Array(TT_SIZE);
  var ttDepth = new Int8Array(TT_SIZE);
  var ttFlag = new Int8Array(TT_SIZE);

  var TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;

  /* ---- 搜索状态 ---- */
  var nodes = 0;
  var deadline = 0;
  var aborted = false;
  var curKey = 0;
  var lastInfo = null;

  var movePool = [];
  var scorePool = [];
  var capPool = [];
  for (var i = 0; i < MAXPLY; i++) {
    movePool.push([]);
    scorePool.push([]);
    capPool.push([]);
  }

  var killers = [];
  for (i = 0; i < MAXPLY; i++) killers.push([0, 0]);
  var historyTable = new Int32Array(90 * 90);

  /* 走子并同步维护 Zobrist key，返回被吃子 */
  function doMove(bd, m) {
    var from = (m / 90) | 0, to = m % 90;
    var pc = bd[from], cap = bd[to];
    bd[to] = pc;
    bd[from] = 0;
    curKey ^= ZOB[from][pc + 7] ^ ZOB[to][pc + 7] ^ zobSide;
    if (cap !== 0) curKey ^= ZOB[to][cap + 7];
    return cap;
  }

  function undoMove(bd, m, cap) {
    var from = (m / 90) | 0, to = m % 90;
    var pc = bd[to];
    bd[from] = pc;
    bd[to] = cap;
    curKey ^= ZOB[from][pc + 7] ^ ZOB[to][pc + 7] ^ zobSide;
    if (cap !== 0) curKey ^= ZOB[to][cap + 7];
  }

  function capScore(bd, m) {
    var victim = bd[m % 90];
    if (victim === 0) return 0;
    var vt = victim > 0 ? victim : -victim;
    var from = (m / 90) | 0;
    var at = bd[from] > 0 ? bd[from] : -bd[from];
    return VALUES[vt] * 16 - VALUES[at];
  }

  function scoreMove(bd, m, ply, ttMv) {
    if (m === ttMv) return 2000000;
    var to = m % 90;
    if (bd[to] !== 0) return 1000000 + capScore(bd, m);
    var k = killers[ply];
    if (k[0] === m) return 900000;
    if (k[1] === m) return 890000;
    return historyTable[((m / 90) | 0) * 90 + to];
  }

  /* 插入排序：着法少且大多接近有序，比 Array.sort 更快 */
  function orderMoves(bd, moves, ply, ttMv) {
    var n = moves.length;
    if (n < 2) return;
    var sc = scorePool[ply];
    for (var i = 0; i < n; i++) sc[i] = scoreMove(bd, moves[i], ply, ttMv);
    for (i = 1; i < n; i++) {
      var mv = moves[i], s = sc[i];
      var j = i - 1;
      while (j >= 0 && sc[j] < s) {
        moves[j + 1] = moves[j];
        sc[j + 1] = sc[j];
        j--;
      }
      moves[j + 1] = mv;
      sc[j + 1] = s;
    }
  }

  function timeUp() {
    if ((nodes & 511) === 0 && Date.now() > deadline) aborted = true;
    return aborted;
  }

  /* 除将、兵外是否还有子力。null-move 需要它来避开残局 zugzwang */
  function hasNonPawnMaterial(bd, side) {
    for (var i = 0; i < 90; i++) {
      var p = bd[i];
      if (p === 0 || (p > 0 ? 1 : -1) !== side) continue;
      var t = p > 0 ? p : -p;
      if (t !== K && t !== P) return true;
    }
    return false;
  }

  /* 静态搜索：只扩展吃子，避免"水平线效应" */
  function quiesce(bd, side, alpha, beta, ply) {
    if (timeUp()) return 0;
    nodes++;

    var stand = evaluate(bd, side);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (ply >= MAXPLY - 2) return alpha;

    var moves = movePool[ply];
    XQ.genMoves(bd, side, moves);

    var caps = capPool[ply];
    caps.length = 0;
    for (var i = 0; i < moves.length; i++) {
      if (bd[moves[i] % 90] !== 0) caps.push(moves[i]);
    }
    if (caps.length === 0) return alpha;

    /* 先用被吃子价值粗排，够用了 */
    for (i = 1; i < caps.length; i++) {
      var mv = caps[i], s = capScore(bd, mv), j = i - 1;
      while (j >= 0 && capScore(bd, caps[j]) < s) { caps[j + 1] = caps[j]; j--; }
      caps[j + 1] = mv;
    }

    for (i = 0; i < caps.length; i++) {
      var m = caps[i];
      var captured = XQ.makeMove(bd, m);
      var score;
      if (captured === -side * K) {
        XQ.unmakeMove(bd, m, captured);
        return MATE - ply;
      }
      score = -quiesce(bd, -side, -beta, -alpha, ply + 1);
      XQ.unmakeMove(bd, m, captured);
      if (aborted) return 0;
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function negamax(bd, side, depth, alpha, beta, ply, canNull) {
    if (timeUp()) return 0;
    nodes++;

    var isPv = (beta - alpha) > 1;
    var inChk = XQ.isKingAttacked(bd, side);

    /* 被将军时延伸一层，免得在将军线路上看漏 */
    if (inChk) depth++;

    if (depth <= 0) return quiesce(bd, side, alpha, beta, ply);

    var ttIdx = curKey & TT_MASK;
    var ttHit = (ttKey[ttIdx] === curKey && ttDepth[ttIdx] > 0);
    var ttMv = ttHit ? ttMove[ttIdx] : 0;

    if (ttHit && !isPv && ttDepth[ttIdx] >= depth) {
      var ts = ttScore[ttIdx];
      if (ts > MATE_BOUND) ts -= ply;
      else if (ts < -MATE_BOUND) ts += ply;
      var tf = ttFlag[ttIdx];
      if (tf === TT_EXACT) return ts;
      if (tf === TT_LOWER && ts >= beta) return ts;
      if (tf === TT_UPPER && ts <= alpha) return ts;
    }

    /* null-move：不将军时先白让一手，对手仍占不到便宜就说明这里很安全 */
    if (canNull && !isPv && !inChk && depth >= 3 && hasNonPawnMaterial(bd, side)) {
      var red = depth > 6 ? 3 : 2;
      curKey ^= zobSide;
      var nullScore = -negamax(bd, -side, depth - 1 - red, -beta, -beta + 1, ply + 1, false);
      curKey ^= zobSide;
      if (aborted) return 0;
      if (nullScore >= beta) return beta;
    }

    var moves = movePool[ply];
    XQ.genMoves(bd, side, moves);
    if (moves.length === 0) return -MATE + ply;

    orderMoves(bd, moves, ply, ttMv);

    var best = -INF;
    var bestMove = 0;
    var flag = TT_UPPER;
    var moveCount = 0;

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var isCapture = bd[m % 90] !== 0;
      var captured = doMove(bd, m);

      if (captured === -side * K) {
        undoMove(bd, m, captured);
        return MATE - ply;
      }

      var score;
      if (moveCount === 0) {
        score = -negamax(bd, -side, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        /* LMR：靠后的安静着法先降深度试探 */
        var reduce = 0;
        if (depth >= 3 && moveCount >= 4 && !isCapture && !inChk) {
          reduce = 1 + ((moveCount >= 10 && depth >= 6) ? 1 : 0);
          if (reduce > depth - 2) reduce = depth - 2;
        }

        score = -negamax(bd, -side, depth - 1 - reduce, -alpha - 1, -alpha, ply + 1, true);
        /* 降深度还超出预期，补一次全深度零窗口 */
        if (score > alpha && reduce > 0) {
          score = -negamax(bd, -side, depth - 1, -alpha - 1, -alpha, ply + 1, true);
        }
        /* 零窗口确认比 alpha 好，再全窗口求出确切分值 */
        if (score > alpha && score < beta) {
          score = -negamax(bd, -side, depth - 1, -beta, -alpha, ply + 1, true);
        }
      }

      undoMove(bd, m, captured);
      if (aborted) return 0;
      moveCount++;

      if (score > best) { best = score; bestMove = m; }
      if (score > alpha) { alpha = score; flag = TT_EXACT; }
      if (alpha >= beta) {
        flag = TT_LOWER;
        if (!isCapture) {
          var kk = killers[ply];
          if (kk[0] !== m) { kk[1] = kk[0]; kk[0] = m; }
          historyTable[((m / 90) | 0) * 90 + (m % 90)] += depth * depth;
        }
        break;
      }
    }

    /* 写置换表，杀棋分数按层数换算以免跨层失真 */
    var store = best;
    if (store > MATE_BOUND) store += ply;
    else if (store < -MATE_BOUND) store -= ply;
    ttKey[ttIdx] = curKey;
    ttMove[ttIdx] = bestMove;
    ttScore[ttIdx] = store;
    ttDepth[ttIdx] = depth > 127 ? 127 : depth;
    ttFlag[ttIdx] = flag;

    return best;
  }

  /* ================= 开局库 =================
   * 每条线是一串着法编码（红黑交替），开局阶段照着走。
   * 好处有两个：开局不至于走出莫名其妙的自损着法，而且同一局面有多个分支时
   * 会随机挑一个，不会每盘棋都一模一样。
   * 库里的着法仍会用本地规则校验一遍，不合法就当没有。
   */
  var OPENING_BOOK = [
    /* 中炮对屏风马，红出右直车 */
    [6367, 654, 7989, 727, 8098],
    /* 中炮对屏风马，红出左直车 */
    [6367, 654, 7445, 727, 7370],
    /* 中炮对反宫马 */
    [6367, 110, 7989, 654],
    /* 中炮对列炮 */
    [6367, 2272, 7989, 654],
    /* 中炮对顺炮（黑另一侧） */
    [6367, 1732, 7989, 654],
    /* 中炮进三兵 */
    [6367, 654, 5451, 3012],
    /* 中炮对屏风马，黑先挺 3 卒 */
    [6367, 2648, 7989, 654],
    /* 仙人指路 */
    [5087, 3012, 7445, 654],
    /* 飞相局 */
    [7897, 2272, 7989, 654],
    /* 五六炮 */
    [5827, 654, 7989, 727]
  ];

  var BOOK_MAX_PLY = 12;

  /**
   * 查开局库
   * @param {number[]} played 已经走过的着法序列
   * @param {number[]} legal  当前合法着法
   * @returns {number} 着法编码，没命中返回 0
   */
  function bookMove(played, legal) {
    var n = played.length;
    if (n > BOOK_MAX_PLY) return 0;

    var votes = {};
    var i, k;
    for (i = 0; i < OPENING_BOOK.length; i++) {
      var line = OPENING_BOOK[i];
      if (line.length <= n) continue;
      var match = true;
      for (k = 0; k < n; k++) {
        if (line[k] !== played[k]) { match = false; break; }
      }
      if (!match) continue;
      votes[line[n]] = (votes[line[n]] || 0) + 1;
    }

    var pool = [];
    for (var key in votes) {
      if (!Object.prototype.hasOwnProperty.call(votes, key)) continue;
      var mv = +key;
      if (legal.indexOf(mv) < 0) continue;      /* 库里的着法也要过一遍规则 */
      for (k = 0; k < votes[key]; k++) pool.push(mv);
    }
    if (!pool.length) return 0;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * 搜索最佳着法
   * @param {Int8Array} bd        当前局面
   * @param {number}   side       走子方（1 红 / -1 黑）
   * @param {number}   maxDepth   迭代加深上限
   * @param {number}   timeMs     时间上限（毫秒）
   * @param {number}  [randomMargin] 大于 0 时在"接近最优"的着法里随机挑，
   *                                 用来压低棋力并让每盘不重样
   * @returns {number|null} 着法编码，无棋可走返回 null
   */
  function search(bd, side, maxDepth, timeMs, randomMargin) {
    var t0 = Date.now();
    nodes = 0;
    aborted = false;
    deadline = t0 + timeMs;
    randomMargin = randomMargin || 0;
    /* 要按分差挑棋就得有精确分数，根结点必须全窗口 */
    var fullWindow = randomMargin > 0;

    for (var i = 0; i < killers.length; i++) { killers[i][0] = 0; killers[i][1] = 0; }
    historyTable.fill(0);

    var rootMoves = XQ.genLegalMoves(bd, side);
    if (rootMoves.length === 0) { lastInfo = null; return null; }
    if (rootMoves.length === 1) {
      lastInfo = { depth: 0, nodes: 0, score: 0, time: Date.now() - t0 };
      return rootMoves[0];
    }

    curKey = computeKey(bd, side);

    var bestMove = rootMoves[0];
    var bestScore = 0;
    var reachedDepth = 0;
    var lastScored = null;

    for (var depth = 1; depth <= maxDepth; depth++) {
      var iterStart = Date.now();
      var idx = rootMoves.indexOf(bestMove);
      if (idx > 0) { rootMoves.splice(idx, 1); rootMoves.unshift(bestMove); }

      var alpha = -INF;
      var localBest = 0;
      var localScore = -INF;
      var scored = fullWindow ? [] : null;

      for (var j = 0; j < rootMoves.length; j++) {
        var m = rootMoves[j];
        var captured = doMove(bd, m);
        var score;

        /*
         * 根结点也要认"吃到将/帅"。
         * 少了这一步，当对方走出送将的着法时，吃将在根结点只是个普通着法，
         * 搜索根本不知道已经赢了——放开将军限制之后这条路径很常见。
         */
        if (captured === -side * K) {
          undoMove(bd, m, captured);
          localBest = m;
          localScore = MATE;
          alpha = MATE;
          break;
        }

        if (fullWindow || j === 0) {
          score = -negamax(bd, -side, depth - 1, -INF, fullWindow ? INF : -alpha, 1, true);
        } else {
          score = -negamax(bd, -side, depth - 1, -alpha - 1, -alpha, 1, true);
          if (score > alpha) {
            score = -negamax(bd, -side, depth - 1, -INF, -alpha, 1, true);
          }
        }

        undoMove(bd, m, captured);
        if (aborted) break;
        if (scored) scored.push([m, score]);
        if (score > localScore) { localScore = score; localBest = m; }
        if (score > alpha) alpha = score;
      }

      if (!aborted) {
        bestMove = localBest;
        bestScore = localScore;
        reachedDepth = depth;
        lastScored = scored;
        if (bestScore > MATE_BOUND || bestScore < -MATE_BOUND) break;
      } else if (depth === 1 && localBest) {
        bestMove = localBest;
        reachedDepth = 1;
      }
      if (aborted) break;

      /*
       * 下一层耗时大约是本层的 4 倍。明显搜不完就收手，
       * 免得把时间预算烧在一个注定被丢弃的迭代上。
       */
      var iterTime = Date.now() - iterStart;
      if (iterTime * 4 > deadline - Date.now()) break;
    }

    if (randomMargin > 0 && lastScored && lastScored.length > 1 &&
        Math.abs(bestScore) < MATE_BOUND) {
      var maxS = -INF;
      for (var k = 0; k < lastScored.length; k++) {
        if (lastScored[k][1] > maxS) maxS = lastScored[k][1];
      }
      var pool = [];
      for (k = 0; k < lastScored.length; k++) {
        if (lastScored[k][1] >= maxS - randomMargin) pool.push(lastScored[k][0]);
      }
      if (pool.length > 0) bestMove = pool[Math.floor(Math.random() * pool.length)];
    }

    lastInfo = {
      depth: reachedDepth,
      nodes: nodes,
      score: bestScore,
      time: Date.now() - t0
    };
    return bestMove;
  }

  global.XiangqiAI = {
    search: search,
    bookMove: bookMove,
    evaluate: evaluate,
    VALUES: VALUES,
    MATE: MATE,
    lastInfo: function () { return lastInfo; },
    stats: function () { return { nodes: nodes, aborted: aborted }; }
  };
}

/* 主线程直接装载；Worker 里由 bootstrap 调 XiangqiAIEngine(self) */
if (typeof window !== 'undefined') XiangqiAIEngine(window);
