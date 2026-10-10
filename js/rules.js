/*
 * 中国象棋规则引擎
 * 棋盘：90 格，index = row * 9 + col
 *   row 0  = 黑方底线（上方），row 9 = 红方底线（下方）
 *   col 0  = 画面最左列，col 8 = 画面最右列
 * 棋子编码：正数 = 红方，负数 = 黑方；绝对值 1..7 为兵种
 *
 * 写成具名工厂函数而不是匿名 IIFE，是为了能把源码 toString() 出来、
 * 塞进 Blob 里当 Worker 用（file:// 下没法 importScripts 本地脚本，
 * 也没法 fetch 源码）。main 线程和 Worker 都调用同一个工厂。
 */
function XiangqiRules(global) {
  'use strict';

  var K = 1, A = 2, B = 3, N = 4, R = 5, C = 6, P = 7;
  var RED = 1, BLACK = -1;

  var START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w';

  var CHAR_TO_TYPE = { k: K, a: A, b: B, n: N, r: R, c: C, p: P };

  /* 走法编码：from * 90 + to，取值范围 0..8099 */
  function move(from, to) { return from * 90 + to; }
  function moveFrom(m) { return (m / 90) | 0; }
  function moveTo(m) { return m % 90; }

  function rowOf(sq) { return (sq / 9) | 0; }
  function colOf(sq) { return sq % 9; }
  function sqOf(r, c) { return r * 9 + c; }

  function sideOf(piece) { return piece > 0 ? RED : BLACK; }
  function typeOf(piece) { return piece > 0 ? piece : -piece; }

  /* 由 FEN 字符串生成棋盘 */
  function parseFen(fen) {
    var bd = new Int8Array(90);
    var rows = fen.split(' ')[0].split('/');
    for (var r = 0; r < 10; r++) {
      var c = 0;
      var line = rows[r] || '';
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch >= '1' && ch <= '9') { c += +ch; continue; }
        var lower = ch.toLowerCase();
        var type = CHAR_TO_TYPE[lower];
        if (!type) continue;
        bd[r * 9 + c] = (ch === lower) ? -type : type;
        c++;
      }
    }
    return bd;
  }

  function cloneBoard(bd) { return Int8Array.from(bd); }

  /* 九宫范围 */
  function palaceRows(side) { return side > 0 ? [7, 9] : [0, 2]; }
  function inPalace(side, r, c) {
    var pr = palaceRows(side);
    return r >= pr[0] && r <= pr[1] && c >= 3 && c <= 5;
  }

  /* 落子：目标格为空或为敌子时写入 out */
  function addMove(bd, side, from, to, out) {
    var q = bd[to];
    if (q !== 0 && sideOf(q) === side) return;
    out.push(from * 90 + to);
  }

  function genKing(bd, side, r, c, out) {
    var from = r * 9 + c;
    var pr = palaceRows(side);
    var D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (var i = 0; i < 4; i++) {
      var nr = r + D[i][0], nc = c + D[i][1];
      if (nr < pr[0] || nr > pr[1] || nc < 3 || nc > 5) continue;
      addMove(bd, side, from, nr * 9 + nc, out);
    }
    /* 白脸将：同列且中间无子，可直接吃对方将 */
    var dir = side > 0 ? -1 : 1;
    for (var rr = r + dir; rr >= 0 && rr <= 9; rr += dir) {
      var q = bd[rr * 9 + c];
      if (q === 0) continue;
      if (q === -side * K) out.push(from * 90 + rr * 9 + c);
      break;
    }
  }

  function genAdvisor(bd, side, r, c, out) {
    var from = r * 9 + c;
    var D = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    for (var i = 0; i < 4; i++) {
      var nr = r + D[i][0], nc = c + D[i][1];
      if (!inPalace(side, nr, nc)) continue;
      addMove(bd, side, from, nr * 9 + nc, out);
    }
  }

  function genElephant(bd, side, r, c, out) {
    var from = r * 9 + c;
    /* 象走田，不能过河 */
    var rMin = side > 0 ? 5 : 0;
    var rMax = side > 0 ? 9 : 4;
    var D = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
    for (var i = 0; i < 4; i++) {
      var dr = D[i][0], dc = D[i][1];
      var nr = r + dr, nc = c + dc;
      if (nr < rMin || nr > rMax || nc < 0 || nc > 8) continue;
      if (bd[(r + dr / 2) * 9 + (c + dc / 2)] !== 0) continue; /* 塞象眼 */
      addMove(bd, side, from, nr * 9 + nc, out);
    }
  }

  function genHorse(bd, side, r, c, out) {
    var from = r * 9 + c;
    /* [dr, dc, 马腿 dr, 马腿 dc] */
    var M = [
      [-2, -1, -1, 0], [-2, 1, -1, 0],
      [2, -1, 1, 0], [2, 1, 1, 0],
      [-1, -2, 0, -1], [1, -2, 0, -1],
      [-1, 2, 0, 1], [1, 2, 0, 1]
    ];
    for (var i = 0; i < 8; i++) {
      var nr = r + M[i][0], nc = c + M[i][1];
      if (nr < 0 || nr > 9 || nc < 0 || nc > 8) continue;
      if (bd[(r + M[i][2]) * 9 + (c + M[i][3])] !== 0) continue; /* 蹩马腿 */
      addMove(bd, side, from, nr * 9 + nc, out);
    }
  }

  function genRook(bd, side, r, c, out) {
    var from = r * 9 + c;
    var D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (var i = 0; i < 4; i++) {
      var dr = D[i][0], dc = D[i][1];
      var nr = r + dr, nc = c + dc;
      while (nr >= 0 && nr <= 9 && nc >= 0 && nc <= 8) {
        var to = nr * 9 + nc, q = bd[to];
        if (q === 0) {
          out.push(from * 90 + to);
        } else {
          if (sideOf(q) !== side) out.push(from * 90 + to);
          break;
        }
        nr += dr; nc += dc;
      }
    }
  }

  function genCannon(bd, side, r, c, out) {
    var from = r * 9 + c;
    var D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (var i = 0; i < 4; i++) {
      var dr = D[i][0], dc = D[i][1];
      var nr = r + dr, nc = c + dc, jumped = false;
      while (nr >= 0 && nr <= 9 && nc >= 0 && nc <= 8) {
        var to = nr * 9 + nc, q = bd[to];
        if (!jumped) {
          if (q === 0) out.push(from * 90 + to);
          else jumped = true; /* 找到炮架 */
        } else if (q !== 0) {
          if (sideOf(q) !== side) out.push(from * 90 + to);
          break;
        }
        nr += dr; nc += dc;
      }
    }
  }

  function genPawn(bd, side, r, c, out) {
    var from = r * 9 + c;
    var dir = side > 0 ? -1 : 1;
    var nr = r + dir;
    if (nr >= 0 && nr <= 9) addMove(bd, side, from, nr * 9 + c, out);
    /* 过河后可以横走 */
    var crossed = side > 0 ? r <= 4 : r >= 5;
    if (crossed) {
      if (c > 0) addMove(bd, side, from, r * 9 + c - 1, out);
      if (c < 8) addMove(bd, side, from, r * 9 + c + 1, out);
    }
  }

  /* 生成伪合法着法（未过滤自将），结果写入 out 并返回 out */
  function genMoves(bd, side, out) {
    out = out || [];
    out.length = 0;
    for (var from = 0; from < 90; from++) {
      var p = bd[from];
      if (p === 0 || sideOf(p) !== side) continue;
      var r = (from / 9) | 0, c = from % 9;
      switch (typeOf(p)) {
        case K: genKing(bd, side, r, c, out); break;
        case A: genAdvisor(bd, side, r, c, out); break;
        case B: genElephant(bd, side, r, c, out); break;
        case N: genHorse(bd, side, r, c, out); break;
        case R: genRook(bd, side, r, c, out); break;
        case C: genCannon(bd, side, r, c, out); break;
        case P: genPawn(bd, side, r, c, out); break;
      }
    }
    return out;
  }

  function findKing(bd, side) {
    var want = side > 0 ? K : -K;
    var pr = palaceRows(side);
    for (var r = pr[0]; r <= pr[1]; r++) {
      for (var c = 3; c <= 5; c++) {
        var i = r * 9 + c;
        if (bd[i] === want) return i;
      }
    }
    return -1;
  }

  /* side 方的将/帅是否正被攻击（含白脸将） */
  function isKingAttacked(bd, side) {
    var ks = findKing(bd, side);
    if (ks < 0) return false;
    var kr = (ks / 9) | 0, kc = ks % 9;
    var opp = -side;
    var i, dr, dc, nr, nc, q, t;

    /* 车 / 炮 / 对面将 */
    var D = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (i = 0; i < 4; i++) {
      dr = D[i][0]; dc = D[i][1];
      nr = kr + dr; nc = kc + dc;
      var jumped = false;
      while (nr >= 0 && nr <= 9 && nc >= 0 && nc <= 8) {
        q = bd[nr * 9 + nc];
        if (q !== 0) {
          t = q > 0 ? q : -q;
          if (!jumped) {
            if (sideOf(q) === opp && (t === R || t === K)) return true;
            jumped = true;
          } else {
            if (sideOf(q) === opp && t === C) return true;
            break;
          }
        }
        nr += dr; nc += dc;
      }
    }

    /* 马 */
    var HM = [
      [-2, -1], [-2, 1], [2, -1], [2, 1],
      [-1, -2], [1, -2], [-1, 2], [1, 2]
    ];
    for (i = 0; i < 8; i++) {
      dr = HM[i][0]; dc = HM[i][1];
      var hr = kr + dr, hc = kc + dc;
      if (hr < 0 || hr > 9 || hc < 0 || hc > 8) continue;
      if (bd[hr * 9 + hc] !== -side * N) continue;
      /* 马腿：马朝目标方向走一格 */
      var lr = hr - ((dr / 2) | 0);
      var lc = hc - ((dc / 2) | 0);
      if (bd[lr * 9 + lc] !== 0) continue;
      return true;
    }

    /* 象（可攻击到九宫角上的将） */
    var BM = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
    for (i = 0; i < 4; i++) {
      dr = BM[i][0]; dc = BM[i][1];
      var er = kr + dr, ec = kc + dc;
      if (er < 0 || er > 9 || ec < 0 || ec > 8) continue;
      if (bd[er * 9 + ec] !== -side * B) continue;
      if (bd[(kr + dr / 2) * 9 + (kc + dc / 2)] !== 0) continue;
      return true;
    }

    /* 士 */
    var AM = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    for (i = 0; i < 4; i++) {
      var ar = kr + AM[i][0], ac = kc + AM[i][1];
      if (ar < 0 || ar > 9 || ac < 0 || ac > 8) continue;
      if (bd[ar * 9 + ac] === -side * A) return true;
    }

    /* 兵 / 卒 */
    var oppDir = side > 0 ? 1 : -1; /* 对方前进方向 */
    var pr2 = kr - oppDir;
    if (pr2 >= 0 && pr2 <= 9 && bd[pr2 * 9 + kc] === -side * P) return true;
    var crossedRow = side > 0 ? 5 : 4;
    var sideOk = side > 0 ? (kr >= crossedRow) : (kr <= crossedRow);
    if (sideOk) {
      if (kc > 0 && bd[kr * 9 + kc - 1] === -side * P) return true;
      if (kc < 8 && bd[kr * 9 + kc + 1] === -side * P) return true;
    }

    return false;
  }

  function inCheck(bd, side) { return isKingAttacked(bd, side); }

  /* 走子 / 撤销，返回被吃子（0 表示空格） */
  function makeMove(bd, m) {
    var from = (m / 90) | 0, to = m % 90;
    var captured = bd[to];
    bd[to] = bd[from];
    bd[from] = 0;
    return captured;
  }

  function unmakeMove(bd, m, captured) {
    var from = (m / 90) | 0, to = m % 90;
    bd[from] = bd[to];
    bd[to] = captured;
  }

  /* 生成完全合法着法（过滤送将 / 自将） */
  function genLegalMoves(bd, side, out) {
    out = out || [];
    out.length = 0;
    var buf = [];
    genMoves(bd, side, buf);
    for (var i = 0; i < buf.length; i++) {
      var m = buf[i];
      var cap = makeMove(bd, m);
      if (!isKingAttacked(bd, side)) out.push(m);
      unmakeMove(bd, m, cap);
    }
    return out;
  }

  function isLegalMove(bd, side, m) {
    var cap = makeMove(bd, m);
    var ok = !isKingAttacked(bd, side);
    unmakeMove(bd, m, cap);
    return ok;
  }

  /*
   * 局面状态：
   *   'ok'        正常
   *   'check'     被将军
   *   'checkmate' 被将死
   *   'stalemate' 困毙（象棋规则中同样判负）
   */
  function gameStatus(bd, side) {
    if (genLegalMoves(bd, side).length === 0) {
      return isKingAttacked(bd, side) ? 'checkmate' : 'stalemate';
    }
    return isKingAttacked(bd, side) ? 'check' : 'ok';
  }

  /* 棋子中文名 [红, 黑] */
  var PIECE_CHAR = {
    1: ['帅', '将'], 2: ['仕', '士'], 3: ['相', '象'],
    4: ['马', '馬'], 5: ['车', '車'], 6: ['炮', '砲'], 7: ['兵', '卒']
  };

  function pieceChar(piece) {
    if (piece === 0) return '';
    return PIECE_CHAR[typeOf(piece)][piece > 0 ? 0 : 1];
  }

  global.Xiangqi = {
    K: K, A: A, B: B, N: N, R: R, C: C, P: P,
    RED: RED, BLACK: BLACK,
    START_FEN: START_FEN,
    parseFen: parseFen,
    cloneBoard: cloneBoard,
    move: move, moveFrom: moveFrom, moveTo: moveTo,
    rowOf: rowOf, colOf: colOf, sqOf: sqOf,
    sideOf: sideOf, typeOf: typeOf,
    genMoves: genMoves,
    genLegalMoves: genLegalMoves,
    isLegalMove: isLegalMove,
    isKingAttacked: isKingAttacked,
    inCheck: inCheck,
    findKing: findKing,
    makeMove: makeMove,
    unmakeMove: unmakeMove,
    gameStatus: gameStatus,
    pieceChar: pieceChar,
    inPalace: inPalace
  };
}

/* 主线程直接装载；Worker 里由 bootstrap 调 XiangqiRules(self) */
if (typeof window !== 'undefined') XiangqiRules(window);
