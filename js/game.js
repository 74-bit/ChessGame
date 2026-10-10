/* 界面与对局控制 */
(function () {
  'use strict';

  var XQ = window.Xiangqi;
  var AI = window.XiangqiAI;
  var NOT = window.XiangqiNotation;
  var NET = window.XiangqiOnline;

  var RED = 1, BLACK = -1;

  /* 棋盘坐标系（SVG viewBox 单位）：每格 100，四周留白 75 */
  var VB_W = 950, VB_H = 1050, PAD = 75, STEP = 100;
  var ANIM_MS = 260;   /* 与 CSS 里 .piece 的 transition 时长保持一致 */

  /*
   * maxDepth 只是上限，实际层数由时间预算和"下一层搜不搜得完"共同决定，
   * 所以残局子力少时会自动算得更深。
   */
  var DIFFICULTY = {
    easy: { depth: 2, time: 600, margin: 120 },
    normal: { depth: 5, time: 900, margin: 0 },
    hard: { depth: 24, time: 9000, margin: 0 }
  };

  /* ---- DOM ---- */
  var boardWrap = document.getElementById('boardWrap');
  var boardEl = document.getElementById('board');
  var svgEl = document.getElementById('boardSvg');
  var pieceLayer = document.getElementById('pieceLayer');
  var hintLayer = document.getElementById('hintLayer');
  var statusEl = document.getElementById('status');
  var turnDotEl = document.getElementById('turnDot');
  var engineInfoEl = document.getElementById('engineInfo');
  var moveListEl = document.getElementById('moveList');
  var pveGroup = document.getElementById('pveGroup');
  var sideGroup = document.getElementById('sideGroup');
  var onlineGroup = document.getElementById('onlineGroup');
  var netGroup = document.getElementById('netGroup');
  var undoBtn = document.getElementById('undoBtn');
  var evalFillEl = document.getElementById('evalFill');
  var evalRedTxtEl = document.getElementById('evalRedTxt');
  var evalBlackTxtEl = document.getElementById('evalBlackTxt');
  var evalScoreEl = document.getElementById('evalScore');
  var evalCanvasEl = document.getElementById('evalCanvas');
  var scoreGroup = document.getElementById('scoreGroup');
  var scoreBodyEl = document.getElementById('scoreBody');
  var chatGroup = document.getElementById('chatGroup');
  var chatTitleEl = document.getElementById('chatTitle');
  var chatListEl = document.getElementById('chatList');
  var chatInputEl = document.getElementById('chatInput');

  /* ---- 对局状态 ---- */
  var board, turn, history, mode, aiSide, difficulty;
  var selected, gameOver, lastMove, thinking, resultText, winner;
  /*
   * playableMoves：当前走子方所有"走得动"的着法（伪合法），玩家点得动的就是这些。
   * legalMoves  ：完全合法的着法，只用来判定将死/困毙。
   * 本作刻意放开了将军限制——被将军时也能随便走，走错了对方直接吃掉你的将，
   * 所以两者必须分开。
   */
  var playableMoves, legalMoves;
  var pieceEls = new Array(90).fill(null);
  var geo = { cell: 40, pad: 30, size: 38 };
  var netSide = 0;         /* 联机时我方执子 */
  var netRole = '';        /* 'host' | 'guest'，决定谁执红 */
  var netRoom = '';        /* 已创建、正在等人加入的房号 */
  var lastAiInfo = null;
  var flipped = false;     /* 是否翻转棋盘（执黑时看得舒服些） */
  var hintMove = null;     /* 提示着法，短暂高亮 */
  var hintBusy = false;

  /*
   * evals[k] = 走完第 k 步之后、以红方视角的局面评分。
   * evals[0] 是开局。相邻两项之差就是这一步的损失，用于算胜率和终局评分。
   */
  var evals = [];
  var evalGen = 0;         /* 悔棋/重开后自增，用来丢弃迟到的旧评估 */
  var evalInFlight = 0;    /* 在算的评估个数，用来防止队列积压 */
  var EVAL_DEPTH = 6;      /* 评估用的固定深度：够看清战术，又不会拖慢电脑思考 */
  var EVAL_TIME = 1200;    /* 只是兜底上限，正常情况下 6 层约 250ms 就搜完了 */

  /* ---- 音效：用 WebAudio 现场合成，不依赖任何音频文件 ---- */
  var audioCtx = null;
  var soundOn = true;

  function audio() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    if (audioCtx.state === 'suspended') {
      try { audioCtx.resume(); } catch (e) { /* 忽略 */ }
    }
    return audioCtx;
  }

  /* 带包络的音；freq 滑向 slideTo 会有一点"木头撞击"的味道 */
  function tone(freq, dur, type, vol, delay, slideTo) {
    var ctx = audio();
    if (!ctx) return;
    var t0 = ctx.currentTime + (delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.18, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  function playSound(kind) {
    if (!soundOn) return;
    switch (kind) {
      case 'select':
        tone(760, 0.05, 'sine', 0.06);
        break;
      case 'move':
        tone(340, 0.09, 'triangle', 0.2, 0, 170);
        break;
      case 'capture':
        tone(200, 0.16, 'square', 0.12, 0, 90);
        tone(540, 0.07, 'triangle', 0.1);
        break;
      case 'check':
        tone(680, 0.1, 'square', 0.11);
        tone(920, 0.13, 'square', 0.11, 0.11);
        break;
      case 'win':
        [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.22, 'triangle', 0.15, i * 0.11); });
        break;
      case 'lose':
        [440, 370, 294, 220].forEach(function (f, i) { tone(f, 0.26, 'triangle', 0.14, i * 0.13); });
        break;
    }
  }

  /* ---- 设置持久化：记住棋力、执子、音效、翻转 ---- */
  var STORE_KEY = 'xiangqi.settings.v1';

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      /* 老版本存过 'brutal' 这个档位，现在并进 'hard' 了 */
      if (s.difficulty === 'brutal') s.difficulty = 'hard';
      if (s.difficulty && DIFFICULTY[s.difficulty]) difficulty = s.difficulty;
      if (s.aiSide === 1 || s.aiSide === -1) aiSide = s.aiSide;
      if (typeof s.soundOn === 'boolean') soundOn = s.soundOn;
      if (typeof s.flipped === 'boolean') flipped = s.flipped;
    } catch (e) { /* 隐私模式或 file:// 下可能不可用，忽略即可 */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        difficulty: difficulty, aiSide: aiSide, soundOn: soundOn, flipped: flipped
      }));
    } catch (e) { /* 忽略 */ }
  }

  /* ---- 坐标换算 ---- */
  /* 翻转棋盘时，只在这里做一次行列对调，其余代码仍按逻辑坐标思考 */
  function dispRC(sq) {
    var r = (sq / 9) | 0, c = sq % 9;
    return flipped ? [9 - r, 8 - c] : [r, c];
  }

  function pctX(c) { return ((PAD + STEP * c) / VB_W * 100) + '%'; }
  function pctY(r) { return ((PAD + STEP * r) / VB_H * 100) + '%'; }

  function translateFor(sq) {
    var d = dispRC(sq);
    var x = geo.pad + geo.cell * d[1] - geo.size / 2;
    var y = geo.pad + geo.cell * d[0] - geo.size / 2;
    return 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
  }

  /* ---- 绘制棋盘 ---- */
  function buildBoard() {
    var X = function (c) { return PAD + STEP * c; };
    var Y = function (r) { return PAD + STEP * r; };
    var p = [];

    for (var r = 0; r < 10; r++) {
      p.push('<line x1="' + X(0) + '" y1="' + Y(r) + '" x2="' + X(8) + '" y2="' + Y(r) + '"/>');
    }
    /* 中间 7 条竖线在河界处断开 */
    for (var c = 0; c < 9; c++) {
      if (c === 0 || c === 8) {
        p.push('<line x1="' + X(c) + '" y1="' + Y(0) + '" x2="' + X(c) + '" y2="' + Y(9) + '"/>');
      } else {
        p.push('<line x1="' + X(c) + '" y1="' + Y(0) + '" x2="' + X(c) + '" y2="' + Y(4) + '"/>');
        p.push('<line x1="' + X(c) + '" y1="' + Y(5) + '" x2="' + X(c) + '" y2="' + Y(9) + '"/>');
      }
    }
    /* 九宫斜线 */
    p.push('<line x1="' + X(3) + '" y1="' + Y(0) + '" x2="' + X(5) + '" y2="' + Y(2) + '"/>');
    p.push('<line x1="' + X(5) + '" y1="' + Y(0) + '" x2="' + X(3) + '" y2="' + Y(2) + '"/>');
    p.push('<line x1="' + X(3) + '" y1="' + Y(7) + '" x2="' + X(5) + '" y2="' + Y(9) + '"/>');
    p.push('<line x1="' + X(5) + '" y1="' + Y(7) + '" x2="' + X(3) + '" y2="' + Y(9) + '"/>');

    /* 兵位、炮位小十字标记 */
    var marks = [
      [2, 1], [2, 7],
      [3, 0], [3, 2], [3, 4], [3, 6], [3, 8],
      [6, 0], [6, 2], [6, 4], [6, 6], [6, 8],
      [7, 1], [7, 7]
    ];
    var G = 8, L = 20;
    for (var i = 0; i < marks.length; i++) {
      var mr = marks[i][0], mc = marks[i][1];
      var x = X(mc), y = Y(mr);
      var quads = [];
      if (mc > 0) quads.push([-1, -1], [-1, 1]);
      if (mc < 8) quads.push([1, -1], [1, 1]);
      for (var k = 0; k < quads.length; k++) {
        var sx = quads[k][0], sy = quads[k][1];
        var px = x + sx * G, py = y + sy * G;
        p.push('<path d="M ' + (px + sx * L) + ' ' + py + ' L ' + px + ' ' + py + ' L ' + px + ' ' + (py + sy * L) + '"/>');
      }
    }

    p.push('<rect class="board-frame" x="' + (X(0) - 16) + '" y="' + (Y(0) - 16) +
      '" width="' + (X(8) - X(0) + 32) + '" height="' + (Y(9) - Y(0) + 32) + '"/>');

    /* 翻转棋盘时河界文字要转 180°，否则对坐的人看着是倒的 */
    var riverY = (Y(4) + Y(5)) / 2;
    var rot = flipped ? ' transform="rotate(180 ' + X(2) + ' ' + riverY + ')"' : '';
    var rot2 = flipped ? ' transform="rotate(180 ' + X(6) + ' ' + riverY + ')"' : '';
    p.push('<text class="river-text" x="' + X(2) + '" y="' + riverY + '" text-anchor="middle" dominant-baseline="central"' + rot + '>楚 河</text>');
    p.push('<text class="river-text" x="' + X(6) + '" y="' + riverY + '" text-anchor="middle" dominant-baseline="central"' + rot2 + '>漢 界</text>');

    svgEl.innerHTML = '<g class="grid">' + p.join('') + '</g>';
  }

  /* ---- 棋子元素 ---- */
  function createPieceEl(piece) {
    var el = document.createElement('div');
    el.className = 'piece ' + (piece > 0 ? 'red' : 'black');
    el.dataset.code = String(piece);
    var coin = document.createElement('div');
    coin.className = 'coin';
    var span = document.createElement('span');
    span.textContent = XQ.pieceChar(piece);
    coin.appendChild(span);
    el.appendChild(coin);
    return el;
  }

  function placeEl(el, sq, animate) {
    el.dataset.sq = String(sq);
    if (animate) {
      el.classList.add('moving');
      clearTimeout(el._animTimer);
      el._animTimer = setTimeout(function () { el.classList.remove('moving'); }, ANIM_MS + 60);
    }
    el.style.transform = translateFor(sq);
  }

  function clearPieces() {
    for (var i = 0; i < 90; i++) {
      if (pieceEls[i]) { clearTimeout(pieceEls[i]._animTimer); pieceEls[i].remove(); pieceEls[i] = null; }
    }
    pieceLayer.innerHTML = '';
  }

  /*
   * 让 DOM 与 board 数组同步。
   * 复用同编码的旧元素 -> 移动交由 CSS transition 产生滑行动画，
   * 被吃掉的棋子缩小淡出后移除。
   */
  function syncPieces() {
    var keep = new Array(90).fill(null);
    var orphans = [];
    var sq, el, i;

    for (sq = 0; sq < 90; sq++) {
      el = pieceEls[sq];
      if (!el) continue;
      var p = board[sq];
      if (p !== 0 && String(p) === el.dataset.code) keep[sq] = el;
      else orphans.push(el);
    }

    for (sq = 0; sq < 90; sq++) {
      var piece = board[sq];
      if (piece === 0 || keep[sq]) continue;
      var code = String(piece);
      var found = -1;
      for (i = 0; i < orphans.length; i++) {
        if (orphans[i].dataset.code === code) { found = i; break; }
      }
      if (found >= 0) {
        keep[sq] = orphans[found];
        orphans.splice(found, 1);
        placeEl(keep[sq], sq, true);   /* 复用 = 这一步是"走"过来的，带动画 */
      } else {
        keep[sq] = createPieceEl(piece);
        placeEl(keep[sq], sq, false);
        pieceLayer.appendChild(keep[sq]);
      }
    }

    for (i = 0; i < orphans.length; i++) {
      (function (dead) {
        dead.classList.add('captured');
        setTimeout(function () { dead.remove(); }, 240);
      })(orphans[i]);
    }

    for (sq = 0; sq < 90; sq++) {
      el = keep[sq];
      if (el && el.dataset.sq !== String(sq)) placeEl(el, sq, true);
    }

    pieceEls = keep;
  }

  /* ---- 提示层 ---- */
  function renderHints() {
    /* 首次 layout() 发生在 newGame() 之前，那时还没有局面可画 */
    if (!board) return;
    hintLayer.innerHTML = '';
    var frag = document.createDocumentFragment();

    function marker(sq, cls) {
      var d = dispRC(sq);
      var el = document.createElement('div');
      el.className = 'mark ' + cls;
      el.style.left = pctX(d[1]);
      el.style.top = pctY(d[0]);
      frag.appendChild(el);
    }

    if (lastMove !== null) {
      marker(XQ.moveFrom(lastMove), 'last-from');
      marker(XQ.moveTo(lastMove), 'last-to');
    }
    if (hintMove !== null) {
      marker(XQ.moveFrom(hintMove), 'hint-from');
      marker(XQ.moveTo(hintMove), 'hint-to');
    }
    if (selected >= 0) marker(selected, 'selected');

    /* 联机时轮不到自己就别显示可走点 */
    var myTurn = (mode !== 'online') || (turn === netSide);
    if (selected >= 0 && myTurn) {
      for (var i = 0; i < playableMoves.length; i++) {
        var m = playableMoves[i];
        if (XQ.moveFrom(m) !== selected) continue;
        var to = XQ.moveTo(m);
        marker(to, board[to] !== 0 ? 'capture' : 'dest');
      }
    }

    hintLayer.appendChild(frag);
    boardEl.classList.toggle('is-check', !gameOver && XQ.inCheck(board, turn));
  }

  /* ---- 着法列表 ---- */
  function moveCell(ply) {
    var h = history[ply];
    if (!h) return '<span class="m"></span>';
    var side = h.side === RED ? 'red' : 'black';
    var badge = '';
    var losses = moveLosses();
    var b = moveBadge(losses[ply + 1]);
    if (b) {
      badge = '<i class="badge ' + b.cls + '" title="' + b.title + '">' + b.mark + '</i>';
    }
    var label = h.side === RED ? '红' : '黑';
    return '<span class="m ' + side + '" title="' + label + '方">' + h.san + badge + '</span>';
  }

  function renderMoveList() {
    var html = '';
    for (var i = 0; i < history.length; i += 2) {
      html += '<div class="mv"><span class="no">' + (i / 2 + 1) + '.</span>' +
        moveCell(i) + moveCell(i + 1) + '</div>';
    }
    moveListEl.innerHTML = html || '<div class="mv empty">尚未走子</div>';
    moveListEl.scrollTop = moveListEl.scrollHeight;
  }

  /* 棋谱文本，用于复制/分享 */
  function gameRecord() {
    var out = [];
    for (var i = 0; i < history.length; i += 2) {
      var line = (i / 2 + 1) + '. ' + history[i].san;
      if (history[i + 1]) line += '  ' + history[i + 1].san;
      out.push(line);
    }
    var result = gameOver ? resultText : '（未结束）';
    return '中国象棋对局记录\n' + out.join('\n') + '\n结果：' + result;
  }

  /* ---- 胜率换算 ---- */
  var MATE_SCORE = 30000;

  /*
   * 评分差 -> 胜率。logistic 换算，250 分（两个半兵）就到约 90%。
   * 这个系数是特意调陡的：用 400 的时候一个兵的优势才 64%，
   * 整盘棋胜率条几乎不动，看不出局势起伏。
   * 未分胜负时夹在 2%~98%，避免出现"100% 必胜"这种过度自信的显示。
   */
  var WINRATE_K = 250;

  function winRate(score) {
    if (score > MATE_SCORE - 1000) return 1;
    if (score < -MATE_SCORE + 1000) return 0;
    var p = 1 / (1 + Math.pow(10, -score / WINRATE_K));
    return Math.min(0.98, Math.max(0.02, p));
  }

  /* 把评分差写成"几个兵"，和国际象棋引擎的习惯一致 */
  function formatScore(score) {
    if (score > MATE_SCORE - 1000) return '绝杀';
    if (score < -MATE_SCORE + 1000) return '被绝杀';
    var v = score / 100;
    return (v > 0 ? '+' : '') + v.toFixed(1);
  }

  /* 取最近一个已算出的评估。正常情况下就是当前步，积压时退而用上一个已知值 */
  function latestEval() {
    for (var k = Math.min(history.length, evals.length - 1); k >= 0; k--) {
      if (typeof evals[k] === 'number') return evals[k];
    }
    return null;
  }

  function renderEvalBar() {
    var cur = latestEval();
    if (cur === null) return;   /* 一个都还没算出来就先保持原样 */
    var pr = winRate(cur);
    var redPct = Math.round(pr * 100);
    evalFillEl.style.width = (pr * 100).toFixed(1) + '%';
    evalRedTxtEl.textContent = redPct + '%';
    evalBlackTxtEl.textContent = (100 - redPct) + '%';
    evalScoreEl.textContent = formatScore(cur);
    evalScoreEl.className = 'eval-score ' + (cur > 30 ? 'red' : (cur < -30 ? 'black' : ''));
  }

  /*
   * 每一步的损失（该方视角，只取非负）。返回数组，索引 = 步序号，
   * 因为评估是异步来的，算不出的位置是 null。
   */
  function moveLosses() {
    var arr = new Array(history.length + 1);
    for (var k = 0; k <= history.length; k++) arr[k] = null;
    for (k = 1; k <= history.length; k++) {
      var before = evals[k - 1], after = evals[k];
      if (typeof before !== 'number' || typeof after !== 'number') continue;
      arr[k] = Math.max(0, (before - after) * history[k - 1].side);
    }
    return arr;
  }

  /*
   * 着法质量分级，阈值按"厘兵"（一个兵 = 100）来定。
   * 只标问题手，不标好棋：没有"引擎首选着法"作对照时，
   * 优势局面下几乎每步都"没损失"，标出来全是噪声。
   */
  function moveBadge(loss) {
    if (loss === null) return null;
    if (loss >= 300) return { mark: '??', cls: 'blunder', title: '漏着' };
    if (loss >= 120) return { mark: '?', cls: 'mistake', title: '失误' };
    if (loss >= 40) return { mark: '?!', cls: 'inaccuracy', title: '疑问手' };
    return null;
  }

  /* ---- 评估曲线：把整盘的胜率变化画出来 ---- */
  function renderEvalGraph() {
    var cv = evalCanvasEl;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;

    var dpr = window.devicePixelRatio || 1;
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }

    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var n = evals.length - 1;
    var maxPly = Math.max(16, n);          /* 太短时先按满格画，免得几步就撑满 */
    var xOf = function (k) { return (k / maxPly) * w; };
    var yOf = function (k) { return h - winRate(evals[k]) * h; };

    /* 已知的点：允许中间有空洞（评估被丢弃时），画成折线即可 */
    var pts = [];
    for (var k = 0; k <= n; k++) {
      if (typeof evals[k] === 'number') pts.push([xOf(k), yOf(k)]);
    }
    if (pts.length < 2) {
      ctx.fillStyle = 'rgba(155,145,130,.5)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('走几步后这里会显示胜率走势', w / 2, h / 2 + 3);
      return;
    }

    /* 曲线下方填红（红方地盘），上方填蓝（黑方地盘） */
    function fillArea(color, fromBottom) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], fromBottom ? h : 0);
      for (var i = 0; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.lineTo(pts[pts.length - 1][0], fromBottom ? h : 0);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
    fillArea('rgba(192,57,43,.42)', true);
    fillArea('rgba(120,133,158,.34)', false);

    /* 中线 */
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    /* 曲线 */
    var i;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();

    /* 失误点：一眼看出哪几步崩了 */
    var losses = moveLosses();
    for (k = 1; k <= n; k++) {
      if (losses[k] === null || losses[k] < 250) continue;
      var x = xOf(k), y = yOf(k);
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = '#f0c419';
      ctx.fill();
    }
  }

  /* ---- 终局评分 ----
   * 满分 100，由两部分构成：
   *   结果分 0~50：胜 50，负 0
   *   质量分 0~50：由平均每步损失(ACPL)换算，50 * exp(-ACPL/110)
   * 每步损失 = 走子前局面对该方而言的价值 - 走子后的价值，只取非负部分。
   * 下出最优着法时损失约为 0，失误越大越高。
   */
  function scoreFor(side) {
    var sum = 0, n = 0, captures = 0, moves = 0;
    var blunder = 0, blunderPly = 0;

    for (var k = 1; k <= history.length; k++) {
      var h = history[k - 1];
      if (h.side !== side) continue;
      moves++;
      if (h.captured) captures++;
      var before = evals[k - 1], after = evals[k];
      if (typeof before !== 'number' || typeof after !== 'number') continue;
      var loss = Math.max(0, (before - after) * side);
      sum += loss;
      n++;
      if (loss > blunder) { blunder = loss; blunderPly = k; }
    }

    var acpl = n ? sum / n : 0;
    var quality = Math.round(50 * Math.exp(-acpl / 110));
    quality = Math.max(0, Math.min(50, quality));
    var result = (winner === side) ? 50 : 0;

    return {
      result: result,
      quality: quality,
      total: result + quality,
      grade: gradeOf(result + quality),
      acpl: acpl,
      blunder: blunder,
      blunderPly: blunderPly,
      captures: captures,
      moves: moves
    };
  }

  function gradeOf(total) {
    if (total >= 85) return 'S · 神级';
    if (total >= 70) return 'A · 优秀';
    if (total >= 55) return 'B · 良好';
    if (total >= 40) return 'C · 一般';
    return 'D · 待提高';
  }

  function renderScore() {
    if (!gameOver) { scoreGroup.hidden = true; scoreBodyEl.innerHTML = ''; return; }
    scoreGroup.hidden = false;

    /* 人机对战只给玩家打分；双人/联机两边都给 */
    var sides = (mode === 'pve') ? [-aiSide] : [RED, BLACK];
    var html = '<div class="score-result">' + resultText + '</div>';

    for (var i = 0; i < sides.length; i++) {
      var s = sides[i];
      var r = scoreFor(s);
      var label = (mode === 'pve') ? '你' : (s === RED ? '红方' : '黑方');
      html +=
        '<div class="score-card ' + (s === RED ? 'red' : 'black') + '">' +
          '<div class="score-head">' +
            '<span class="score-side">' + label + '</span>' +
            '<span class="score-total">' + r.total + '<small>分</small></span>' +
          '</div>' +
          '<div class="score-grade">' + r.grade + '</div>' +
          '<div class="score-rows">' +
            '<div><span>结果分</span><b>' + r.result + ' / 50</b></div>' +
            '<div><span>质量分</span><b>' + r.quality + ' / 50</b></div>' +
            '<div><span>平均每步损失</span><b>' + Math.round(r.acpl) + '</b></div>' +
            '<div><span>最大失误</span><b>' + Math.round(r.blunder) +
              (r.blunderPly ? '（第 ' + Math.ceil(r.blunderPly / 2) + ' 回合）' : '') + '</b></div>' +
            '<div><span>吃掉对方</span><b>' + r.captures + ' 子</b></div>' +
          '</div>' +
        '</div>';
    }
    scoreBodyEl.innerHTML = html;
  }

  /* ================= 聊天 =================
   * 只有联机模式才有对话面板，人机和双人都不显示。
   */
  var chatLog = [];
  var CHAT_MAX = 120;
  var lastChatSentAt = 0;

  function chatVisible() {
    return mode === 'online';
  }

  function chatWho(m) {
    return (m.who === 'me' || m.who === 'them') ? m.who : 'sys';
  }

  function renderChat() {
    var html = '';
    for (var i = 0; i < chatLog.length; i++) {
      var m = chatLog[i];
      if (m.who === 'sys') {
        html += '<div class="chat-sys"></div>';
      } else {
        html += '<div class="chat-msg ' + chatWho(m) + '"><div class="chat-bubble"></div></div>';
      }
    }
    chatListEl.innerHTML = html;

    /* 文本用 textContent 写，避免任何注入 */
    var nodes = chatListEl.children;
    for (i = 0; i < chatLog.length; i++) {
      var target = chatLog[i].who === 'sys' ? nodes[i] : nodes[i].firstChild;
      target.textContent = chatLog[i].text;
    }
    chatListEl.scrollTop = chatListEl.scrollHeight;
  }

  function addChat(who, text) {
    if (!text) return;
    text = String(text).slice(0, 200);
    chatLog.push({ who: who, text: text });
    if (chatLog.length > CHAT_MAX) chatLog.splice(0, chatLog.length - CHAT_MAX);
    renderChat();
  }

  function sendChat() {
    if (mode !== 'online') return;

    var text = chatInputEl.value.trim();
    if (!text) return;

    var now = Date.now();
    if (now - lastChatSentAt < 400) return;   /* 手滑连点就别重复发了 */
    lastChatSentAt = now;
    chatInputEl.value = '';

    if (!NET.isOpen()) {
      addChat('sys', '尚未连接，消息没有发出去');
      return;
    }
    if (NET.send({ t: 'chat', text: text })) addChat('me', text);
    else addChat('sys', '发送失败');
  }

  function updateChatVisibility() {
    var show = chatVisible();
    chatGroup.hidden = !show;
    if (!show) return;
    chatTitleEl.textContent = '对话 · 对手';
  }

  function resetChat() {
    chatLog = [];
    renderChat();
  }

  /* ---- 状态栏 ---- */
  function updateStatus() {
    var cls = '';
    var text;

    if (gameOver) {
      text = resultText;
      cls = 'over';
    } else if (thinking) {
      text = '电脑思考中…';
      cls = 'think';
    } else if (hintBusy) {
      text = '正在为你计算…';
      cls = 'think';
    } else if (mode === 'online') {
      if (!netSide) {
        text = netRoom
          ? '等待对方加入 · 房号 ' + netRoom
          : '未连接 · 请在右侧创建或加入房间';
      } else {
        text = (turn === netSide) ? '轮到你走棋' : '等待对方走棋';
        if (XQ.inCheck(board, turn)) {
          text = '被将军！' + (turn === netSide ? '轮到你走棋' : '');
          cls = 'check';
        }
      }
    } else if (XQ.inCheck(board, turn)) {
      /* 将军不限制走子，所以要点明"可以不应"以及后果 */
      text = (turn === RED ? '红方' : '黑方') + '被将军！可不应，但对方会吃将';
      cls = 'check';
    } else {
      text = '轮到' + (turn === RED ? '红方' : '黑方') + '走棋';
    }

    if (mode === 'pve' && !gameOver && !thinking && !hintBusy) {
      text += turn === aiSide ? '（电脑）' : '（你）';
    }

    statusEl.textContent = text;
    statusEl.className = 'status-text ' + cls;
    turnDotEl.className = 'turn-dot ' + (gameOver ? 'over' : (turn === RED ? 'red' : 'black'));

    /* 引擎信息：让电脑到底挖了多深看得见 */
    if (mode === 'pve' && lastAiInfo && !thinking) {
      engineInfoEl.hidden = false;
      engineInfoEl.textContent = lastAiInfo.book
        ? '电脑：开局库'
        : '电脑：深度 ' + lastAiInfo.depth +
          ' · ' + (lastAiInfo.nodes / 1000).toFixed(0) + 'k 结点' +
          ' · ' + (lastAiInfo.time / 1000).toFixed(1) + 's';
    } else {
      engineInfoEl.hidden = true;
    }

    undoBtn.disabled = thinking || history.length === 0 || mode === 'online';
  }

  /* ---- 走子 ---- */
  function applyMove(m, fromRemote) {
    var from = XQ.moveFrom(m), to = XQ.moveTo(m);
    var ply = history.length;
    var mover = turn;                     /* 走这一步的是谁，下面 turn 要翻转 */
    var san = NOT.toChinese(board, m, turn);
    var captured = board[to];

    if (mode === 'online' && !fromRemote) {
      NET.send({ t: 'move', ply: ply, m: m });
    }

    history.push({ move: m, captured: captured, san: san, side: turn });
    board[to] = board[from];
    board[from] = 0;

    lastMove = m;
    selected = -1;
    turn = -turn;
    refreshMoves();

    /* 将/帅被吃掉直接终局——放开将军限制后，这是最主要的胜负方式 */
    if (captured === -mover * XQ.K) {
      gameOver = true;
      winner = mover;
      var sideName = function (s) {
        if (mode === 'pve') return s === aiSide ? '电脑' : '你';
        return s === RED ? '红方' : '黑方';
      };
      resultText = sideName(mover) + '擒王获胜 · ' + sideName(-mover) + '的将/帅被吃';
      evals[history.length] = mover === RED ? MATE_SCORE : -MATE_SCORE;
    }

    checkGameEnd();
    syncPieces();
    /*
     * 先把对局流程推进下去（含触发电脑走子），再做其余绘制。
     * 否则绘制里任何一处抛异常，都会让对局停在"轮到电脑"却永远不动。
     */
    if (mode === 'pve') maybeAIMove();
    renderHints();
    renderMoveList();
    updateStatus();
    renderScore();
    renderEvalGraph();
    /* 终局后棋盘上可能已经没有将/帅了，再评估没有意义还会覆盖掉终局分 */
    if (!gameOver) requestEval();

    /* 音效：吃子 / 将军 / 终局优先于普通落子声 */
    if (gameOver) playSound(winner === humanSide() || (mode !== 'pve' && winner === turn) ? 'win' : 'lose');
    else if (XQ.inCheck(board, turn)) playSound('check');
    else if (captured) playSound('capture');
    else playSound('move');

  }

  /* 人机模式下"玩家"执哪边；其余模式返回 0 */
  function humanSide() {
    return mode === 'pve' ? -aiSide : 0;
  }

  /* 重新计算当前走子方的"可走着法"与"完全合法着法" */
  function refreshMoves() {
    playableMoves = XQ.genMoves(board, turn, []);
    legalMoves = XQ.genLegalMoves(board, turn, []);
  }

  function checkGameEnd() {
    if (gameOver) return true;
    if (legalMoves.length > 0) return false;

    gameOver = true;
    winner = -turn;                       /* 轮到谁走谁就输了 */
    var loserName = turn === RED ? '红方' : '黑方';
    var winnerName = turn === RED ? '黑方' : '红方';
    var reason = XQ.inCheck(board, turn) ? '将死' : '困毙';
    resultText = winnerName + '胜 · ' + loserName + '被' + reason;

    /* 终局局面本身没有合法着法，搜不出分，直接按被杀方记 -MATE */
    evals[history.length] = turn === RED ? -MATE_SCORE : MATE_SCORE;
    return true;
  }

  /* ---- AI 执行：优先放 Worker，起不来就退回主线程 ---- */
  var engineWorker = null;
  var workerSeq = 0;
  var workerPending = {};

  /*
   * file:// 下既不能 importScripts 本地脚本也不能 fetch 源码，
   * 所以把两个工厂函数的源码 toString() 出来拼成一个 Blob 当 Worker 用。
   */
  function buildWorkerSource() {
    return [
      XiangqiRules.toString(),
      XiangqiAIEngine.toString(),
      'XiangqiRules(self);',
      'XiangqiAIEngine(self);',
      'self.onmessage = function (e) {',
      '  var d = e.data;',
      '  /* kind="eval" 只是要一个局面评分，固定用红方视角搜，方便和棋步记录对齐 */',
      '  if (d.kind === "eval") {',
      '    self.XiangqiAI.search(d.board, 1, d.depth, d.time, 0);',
      '    self.postMessage({ id: d.id, info: self.XiangqiAI.lastInfo() });',
      '    return;',
      '  }',
      '  var m = self.XiangqiAI.search(d.board, d.side, d.depth, d.time, d.margin);',
      '  self.postMessage({ id: d.id, move: m, info: self.XiangqiAI.lastInfo() });',
      '};'
    ].join('\n');
  }

  function runOnMainThread(req, cb) {
    cb(AI.search(req.board, req.side, req.depth, req.time, req.margin), AI.lastInfo());
  }

  function initEngineWorker() {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' ||
        typeof URL === 'undefined' || !URL.createObjectURL) return null;
    try {
      var url = URL.createObjectURL(new Blob([buildWorkerSource()], { type: 'application/javascript' }));
      var w = new Worker(url);
      w.onmessage = function (e) {
        var job = workerPending[e.data.id];
        if (!job) return;
        delete workerPending[e.data.id];
        clearTimeout(job.timer);
        job.cb(e.data.move, e.data.info);
      };
      w.onerror = function () {
        /* Worker 挂了就把在等的活儿全部转回主线程，别让对局卡死 */
        var pending = workerPending;
        workerPending = {};
        engineWorker = null;
        Object.keys(pending).forEach(function (id) {
          clearTimeout(pending[id].timer);
          pending[id].fallback();
        });
      };
      return w;
    } catch (err) {
      return null;
    }
  }

  /* 往 Worker 投一个任务；Worker 不可用或超时就交给 fallback */
  function postJob(msg, cb, fallback) {
    if (!engineWorker) { fallback(); return; }
    var id = ++workerSeq;
    var timer = setTimeout(function () {
      if (!workerPending[id]) return;
      delete workerPending[id];
      engineWorker = null;
      fallback();
    }, msg.time + 5000);
    workerPending[id] = { cb: cb, timer: timer, fallback: fallback };
    msg.id = id;
    engineWorker.postMessage(msg);
  }

  /* 按给定参数搜索"当前走子方"的最佳着法 */
  function requestSearch(cfg, cb) {
    var req = {
      board: Int8Array.from(board),
      side: turn,
      depth: cfg.depth,
      time: cfg.time,
      margin: cfg.margin || 0
    };
    postJob(
      { board: req.board, side: req.side, depth: req.depth, time: req.time, margin: req.margin },
      cb,
      function () { runOnMainThread(req, cb); }
    );
  }

  function requestMove(cb) {
    requestSearch(DIFFICULTY[difficulty], cb);
  }

  /* 提示：替玩家想一步，高亮出来但不落子 */
  function hint() {
    if (!canIOperate() || hintBusy) return;
    hintBusy = true;
    var ply = history.length;
    updateStatus();
    requestSearch({ depth: 10, time: 2500, margin: 0 }, function (m) {
      hintBusy = false;
      updateStatus();
      /* 玩家可能已经自己走了，这时候提示就作废 */
      if (history.length !== ply || gameOver) return;
      if (m === null || m === undefined) return;
      hintMove = m;
      renderHints();
      setTimeout(function () {
        hintMove = null;
        renderHints();
      }, 3000);
    });
  }

  /* 认输（联机模式有独立按钮，走网络同步） */
  function resign() {
    if (gameOver || mode === 'online') return;
    gameOver = true;
    if (mode === 'pve') {
      winner = aiSide;
      resultText = '你认输了 · 电脑胜';
    } else {
      winner = -turn;
      resultText = (turn === RED ? '红方' : '黑方') + '认输 · ' + (turn === RED ? '黑方' : '红方') + '胜';
    }
    updateStatus();
    renderScore();
    playSound('lose');
  }

  /*
   * 走完一步就评估一次当前局面，用于胜率条和终局评分。
   * 有 Worker 就用固定深度的搜索（比分差稳定），没有就退回静态评估，不再阻塞主线程。
   */
  function requestEval() {
    if (!board) return;
    var ply = history.length;
    var gen = evalGen;

    /*
     * 评估是"每手一个"的，正常对局节奏下 Worker 完全跟得上。
     * 但如果有人狂点（或脚本连走），队列会堆到几十个，
     * 这时就主动丢中间的，宁可评分少几个采样点，也不让胜率条一直显示旧值。
     */
    if (evalInFlight > 3 && ply > 1) return;
    evalInFlight++;

    var snapshot = Int8Array.from(board);

    postJob(
      { kind: 'eval', board: snapshot, side: RED, depth: EVAL_DEPTH, time: EVAL_TIME },
      function (move, info) { onEval(gen, ply, info && info.score); },
      function () { onEval(gen, ply, AI.evaluate(snapshot, RED)); }
    );
  }

  function onEval(gen, ply, score) {
    evalInFlight = Math.max(0, evalInFlight - 1);
    /* 悔棋/重开之后才回来的旧结果直接丢掉，别污染新对局 */
    if (gen !== evalGen) return;
    if (typeof score !== 'number' || !isFinite(score)) return;
    evals[ply] = score;
    renderEvalBar();
    renderEvalGraph();
    renderMoveList();         /* 失误标记要等评估回来才知道，得重画一遍 */
    renderScore();            /* 终局评分依赖最后一手之后的评估，算完要补画一次 */
  }

  function maybeAIMove() {
    if (mode !== 'pve' || gameOver || turn !== aiSide) return;
    thinking = true;
    updateStatus();
    /* 先让人的着法滑到位，再让电脑"开始想" */
    setTimeout(runAI, ANIM_MS);
  }

  function runAI() {
    if (gameOver || turn !== aiSide) { thinking = false; updateStatus(); return; }

    /* 开局阶段先查库：下得更像人，也不会每盘都走成同一个样子 */
    if (difficulty !== 'easy') {
      var played = history.map(function (h) { return h.move; });
      var bm = AI.bookMove(played, legalMoves);   /* 开局库只出合法着法 */
      if (bm) {
        thinking = false;
        lastAiInfo = { book: true };
        applyMove(bm);
        return;
      }
    }

    requestMove(function (m, info) {
      thinking = false;
      if (gameOver) { updateStatus(); return; }
      if (m === null || m === undefined) {
        playableMoves = [];
        legalMoves = [];
        checkGameEnd();
        updateStatus();
        return;
      }
      lastAiInfo = info;
      applyMove(m);
    });
  }

  /* ---- 交互 ---- */
  function canIOperate() {
    if (gameOver || thinking) return false;
    if (mode === 'pve' && turn === aiSide) return false;
    if (mode === 'online' && turn !== netSide) return false;
    return true;
  }

  function onSquareClick(sq) {
    if (!canIOperate()) return;

    if (selected >= 0) {
      for (var i = 0; i < playableMoves.length; i++) {
        var m = playableMoves[i];
        if (XQ.moveFrom(m) === selected && XQ.moveTo(m) === sq) {
          applyMove(m);   /* 电脑的应招由 applyMove 内部触发 */
          return;
        }
      }
    }

    var piece = board[sq];
    if (piece !== 0 && XQ.sideOf(piece) === turn) {
      selected = (selected === sq) ? -1 : sq;
      if (selected >= 0) playSound('select');
    } else {
      selected = -1;
    }
    renderHints();
  }

  function squareFromEvent(ev) {
    var rect = boardEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    var px = (ev.clientX - rect.left) / rect.width * VB_W;
    var py = (ev.clientY - rect.top) / rect.height * VB_H;
    var c = Math.round((px - PAD) / STEP);
    var r = Math.round((py - PAD) / STEP);
    if (r < 0 || r > 9 || c < 0 || c > 8) return -1;
    var dx = px - (PAD + STEP * c), dy = py - (PAD + STEP * r);
    if (dx * dx + dy * dy > 52 * 52) return -1;
    /* 显示坐标反算回逻辑坐标 */
    if (flipped) { r = 9 - r; c = 8 - c; }
    return r * 9 + c;
  }

  /* ---- 尺寸自适应 ---- */
  var NARROW_QUERY = '(max-width: 860px)';
  var narrowQuery = window.matchMedia(NARROW_QUERY);

  function layout() {
    document.documentElement.classList.toggle('is-narrow', narrowQuery.matches);

    var aw = boardWrap.clientWidth;
    var ah = boardWrap.clientHeight;
    if (!aw || !ah) return;

    var ratio = VB_W / VB_H;
    var w = aw, h = w / ratio;
    if (h > ah) { h = ah; w = h * ratio; }
    w = Math.floor(w);
    h = Math.floor(h);

    boardEl.style.width = w + 'px';
    boardEl.style.height = h + 'px';

    var scale = w / VB_W;
    geo.cell = STEP * scale;
    geo.pad = PAD * scale;
    geo.size = w * 0.092;
    boardEl.style.setProperty('--piece', geo.size.toFixed(2) + 'px');
    boardEl.style.setProperty('--cs', geo.cell.toFixed(2) + 'px');

    /* 重排时先关掉过渡再摆位，否则棋子会从旧位置满屏飞过来 */
    pieceLayer.classList.add('no-anim');
    for (var sq = 0; sq < 90; sq++) {
      if (pieceEls[sq]) pieceEls[sq].style.transform = translateFor(sq);
    }
    void boardEl.offsetHeight;
    pieceLayer.classList.remove('no-anim');
    renderHints();
  }

  /* ---- 悔棋 ---- */
  function undoOne() {
    var h = history.pop();
    if (!h) return false;
    XQ.unmakeMove(board, h.move, h.captured);
    turn = h.side;
    return true;
  }

  function undo() {
    if (thinking || history.length === 0 || mode === 'online') return;
    gameOver = false;
    resultText = '';
    undoOne();
    if (mode === 'pve' && turn === aiSide && history.length > 0) undoOne();

    lastMove = history.length ? history[history.length - 1].move : null;
    selected = -1;
    winner = 0;
    refreshMoves();

    evalGen++;
    evals.length = history.length + 1;   /* 丢掉被悔掉的那些步的评估 */
    clearPieces();
    syncPieces();
    renderHints();
    renderMoveList();
    updateStatus();
    renderScore();
    renderEvalBar();
    renderEvalGraph();
    requestEval();

    if (mode === 'pve' && turn === aiSide && !gameOver) maybeAIMove();
  }

  /* ---- 开局 ---- */
  function newGame() {
    board = XQ.parseFen(XQ.START_FEN);
    turn = RED;
    history = [];
    selected = -1;
    gameOver = false;
    resultText = '';
    lastMove = null;
    thinking = false;
    lastAiInfo = null;
    winner = 0;
    refreshMoves();

    evalGen++;
    evalInFlight = 0;
    evals = [];
    resetChat();
    updateChatVisibility();
    clearPieces();
    syncPieces();
    renderHints();
    renderMoveList();
    updateStatus();
    renderScore();
    renderEvalBar();
    renderEvalGraph();
    requestEval();

    maybeAIMove();
  }

  /* ================= 联机 ================= */

  function setNetStatus(text, cls) {
    var el = document.getElementById('onlineStatus');
    el.textContent = text || '';
    el.className = 'online-status ' + (cls || '');
  }

  function copyText(text, btn, okMsg) {
    if (btn) flashButton(btn, '已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setNetStatus(okMsg, 'ok');
      }, function () {
        setNetStatus('复制失败，请手动选中复制', 'err');
      });
      return;
    }
    setNetStatus('这个浏览器不支持自动复制，请手动选中', 'err');
  }

  function showOnlineStep(which) {
    document.getElementById('onlineIntro').hidden = which !== 'intro';
    document.getElementById('onlineHostFlow').hidden = which !== 'host';
    document.getElementById('onlineGuestFlow').hidden = which !== 'guest';
  }

  function startOnlineGame(side) {
    netSide = side;
    netGroup.hidden = false;
    onlineGroup.hidden = true;
    document.getElementById('netSideLabel').textContent =
      '你执' + (side === RED ? '红方（先手）' : '黑方（后手）');
    newGame();
    addChat('sys', '已连接，开始对局');
  }

  function setupOnline() {
    var roomCodeEl = document.getElementById('roomCode');
    var roomInputEl = document.getElementById('roomInput');

    document.getElementById('hostBtn').addEventListener('click', function () {
      netRole = 'host';
      showOnlineStep('host');
      roomCodeEl.textContent = '·····';
      setNetStatus('正在连接中转服务器…', 'busy');
      NET.host().then(function (code) {
        roomCodeEl.textContent = code;
        netRoom = code;
        updateStatus();
        setNetStatus('房号已生成，等对方输入后会自动接上。', 'ok');
      }).catch(function (e) {
        setNetStatus('创建失败：' + e.message, 'err');
      });
    });

    document.getElementById('copyRoomBtn').addEventListener('click', function () {
      var code = roomCodeEl.textContent.trim();
      if (!/^[0-9A-Z]{5}$/.test(code)) { setNetStatus('还没有房号', 'err'); return; }
      copyText(code, this, '已复制');
    });

    document.getElementById('joinBtn').addEventListener('click', function () {
      netRole = 'guest';
      showOnlineStep('guest');
      setNetStatus('输入 5 位房号后点「连接」。');
      setTimeout(function () { roomInputEl.focus(); }, 60);
    });

    /* 只保留合法字符并大写，省得用户输入全角或小写 */
    roomInputEl.addEventListener('input', function () {
      var v = NET.normalizeCode(roomInputEl.value);
      if (v !== roomInputEl.value) roomInputEl.value = v;
    });
    roomInputEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); doJoin(); }
    });

    function doJoin() {
      var code = NET.normalizeCode(roomInputEl.value);
      roomInputEl.value = code;
      if (code.length !== 5) { setNetStatus('房号是 5 位，请检查一下', 'err'); return; }
      setNetStatus('正在连接…', 'busy');
      NET.join(code).then(function () {
        setNetStatus('已应答，正在建立直连…', 'busy');
      }).catch(function (e) {
        setNetStatus('加入失败：' + e.message, 'err');
      });
    }
    document.getElementById('joinRoomBtn').addEventListener('click', doJoin);

    document.getElementById('netResignBtn').addEventListener('click', function () {
      if (gameOver) return;
      NET.send({ t: 'resign' });
      gameOver = true;
      winner = -netSide;
      resultText = '你认输了 · ' + (netSide === RED ? '黑方' : '红方') + '胜';
      updateStatus();
      renderScore();
    });

    document.getElementById('rematchBtn').addEventListener('click', function () {
      NET.send({ t: 'rematch' });
      startOnlineGame(-netSide);
    });

    NET.on('open', function () {
      setNetStatus('已连接，对局开始。', 'ok');
      /* 房主执红先手，加入方执黑 */
      startOnlineGame(netRole === 'guest' ? BLACK : RED);
    });

    NET.on('close', function (reason) {
      if (mode !== 'online') return;
      addChat('sys', '连接已断开：' + reason);
      setNetStatus('连接中断：' + reason, 'err');
      netGroup.hidden = true;
      onlineGroup.hidden = false;
      showOnlineStep('intro');
      netSide = 0;
      netRoom = '';
    });

    NET.on('message', function (msg) {
      if (!msg || !msg.t) return;
      if (msg.t === 'move') {
        if (gameOver) return;
        if (msg.ply !== history.length) {
          setNetStatus('步数对不上，双方局面可能已经不一致', 'err');
          return;
        }
        if (turn === netSide) return;
        /* 用本地规则再验一遍，防止对方乱发或数据损坏 */
        /* 只校验"这个子能不能这么走"，不再要求必须应将——
           本地放开了将军限制，对方也一样 */
        if (playableMoves.indexOf(msg.m) < 0) {
          setNetStatus('收到一个不可能的着法，已忽略', 'err');
          return;
        }
        applyMove(msg.m, true);
      } else if (msg.t === 'chat') {
        addChat('them', msg.text);
      } else if (msg.t === 'resign') {
        gameOver = true;
        winner = netSide;
        resultText = '对方认输 · 你赢了';
        updateStatus();
        renderScore();
      } else if (msg.t === 'rematch') {
        startOnlineGame(-netSide);
      }
    });
  }

  /* 按钮上短暂显示一句反馈，避免额外弹窗 */
  function flashButton(btn, text) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = text;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(function () {
      btn.textContent = btn.dataset.label;
    }, 1400);
  }

  /* ---- 控件绑定 ---- */
  function bindControls() {
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (thinking) return;
        mode = btn.dataset.mode;
        document.querySelectorAll('.mode-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        pveGroup.hidden = (mode !== 'pve');
        sideGroup.hidden = (mode !== 'pve');
        onlineGroup.hidden = (mode !== 'online');
        netGroup.hidden = true;

        if (mode === 'online') {
          NET.close();
          netSide = 0;
          netRoom = '';
          showOnlineStep('intro');
          setNetStatus('创建房间后把配对码发给朋友；或粘贴朋友的配对码加入。');
        }
        /* 换模式等于换了个对手，旧的对话记录不该留着 */
        resetChat();
        updateChatVisibility();
        newGame();
      });
    });

    /* 三档难度按钮 */
    var diffBtns = document.querySelectorAll('[data-diff]');
    diffBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (thinking) return;
        difficulty = btn.dataset.diff;
        diffBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
        saveSettings();
      });
    });

    document.querySelectorAll('#sideSeg button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (thinking) return;
        aiSide = -Number(btn.dataset.side);
        document.querySelectorAll('#sideSeg button').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        saveSettings();
        newGame();
      });
    });

    document.getElementById('flipBtn').addEventListener('click', function () {
      flipped = !flipped;
      document.getElementById('flipBtn').classList.toggle('on', flipped);
      buildBoard();
      layout();
      renderHints();
      saveSettings();
    });

    document.getElementById('soundBtn').addEventListener('click', function () {
      soundOn = !soundOn;
      document.getElementById('soundBtn').classList.toggle('on', soundOn);
      document.getElementById('soundBtn').textContent = soundOn ? '音效 开' : '音效 关';
      if (soundOn) playSound('select');
      saveSettings();
    });

    document.getElementById('resignBtn').addEventListener('click', resign);

    document.getElementById('chatSend').addEventListener('click', sendChat);
    chatInputEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); sendChat(); }
    });
    /* 一点开输入框就把"新消息"角标消掉 */

    document.getElementById('copyRecordBtn').addEventListener('click', function () {
      if (!history.length) { flashButton(this, '还没走子'); return; }
      var text = gameRecord();
      var self = this;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          flashButton(self, '已复制');
        }, function () { flashButton(self, '复制失败'); });
      } else {
        flashButton(this, '复制失败');
      }
    });

    undoBtn.addEventListener('click', undo);
    document.getElementById('restartBtn').addEventListener('click', function () {
      if (thinking) return;
      if (mode === 'online') {
        if (!NET.isOpen()) { setNetStatus('还没有连接', 'err'); return; }
        NET.send({ t: 'rematch' });
        startOnlineGame(-netSide);
        return;
      }
      newGame();
    });

    boardEl.addEventListener('click', function (ev) {
      var sq = squareFromEvent(ev);
      if (sq >= 0) onSquareClick(sq);
    });

    /* 快捷键。在输入框里打字时不拦截 */
    document.addEventListener('keydown', function (ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      switch (ev.key.toLowerCase()) {
        case 'u':
          if (!undoBtn.disabled) { undo(); ev.preventDefault(); }
          break;
        case 'f':
          document.getElementById('flipBtn').click(); ev.preventDefault();
          break;
        case 'n':
          if (!thinking) { document.getElementById('restartBtn').click(); ev.preventDefault(); }
          break;
        case 'escape':
          selected = -1; renderHints();
          break;
      }
    });

    setupOnline();

    window.addEventListener('resize', layout);
    if (narrowQuery.addEventListener) narrowQuery.addEventListener('change', layout);
    if (window.ResizeObserver) new ResizeObserver(layout).observe(boardWrap);
  }

  /* ---- 启动 ---- */
  mode = 'pve';
  aiSide = BLACK;
  difficulty = 'normal';
  loadSettings();

  engineWorker = initEngineWorker();

  buildBoard();
  bindControls();
  syncSettingsUI();
  layout();
  newGame();

  /* 面板宽度变化会影响曲线图的画布尺寸 */
  window.addEventListener('resize', function () { renderEvalGraph(); });

  function syncSettingsUI() {
    document.querySelectorAll('[data-diff]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.diff === difficulty);
    });
    document.querySelectorAll('#sideSeg button').forEach(function (b) {
      b.classList.toggle('active', Number(b.dataset.side) === -aiSide);
    });
    document.getElementById('flipBtn').classList.toggle('on', flipped);
    document.getElementById('soundBtn').classList.toggle('on', soundOn);
    document.getElementById('soundBtn').textContent = soundOn ? '音效 开' : '音效 关';
  }
})();
