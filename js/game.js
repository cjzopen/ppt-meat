/* ===========================================================
   天音彼方 打肉！  (MVP)
   - Canvas 渲染，原創可愛天使角色（程式繪製，無外部素材）
   - 關卡推進：第1關 連打 → 第2關 連擊 → 第3關 節奏，穿插隨機 QTE
   - 操作：F / 滑鼠左鍵 = 左手；J / 滑鼠右鍵 = 右手；QTE 與節奏用鍵盤
   - 全程鎖捲動、空白鍵 / 方向鍵 preventDefault
   =========================================================== */
(function () {
  'use strict';

  const W = 960, H = 600;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // 依裝置像素密度提高解析度
  function setupHiDPI() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  setupHiDPI();
  window.addEventListener('resize', setupHiDPI);

  // ---------- 小工具 ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const choice = (arr) => arr[(Math.random() * arr.length) | 0];
  const now = () => performance.now();

  // ---------- 音效（WebAudio 合成，無音檔） ----------
  const Audio = {
    ctx: null,
    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    },
    tone(freq, dur, type, gain, slideTo) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(gain || 0.2, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur);
    },
    noise(dur, gain) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime;
      const n = Math.floor(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = this.ctx.createBufferSource();
      const g = this.ctx.createGain();
      g.gain.value = gain || 0.25;
      src.buffer = buf;
      src.connect(g).connect(this.ctx.destination);
      src.start(t0);
    },
    punch() { this.noise(0.08, 0.3); this.tone(140, 0.12, 'square', 0.18, 60); },
    good() { this.tone(520, 0.1, 'triangle', 0.2); },
    perfect() { this.tone(880, 0.08, 'triangle', 0.22, 1320); },
    miss() { this.tone(120, 0.2, 'sawtooth', 0.18, 70); },
    qte() { this.tone(660, 0.07, 'square', 0.2); this.tone(990, 0.12, 'square', 0.18); },
    clear() {[523,659,784,1046].forEach((f,i)=>setTimeout(()=>this.tone(f,0.18,'triangle',0.22),i*90)); }
  };

  // ---------- 輸入系統（含防雷） ----------
  const HIT_KEYS = { 'KeyF': 'L', 'KeyJ': 'R' };
  // 遊玩中需攔截預設行為的鍵：空白鍵、方向鍵、F、J
  const PREVENT_KEYS = new Set(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyF','KeyJ']);

  const Input = {
    hits: [],          // 打肉事件佇列：{hand:'L'|'R'}
    keyEvents: [],     // 原始鍵碼佇列（給 QTE / 節奏關用）：{code}
    down: new Set(),
    consumeHits() { const h = this.hits; this.hits = []; return h; },
    consumeKeys() { const k = this.keyEvents; this.keyEvents = []; return k; },
    clear() { this.hits = []; this.keyEvents = []; },
  };

  window.addEventListener('keydown', (e) => {
    if (PREVENT_KEYS.has(e.code)) e.preventDefault();   // 防空白鍵 / 方向鍵捲動
    if (e.repeat) return;                                // 不吃長按連發
    Input.down.add(e.code);
    Input.keyEvents.push({ code: e.code });
    if (HIT_KEYS[e.code]) Input.hits.push({ hand: HIT_KEYS[e.code] });
  }, { passive: false });

  window.addEventListener('keyup', (e) => { Input.down.delete(e.code); });

  // 滑鼠：左鍵=左手，右鍵=右手
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    Audio.init();
    if (e.button === 0) Input.hits.push({ hand: 'L' });
    else if (e.button === 2) Input.hits.push({ hand: 'R' });
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // 右鍵當右手，禁選單

  // 觸控：左半=左手，右半=右手
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    Audio.init();
    const r = canvas.getBoundingClientRect();
    for (const t of e.changedTouches) {
      Input.hits.push({ hand: (t.clientX - r.left) < r.width / 2 ? 'L' : 'R' });
    }
  }, { passive: false });

  // 分頁失焦自動暫停
  let paused = false;
  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    if (!paused) lastT = now();
  });

  // ---------- 視覺特效 ----------
  const particles = [];
  function burst(x, y, color, n) {
    for (let i = 0; i < (n || 12); i++) {
      const a = rand(0, Math.PI * 2), sp = rand(80, 320);
      particles.push({ x, y, vx: Math.cos(a)*sp, vy: Math.sin(a)*sp - 60,
        life: rand(0.4, 0.8), max: 0.8, r: rand(3, 8), color: color || '#ff8fc7' });
    }
  }
  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt; if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.vy += 600 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    }
  }
  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      // 星形小點
      star(p.x, p.y, p.r, p.r * 0.45, 5);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function star(cx, cy, outer, inner, points) {
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 ? inner : outer;
      const a = (Math.PI / points) * i - Math.PI / 2;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  const popTexts = [];
  function pop(x, y, text, color, size) {
    popTexts.push({ x, y, text, color: color || '#fff', size: size || 40, life: 0.9, max: 0.9 });
  }
  function updatePops(dt) {
    for (let i = popTexts.length - 1; i >= 0; i--) {
      const p = popTexts[i]; p.life -= dt; p.y -= 50 * dt;
      if (p.life <= 0) popTexts.splice(i, 1);
    }
  }
  function drawPops() {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of popTexts) {
      const k = p.life / p.max;
      const scale = 1 + (1 - k) * 0.4;
      ctx.globalAlpha = clamp(k * 1.4, 0, 1);
      ctx.font = `900 ${p.size * scale}px "Microsoft JhengHei", sans-serif`;
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,.35)';
      const lines = String(p.text).split('\n');
      lines.forEach((line, i) => {
        const ly = p.y + (i - (lines.length - 1) / 2) * p.size * scale * 1.05;
        ctx.strokeText(line, p.x, ly);
        ctx.fillStyle = p.color;
        ctx.fillText(line, p.x, ly);
      });
    }
    ctx.globalAlpha = 1;
  }

  // 螢幕震動
  let shakeT = 0, shakeMag = 0;
  function shake(mag) { shakeT = 0.18; shakeMag = mag || 8; }

  // ---------- 背景 ----------
  function drawBackground(t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#a9e4ff');
    g.addColorStop(0.55, '#cfeeff');
    g.addColorStop(1, '#ffe9f3');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 雲
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    for (let i = 0; i < 4; i++) {
      const cx = ((t * 14 + i * 280) % (W + 240)) - 120;
      const cy = 70 + i * 30 + Math.sin(t + i) * 6;
      cloud(cx, cy, 1 - i * 0.12);
    }
    // 地面
    ctx.fillStyle = '#bfe9c8';
    ctx.beginPath();
    ctx.moveTo(0, H); ctx.lineTo(0, H - 90);
    ctx.quadraticCurveTo(W / 2, H - 130, W, H - 90); ctx.lineTo(W, H);
    ctx.closePath(); ctx.fill();
  }
  function cloud(x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, 7); ctx.arc(28, 6, 22, 0, 7);
    ctx.arc(-26, 8, 20, 0, 7); ctx.arc(6, -14, 20, 0, 7);
    ctx.fill(); ctx.restore();
  }

  // ---------- 角色：可愛天使（原創） ----------
  // punch: 0~1，左右手揮拳進度；side:'L'|'R'
  function drawAngel(x, y, t, punchL, punchR) {
    ctx.save();
    ctx.translate(x, y);
    const bob = Math.sin(t * 2) * 4;
    ctx.translate(0, bob);

    // 光環
    ctx.strokeStyle = '#ffe27a'; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.ellipse(0, -92, 34, 11, 0, 0, 7); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, -92, 34, 11, 0, 0, 7); ctx.stroke();

    // 翅膀
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    wing(-46, -30, -1); wing(46, -30, 1);

    // 身體（連身裙）
    ctx.fillStyle = '#eaf6ff';
    ctx.beginPath();
    ctx.moveTo(-30, 10); ctx.quadraticCurveTo(-46, 70, -34, 92);
    ctx.lineTo(34, 92); ctx.quadraticCurveTo(46, 70, 30, 10);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#bfe0f5'; ctx.lineWidth = 3; ctx.stroke();

    // 手臂（依揮拳進度往前伸）
    drawArm(-30, 20, -1, punchL);
    drawArm(30, 20, 1, punchR);

    // 頭
    ctx.fillStyle = '#fff4ee';
    ctx.beginPath(); ctx.arc(0, -40, 42, 0, 7); ctx.fill();

    // 後髮
    ctx.fillStyle = '#8fe3e8';
    ctx.beginPath(); ctx.arc(0, -44, 46, Math.PI, 0); ctx.fill();
    // 瀏海
    ctx.beginPath();
    ctx.moveTo(-44, -52);
    ctx.quadraticCurveTo(-20, -92, 0, -78);
    ctx.quadraticCurveTo(20, -92, 44, -52);
    ctx.quadraticCurveTo(20, -64, 0, -60);
    ctx.quadraticCurveTo(-20, -64, -44, -52);
    ctx.fill();
    // 雙馬尾
    ctx.beginPath(); ctx.ellipse(-50, -34, 14, 30, 0.3, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(50, -34, 14, 30, -0.3, 0, 7); ctx.fill();

    // 眼睛
    ctx.fillStyle = '#3a4a6b';
    eye(-16, -40); eye(16, -40);
    // 腮紅
    ctx.fillStyle = 'rgba(255,150,180,.55)';
    ctx.beginPath(); ctx.arc(-24, -28, 8, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(24, -28, 8, 0, 7); ctx.fill();
    // 嘴（>w<）
    ctx.strokeStyle = '#c66'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-7, -24); ctx.quadraticCurveTo(0, -18, 7, -24);
    ctx.stroke();

    ctx.restore();
  }
  function wing(x, y, dir) {
    ctx.save(); ctx.translate(x, y); ctx.scale(dir, 1);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(36, -28, 54, 4);
    ctx.quadraticCurveTo(40, 8, 44, 30);
    ctx.quadraticCurveTo(26, 18, 22, 36);
    ctx.quadraticCurveTo(10, 16, 0, 0);
    ctx.fill(); ctx.restore();
  }
  function drawArm(sx, sy, dir, punch) {
    const reach = 38 * (punch || 0);
    const ex = sx + dir * (8 + reach * 0.4);
    const ey = sy - reach;
    ctx.strokeStyle = '#fff4ee'; ctx.lineWidth = 12; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    // 拳套（粉）
    ctx.fillStyle = '#ff9ec7';
    ctx.beginPath(); ctx.arc(ex, ey, 13, 0, 7); ctx.fill();
    ctx.strokeStyle = '#ff7bb0'; ctx.lineWidth = 2; ctx.stroke();
  }
  function eye(x, y) {
    ctx.beginPath(); ctx.ellipse(x, y, 7, 9, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x - 2, y - 3, 2.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#3a4a6b';
  }

  // ---------- 第一人稱拳套（遊玩視角：只看得到自己的手） ----------
  const FIST_REST = { L: { x: 175, y: 600 }, R: { x: 785, y: 600 } };
  function drawFists(t) {
    // 後出拳的手畫在上層
    if (angel.last === 'L') { drawFist('R', angel.punchR, t); drawFist('L', angel.punchL, t); }
    else { drawFist('L', angel.punchL, t); drawFist('R', angel.punchR, t); }
  }
  function drawFist(side, p, t) {
    const dir = side === 'L' ? -1 : 1;
    const rest = FIST_REST[side];
    const idle = Math.sin(t * 2.2 + (side === 'L' ? 0 : 1.7)) * 7;
    // p=1 為命中瞬間（拳在肉上），p→0 收回；含透視縮小
    const tx = MEAT_X + dir * 34, ty = MEAT_Y + 46;
    const x = lerp(rest.x, tx, p);
    const y = lerp(rest.y + idle, ty, p);
    const s = lerp(1, 0.58, p);

    // 前臂（從畫面外伸進來）
    ctx.strokeStyle = '#fff4ee';
    ctx.lineWidth = 44 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(rest.x + dir * 120, H + 80);
    ctx.lineTo(x, y);
    ctx.stroke();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(dir * lerp(0.12, -0.18, p));
    ctx.scale(s, s);
    // 蓬蓬白袖口
    ctx.fillStyle = '#ffffff';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath(); ctx.arc(i * 18, 44, 17, 0, 7); ctx.fill();
    }
    // 粉色拳套本體
    const g = ctx.createRadialGradient(-14, -16, 8, 0, 0, 58);
    g.addColorStop(0, '#ffc1da'); g.addColorStop(1, '#ff8fbe');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 50, 0, 7); ctx.fill();
    ctx.strokeStyle = '#ff7bb0'; ctx.lineWidth = 4; ctx.stroke();
    // 拇指
    ctx.fillStyle = '#ffb3d2';
    ctx.beginPath(); ctx.ellipse(dir * -38, 14, 16, 22, dir * 0.5, 0, 7); ctx.fill();
    ctx.strokeStyle = '#ff7bb0'; ctx.lineWidth = 3; ctx.stroke();
    // 拳背小翅膀
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.save(); ctx.translate(dir * 30, -34); ctx.scale(dir * 0.55, 0.55);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(36, -28, 54, 4);
    ctx.quadraticCurveTo(40, 8, 44, 30);
    ctx.quadraticCurveTo(26, 18, 22, 36);
    ctx.quadraticCurveTo(10, 16, 0, 0);
    ctx.fill(); ctx.restore();
    // 拳面小星星
    ctx.fillStyle = '#fff0a8';
    star(0, -8, 13, 6, 5); ctx.fill();
    ctx.restore();
  }

  // ---------- 肉塊 ----------
  function drawMeat(x, y, scale, hpRatio, squash, t) {
    ctx.save();
    ctx.translate(x, y);
    const sq = 1 + Math.sin(t * 1.5) * 0.03 - squash * 0.25;
    ctx.scale(scale * (1 + squash * 0.18), scale * sq);

    // 影子
    ctx.fillStyle = 'rgba(0,0,0,.12)';
    ctx.beginPath(); ctx.ellipse(0, 70, 70, 16, 0, 0, 7); ctx.fill();

    // 骨頭
    ctx.strokeStyle = '#f6efe4'; ctx.lineWidth = 16; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-60, 40); ctx.lineTo(-30, 18); ctx.stroke();
    ctx.fillStyle = '#f6efe4';
    ctx.beginPath(); ctx.arc(-66, 44, 11, 0, 7); ctx.arc(-58, 52, 11, 0, 7); ctx.fill();

    // 肉本體（火腿粉）
    const g = ctx.createRadialGradient(-10, -20, 10, 0, 0, 80);
    g.addColorStop(0, '#ff9bb0'); g.addColorStop(1, '#f4607f');
    ctx.fillStyle = g;
    roundedBlob(0, 0, 70, 56);
    ctx.fill();
    // 肥肉邊
    ctx.strokeStyle = '#ffe3d6'; ctx.lineWidth = 9;
    roundedBlob(0, 0, 70, 56); ctx.stroke();

    // 表情（依血量變化：高血量笑、低血量哭）
    ctx.fillStyle = '#5a2a33';
    if (hpRatio > 0.35) {
      eyeDot(-22, -8); eyeDot(22, -8);
      ctx.strokeStyle = '#5a2a33'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(0, 6, 16, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    } else {
      // ＞＜ 哭臉
      ctx.strokeStyle = '#5a2a33'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-30,-14); ctx.lineTo(-14,-6); ctx.moveTo(-30,-2); ctx.lineTo(-14,-10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(30,-14); ctx.lineTo(14,-6); ctx.moveTo(30,-2); ctx.lineTo(14,-10); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 24, 12, Math.PI, 0); ctx.stroke();
      ctx.fillStyle = '#7fd4ff'; // 淚
      ctx.beginPath(); ctx.ellipse(-26, 6, 4, 7, 0, 0, 7); ctx.fill();
    }
    ctx.restore();
  }
  function roundedBlob(cx, cy, rx, ry) {
    ctx.beginPath();
    ctx.moveTo(cx - rx, cy);
    ctx.quadraticCurveTo(cx - rx, cy - ry, cx, cy - ry);
    ctx.quadraticCurveTo(cx + rx, cy - ry, cx + rx, cy);
    ctx.quadraticCurveTo(cx + rx, cy + ry, cx, cy + ry);
    ctx.quadraticCurveTo(cx - rx, cy + ry, cx - rx, cy);
    ctx.closePath();
  }
  function eyeDot(x, y) {
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
  }

  // ---------- HUD 與 UI ----------
  function drawTextBox(x, y, label, value, align) {
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'top';
    ctx.font = '700 16px "Microsoft JhengHei", sans-serif';
    ctx.fillStyle = 'rgba(40,60,90,.7)';
    ctx.fillText(label, x, y);
    ctx.font = '900 30px "Microsoft JhengHei", sans-serif';
    ctx.fillStyle = '#2a3b5c';
    ctx.fillText(value, x, y + 18);
  }
  function drawHUD() {
    drawTextBox(24, 18, '分數', String(G.score | 0), 'left');
    drawTextBox(W - 24, 18, '關卡', `${G.levelIndex + 1} / ${LEVELS.length}`, 'right');
  }
  // 簡易按鈕（Canvas 命中測試）
  const buttons = [];
  function button(x, y, w, h, label, onClick) {
    buttons.push({ x, y, w, h, label, onClick });
  }
  function drawButtons(t) {
    for (const b of buttons) {
      const hover = pointer.x >= b.x && pointer.x <= b.x + b.w && pointer.y >= b.y && pointer.y <= b.y + b.h;
      ctx.fillStyle = hover ? '#ff7bb0' : '#ff9ec7';
      roundRect(b.x, b.y, b.w, b.h, 16); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.12)';
      roundRect(b.x, b.y + b.h - 6, b.w, 6, 16); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 26px "Microsoft JhengHei", sans-serif';
      ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 - 2 + (hover ? 1 : 0));
    }
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // 指標座標（換算到 960x600 邏輯座標）
  const pointer = { x: -1, y: -1, clicked: false };
  function toLogical(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width * W, y: (clientY - r.top) / r.height * H };
  }
  canvas.addEventListener('mousemove', (e) => {
    const p = toLogical(e.clientX, e.clientY); pointer.x = p.x; pointer.y = p.y;
  });
  canvas.addEventListener('click', (e) => {
    const p = toLogical(e.clientX, e.clientY);
    for (const b of buttons) {
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) { b.onClick(); break; }
    }
  });

  // ===========================================================
  //  遊戲狀態 + 場景管理
  // ===========================================================
  const G = {
    score: 0,
    levelIndex: 0,
    high: Number(localStorage.getItem('kanata_high') || 0),
  };

  let scene = null;
  function setScene(s) {
    buttons.length = 0;
    Input.clear();
    scene = s;
    if (scene.enter) scene.enter();
  }

  // 角色揮拳動畫狀態（跨場景共用）
  const angel = { punchL: 0, punchR: 0, last: 'R' };
  function doPunch(hand) {
    if (hand === 'L') angel.punchL = 1; else angel.punchR = 1;
    angel.last = hand;
  }
  function updateAngel(dt) {
    angel.punchL = Math.max(0, angel.punchL - dt * 6);
    angel.punchR = Math.max(0, angel.punchR - dt * 6);
  }
  const MEAT_X = 480, MEAT_Y = 290;
  function hitMeatFx(crit) {
    burst(MEAT_X, MEAT_Y, crit ? '#ffd86b' : '#ff8fc7', crit ? 22 : 12);
    shake(crit ? 14 : 7);
    Audio.punch();
  }

  // ---------- QTE 控制器（隨機事件） ----------
  const QTE_KEYS = [
    { code: 'ArrowLeft', label: '←' }, { code: 'ArrowRight', label: '→' },
    { code: 'ArrowUp', label: '↑' }, { code: 'ArrowDown', label: '↓' },
    { code: 'Space', label: '空白' }, { code: 'KeyF', label: 'F' }, { code: 'KeyJ', label: 'J' },
  ];
  const QTE = {
    active: false, key: null, time: 0, dur: 1.3, onDone: null,
    start(onDone) {
      this.active = true; this.key = choice(QTE_KEYS);
      this.time = this.dur; this.onDone = onDone;
      Input.consumeKeys();
      Audio.qte();
    },
    update(dt) {
      if (!this.active) return;
      this.time -= dt;
      for (const k of Input.consumeKeys()) {
        if (k.code === this.key.code) return this.finish(true);
        else return this.finish(false); // 按錯也算失敗
      }
      if (this.time <= 0) this.finish(false);
    },
    finish(ok) {
      this.active = false;
      if (ok) {
        const bonus = 300;
        G.score += bonus;
        pop(MEAT_X, MEAT_Y - 80, 'QTE 成功!', '#ffd24a', 46);
        hitMeatFx(true); hitMeatFx(true);
      } else {
        pop(MEAT_X, MEAT_Y - 80, 'QTE 失敗…', '#7aa7ff', 40);
        Audio.miss();
      }
      if (this.onDone) this.onDone(ok);
    },
    draw() {
      if (!this.active) return;
      ctx.fillStyle = 'rgba(20,30,55,.45)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff'; ctx.font = '900 40px "Microsoft JhengHei", sans-serif';
      ctx.fillText('QTE！快按', W / 2, H / 2 - 90);
      // 按鍵框
      ctx.fillStyle = '#ffd24a';
      roundRect(W / 2 - 70, H / 2 - 50, 140, 100, 18); ctx.fill();
      ctx.fillStyle = '#2a3b5c'; ctx.font = '900 60px "Microsoft JhengHei", sans-serif';
      ctx.fillText(this.key.label, W / 2, H / 2 + 2);
      // 時間條
      const r = clamp(this.time / this.dur, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,.3)';
      roundRect(W / 2 - 150, H / 2 + 80, 300, 16, 8); ctx.fill();
      ctx.fillStyle = r > 0.4 ? '#7CFFB0' : '#ff7b7b';
      roundRect(W / 2 - 150, H / 2 + 80, 300 * r, 16, 8); ctx.fill();
    }
  };

  // ===========================================================
  //  場景：標題
  // ===========================================================
  const TitleScene = {
    t: 0,
    enter() {
      this.t = 0;
      button(W / 2 - 110, 430, 220, 70, '開打！', () => {
        Audio.init();
        G.score = 0; G.levelIndex = 0;
        setScene(LEVELS[0]());
      });
    },
    update(dt) { this.t += dt; },
    render() {
      drawBackground(this.t);
      drawAngel(W / 2, 270, this.t, Math.abs(Math.sin(this.t*3))*0.5, Math.abs(Math.cos(this.t*3))*0.5);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 64px "Microsoft JhengHei", sans-serif';
      ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.strokeText('天音彼方 打肉！', W / 2, 90);
      ctx.fillStyle = '#ff6fa5';
      ctx.fillText('天音彼方 打肉！', W / 2, 90);
      ctx.font = '700 20px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = '#3a4a6b';
      ctx.fillText('F / 左鍵 = 左手　　J / 右鍵 = 右手', W / 2, 150);
      ctx.fillText(`最高分：${G.high}`, W / 2, 390);
    }
  };

  // ===========================================================
  //  第1關：連打地獄（在限時內把肉打到 0）
  // ===========================================================
  function Level1() {
    return {
      name: '連打地獄', t: 0, time: 18, hp: 100, maxhp: 100,
      squash: 0, qteFired: false, done: false, hits: 0, combo: 0,
      enter() { pop(MEAT_X, MEAT_Y - 120, 'STAGE 1\n連打！', '#fff', 38); },
      update(dt) {
        this.t += dt;
        if (QTE.active) { QTE.update(dt); return; }
        this.time -= dt;
        this.squash = Math.max(0, this.squash - dt * 5);

        // 隨機觸發一次 QTE（剩約一半血時）
        if (!this.qteFired && this.hp < 60) {
          this.qteFired = true;
          QTE.start(() => {});
          return;
        }

        for (const h of Input.consumeHits()) {
          if (this.hp <= 0) break;
          doPunch(h.hand);
          // 左右交替加成
          const alt = h.hand !== this._prevHand;
          this._prevHand = h.hand;
          const dmg = alt ? 3.2 : 2.2;
          this.combo++;
          this.hp = Math.max(0, this.hp - dmg);
          G.score += alt ? 15 : 10;
          this.squash = 1; this.hits++;
          hitMeatFx(alt && this.combo % 8 === 0);
          if (this.combo % 10 === 0) pop(MEAT_X + rand(-30,30), MEAT_Y - 60, choice(['ドゴォ！','バキ！','ズドン！']), '#fff', 40);
        }

        if (this.hp <= 0 && !this.done) { this.finish(true); }
        else if (this.time <= 0 && !this.done) { this.finish(false); }
      },
      finish(cleared) {
        this.done = true;
        if (cleared) { G.score += 500 + Math.ceil(this.time) * 30; pop(MEAT_X, MEAT_Y - 80, 'KO！', '#ffd24a', 60); Audio.clear(); }
        else pop(MEAT_X, MEAT_Y - 80, '時間到', '#7aa7ff', 44);
        shake(16);
        setTimeout(() => nextLevel(), 1100);
      },
      render() {
        drawBackground(this.t);
        drawHUD();
        // 計時條
        bar(W/2 - 200, 24, 400, 18, this.time / 18, '#ffd24a');
        ctx.textAlign='center'; ctx.font='700 14px "Microsoft JhengHei"'; ctx.fillStyle='#2a3b5c';
        ctx.fillText('STAGE 1 · 連打地獄', W/2, 56);
        drawMeat(MEAT_X, MEAT_Y, 1.55, this.hp / this.maxhp, this.squash, this.t);
        // 肉的血條
        bar(MEAT_X - 100, MEAT_Y - 155, 200, 16, this.hp / this.maxhp, '#ff5d7a');
        drawFists(this.t);
        QTE.draw();
      }
    };
  }

  // ===========================================================
  //  第2關：連擊不斷（節拍窗口內命中累積 Combo）
  // ===========================================================
  function Level2() {
    return {
      name: '連擊不斷', t: 0, beatT: 0, period: 0.62, ring: 0,
      combo: 0, maxCombo: 0, hits: 0, totalBeats: 28, beatCount: 0,
      qteFired: false, done: false, windowOpen: false, squash: 0,
      enter() { pop(MEAT_X, MEAT_Y - 120, 'STAGE 2\n連擊！', '#fff', 38); },
      update(dt) {
        this.t += dt;
        if (QTE.active) { QTE.update(dt); return; }
        this.beatT += dt;
        this.squash = Math.max(0, this.squash - dt * 5);
        // 收縮環：0→1 一個週期，1 時為命中點
        this.ring = (this.beatT % this.period) / this.period;

        // 命中判定：ring 接近 1（或剛過 0）為最佳窗
        for (const h of Input.consumeHits()) {
          doPunch(h.hand);
          const phase = this.ring;
          const closeness = Math.min(phase, 1 - phase); // 距離節拍點
          if (closeness < 0.10) {
            this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo);
            const perfect = closeness < 0.045;
            G.score += perfect ? 60 : 35;
            pop(MEAT_X, MEAT_Y - 70, perfect ? 'PERFECT' : 'GOOD', perfect ? '#ffd24a' : '#7CFFB0', perfect ? 44 : 36);
            this.squash = 1; hitMeatFx(perfect); perfect ? Audio.perfect() : Audio.good();
          } else {
            if (this.combo > 0) pop(MEAT_X, MEAT_Y - 70, 'MISS', '#ff7b7b', 36);
            this.combo = 0; Audio.miss();
          }
        }

        // 數拍
        if (this.beatT >= this.period) {
          this.beatT -= this.period; this.beatCount++;
          if (!this.qteFired && this.beatCount === 14) { this.qteFired = true; QTE.start(() => {}); return; }
          if (this.beatCount >= this.totalBeats && !this.done) this.finish();
        }
      },
      finish() {
        this.done = true;
        G.score += this.maxCombo * 20;
        pop(MEAT_X, MEAT_Y - 80, `最高連擊 ${this.maxCombo}`, '#ffd24a', 40);
        Audio.clear(); shake(12);
        setTimeout(() => nextLevel(), 1200);
      },
      render() {
        drawBackground(this.t);
        drawHUD();
        ctx.textAlign='center'; ctx.font='700 14px "Microsoft JhengHei"'; ctx.fillStyle='#2a3b5c';
        ctx.fillText(`STAGE 2 · 連擊不斷　Combo ${this.combo}`, W/2, 40);
        drawMeat(MEAT_X, MEAT_Y, 1.45, 0.6, this.squash, this.t);
        // 收縮環指示（環縮到內圈白點時按）
        const rMax = 130, r = lerp(rMax, 36, this.ring);
        ctx.strokeStyle = this.ring > 0.9 || this.ring < 0.1 ? '#ffd24a' : 'rgba(255,255,255,.8)';
        ctx.lineWidth = 6;
        ctx.beginPath(); ctx.arc(MEAT_X, MEAT_Y, r, 0, 7); ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(MEAT_X, MEAT_Y, 36, 0, 7); ctx.stroke();
        drawFists(this.t);
        QTE.draw();
      }
    };
  }

  // ===========================================================
  //  第3關：節奏打肉（音符落下，F=左 J=右 踩拍命中）
  // ===========================================================
  function Level3() {
    const laneX = { L: 330, R: 630 };
    return {
      name: '節奏打肉', t: 0, notes: [], spawnT: 0, idx: 0, done: false, squash: 0,
      chart: null, hitLineY: 470, judged: 0, totalNotes: 0,
      perfect: 0, good: 0, miss: 0,
      enter() {
        pop(MEAT_X, MEAT_Y - 120, 'STAGE 3\n節奏！', '#fff', 38);
        // 產生簡單譜面：時間(秒) + lane
        const ch = []; let tt = 1.2;
        const pat = ['L','R','L','R','LR','L','R','RL','L','R','L','R','LR','R','L','R','L','R','LR','L'];
        for (const p of pat) {
          if (p === 'LR' || p === 'RL') { ch.push({ t: tt, lane: 'L' }); ch.push({ t: tt, lane: 'R' }); }
          else ch.push({ t: tt, lane: p });
          tt += rand(0.42, 0.6);
        }
        this.chart = ch; this.totalNotes = ch.length; this.endT = tt + 1.5;
      },
      update(dt) {
        this.t += dt;
        this.squash = Math.max(0, this.squash - dt * 5);
        const fallTime = 1.6, speed = (this.hitLineY - 80) / fallTime;
        // 生出音符
        while (this.idx < this.chart.length && this.t >= this.chart[this.idx].t - fallTime) {
          const c = this.chart[this.idx++];
          this.notes.push({ lane: c.lane, y: 80, hit: false, dead: false });
        }
        for (const n of this.notes) if (!n.hit) n.y += speed * dt;

        // 鍵盤判定：F=L, J=R
        for (const k of Input.consumeKeys()) {
          let lane = null;
          if (k.code === 'KeyF') lane = 'L'; else if (k.code === 'KeyJ') lane = 'R';
          if (!lane) continue;
          doPunch(lane);
          // 找該 lane 最接近判定線、未命中的音符
          let best = null, bestd = 1e9;
          for (const n of this.notes) {
            if (n.hit || n.dead || n.lane !== lane) continue;
            const d = Math.abs(n.y - this.hitLineY);
            if (d < bestd) { bestd = d; best = n; }
          }
          if (best && bestd < 60) {
            best.hit = true; this.judged++;
            const perfect = bestd < 24;
            if (perfect) { this.perfect++; G.score += 100; pop(laneX[lane], this.hitLineY - 40, 'PERFECT', '#ffd24a', 34); Audio.perfect(); }
            else { this.good++; G.score += 50; pop(laneX[lane], this.hitLineY - 40, 'GOOD', '#7CFFB0', 30); Audio.good(); }
            this.squash = 1; hitMeatFx(perfect);
          } else {
            Audio.miss();
          }
        }

        // 漏接判定
        for (const n of this.notes) {
          if (!n.hit && !n.dead && n.y > this.hitLineY + 60) { n.dead = true; this.miss++; this.judged++; pop(laneX[n.lane], this.hitLineY, 'MISS', '#ff7b7b', 30); }
        }
        this.notes = this.notes.filter(n => n.y < H + 40 && !(n.hit && n.y > this.hitLineY));

        if (this.t >= this.endT && !this.done) this.finish();
      },
      finish() {
        this.done = true;
        G.score += this.perfect * 30;
        pop(MEAT_X, MEAT_Y - 80, `P${this.perfect} G${this.good} M${this.miss}`, '#ffd24a', 36);
        Audio.clear(); shake(12);
        setTimeout(() => nextLevel(), 1300);
      },
      render() {
        drawBackground(this.t);
        drawHUD();
        ctx.textAlign='center'; ctx.font='700 14px "Microsoft JhengHei"'; ctx.fillStyle='#2a3b5c';
        ctx.fillText('STAGE 3 · 節奏打肉　F=左　J=右', W/2, 40);
        // 軌道
        for (const lane of ['L','R']) {
          const x = laneX[lane];
          ctx.fillStyle = 'rgba(255,255,255,.35)';
          roundRect(x - 34, 60, 68, this.hitLineY - 60 + 40, 12); ctx.fill();
          ctx.fillStyle = 'rgba(40,60,90,.5)';
          ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.font='900 22px "Microsoft JhengHei"';
          ctx.fillText(lane === 'L' ? 'F' : 'J', x, this.hitLineY + 24);
        }
        // 判定線
        ctx.strokeStyle = '#ff6fa5'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(laneX.L - 40, this.hitLineY); ctx.lineTo(laneX.L + 40, this.hitLineY);
        ctx.moveTo(laneX.R - 40, this.hitLineY); ctx.lineTo(laneX.R + 40, this.hitLineY); ctx.stroke();
        // 音符
        for (const n of this.notes) {
          if (n.hit) continue;
          const x = laneX[n.lane];
          ctx.fillStyle = n.lane === 'L' ? '#7CCBFF' : '#ff9ec7';
          ctx.beginPath(); ctx.arc(x, n.y, 22, 0, 7); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
        }
        drawMeat(MEAT_X, MEAT_Y - 60, 1.0, 0.6, this.squash, this.t);
        drawFists(this.t);
      }
    };
  }

  const LEVELS = [Level1, Level2, Level3];
  function nextLevel() {
    G.levelIndex++;
    if (G.levelIndex < LEVELS.length) setScene(LEVELS[G.levelIndex]());
    else setScene(ResultScene);
  }

  // ===========================================================
  //  結算
  // ===========================================================
  const ResultScene = {
    t: 0, rank: 'C', isNewHigh: false,
    enter() {
      this.t = 0;
      this.isNewHigh = G.score > G.high;
      if (this.isNewHigh) { G.high = G.score | 0; localStorage.setItem('kanata_high', String(G.high)); }
      const s = G.score;
      this.rank = s >= 6000 ? 'S' : s >= 4000 ? 'A' : s >= 2200 ? 'B' : 'C';
      burst(W/2, 220, '#ffd24a', 40);
      button(W / 2 - 110, 460, 220, 64, '再來一次', () => { G.score = 0; G.levelIndex = 0; setScene(LEVELS[0]()); });
      Audio.clear();
    },
    update(dt) { this.t += dt; },
    render() {
      drawBackground(this.t);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 54px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = '#ff6fa5'; ctx.fillText('結算', W / 2, 90);
      // 評價
      const rc = { S: '#ffd24a', A: '#7CFFB0', B: '#7CCBFF', C: '#c9c9c9' }[this.rank];
      ctx.font = '900 130px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = rc;
      ctx.fillText(this.rank, W / 2, 230);
      ctx.font = '900 40px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = '#2a3b5c';
      ctx.fillText(`總分 ${G.score | 0}`, W / 2, 340);
      ctx.font = '700 22px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = this.isNewHigh ? '#ff6fa5' : '#3a4a6b';
      ctx.fillText(this.isNewHigh ? '★ 新紀錄！ ★' : `最高分 ${G.high}`, W / 2, 400);
      drawAngel(150, 420, this.t, Math.abs(Math.sin(this.t*4))*0.6, Math.abs(Math.cos(this.t*4))*0.6);
    }
  };

  function bar(x, y, w, h, ratio, color) {
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    roundRect(x, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = color;
    roundRect(x, y, w * clamp(ratio, 0, 1), h, h / 2); ctx.fill();
  }

  // ===========================================================
  //  主迴圈
  // ===========================================================
  let lastT = now();
  function frame() {
    const t = now();
    let dt = (t - lastT) / 1000; lastT = t;
    dt = Math.min(dt, 0.05); // 防分頁切回時 dt 爆衝

    if (!paused) {
      if (scene && scene.update) scene.update(dt);
      updateAngel(dt);
      updateParticles(dt);
      updatePops(dt);
      if (shakeT > 0) shakeT -= dt;
    }

    // 渲染
    ctx.save();
    if (shakeT > 0) {
      const m = shakeMag * (shakeT / 0.18);
      ctx.translate(rand(-m, m), rand(-m, m));
    }
    if (scene && scene.render) scene.render();
    drawParticles();
    drawPops();
    drawButtons(t / 1000);
    ctx.restore();

    if (paused) {
      ctx.fillStyle = 'rgba(20,30,55,.55)'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 40px "Microsoft JhengHei", sans-serif';
      ctx.fillText('暫停中（切回分頁繼續）', W / 2, H / 2);
    }

    requestAnimationFrame(frame);
  }

  setScene(TitleScene);
  requestAnimationFrame(frame);
})();
