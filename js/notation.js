/*
 * 中文记谱法
 *   红方纵线自右向左为一~九，黑方自左向右为 1~9
 *   格式：棋子名 + 起始纵线 + 动作(进/退/平) + 目标纵线或步数
 *   同一纵线有两个同种棋子时改用 前/后 代替起始纵线
 */
(function (global) {
  'use strict';

  var XQ = global.Xiangqi;
  var CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  var NAMES = {
    1: ['帅', '将'], 2: ['仕', '士'], 3: ['相', '象'],
    4: ['马', '馬'], 5: ['车', '車'], 6: ['炮', '砲'], 7: ['兵', '卒']
  };

  /* 斜行棋子（马/相/士）：进退后面写目标纵线，其余写步数 */
  function isDiagonalMover(type) {
    return type === XQ.N || type === XQ.B || type === XQ.A;
  }

  function toChinese(bd, m, side) {
    var from = XQ.moveFrom(m), to = XQ.moveTo(m);
    var piece = bd[from];
    if (piece === 0) return '??';

    var type = piece > 0 ? piece : -piece;
    var isRed = side > 0;
    var fr = (from / 9) | 0, fc = from % 9;
    var tr = (to / 9) | 0, tc = to % 9;

    var name = NAMES[type][isRed ? 0 : 1];
    var file = function (c) { return isRed ? 9 - c : c + 1; };
    var num = function (n) { return isRed ? CN[n] : String(n); };

    /* 前后判定：找出同一纵线上的同类己方棋子 */
    var sameFile = [];
    for (var r = 0; r < 10; r++) {
      var q = bd[r * 9 + fc];
      if (q !== 0 && (q > 0 ? q : -q) === type && XQ.sideOf(q) === side) sameFile.push(r);
    }
    /* 前 → 后：红方行号小者为前，黑方行号大者为前 */
    sameFile.sort(function (a, b) { return isRed ? a - b : b - a; });

    var head;
    if (sameFile.length >= 2) {
      var idx = sameFile.indexOf(fr);
      var prefix;
      if (sameFile.length === 2) prefix = idx === 0 ? '前' : '后';
      else if (sameFile.length === 3) prefix = ['前', '中', '后'][idx];
      else prefix = num(idx + 1);
      head = prefix + name;
    } else {
      head = name + num(file(fc));
    }

    var action, target;
    if (tr === fr) {
      action = '平';
      target = num(file(tc));
    } else {
      var forward = isRed ? (tr < fr) : (tr > fr);
      action = forward ? '进' : '退';
      target = isDiagonalMover(type) ? num(file(tc)) : num(Math.abs(tr - fr));
    }

    return head + action + target;
  }

  global.XiangqiNotation = { toChinese: toChinese };
})(window);
