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
  function loadOptionalImage(src) {
    const img = new Image();
    img.src = src;
    return img;
  }
  const EndingImages = {
    win: loadOptionalImage('images/kanata-ending-win.png'),
    lose: loadOptionalImage('images/kanata-ending-lose.png'),
  };
  function drawEndingImage(key, cx, bottomY, maxW, maxH) {
    const img = EndingImages[key];
    if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return false;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, cx - w / 2, bottomY - h, w, h);
    return true;
  }

  // ---------- 音效（WebAudio 合成，無音檔） ----------
  const Audio = {
    ctx: null,
    master: null,
    muted: localStorage.getItem('kanata_mute') === '1',
    volume: 0.8, // 合成音偏尖，總線先壓 20%
    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    },
    toggleMute() {
      this.muted = !this.muted;
      localStorage.setItem('kanata_mute', this.muted ? '1' : '0');
      if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
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
      osc.connect(g).connect(this.master);
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
      src.connect(g).connect(this.master);
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
    taps: [],          // 觸點佇列（邏輯座標，給觸控 QTE 圓靶用）：{x,y}
    down: new Set(),
    consumeHits() { const h = this.hits; this.hits = []; return h; },
    consumeKeys() { const k = this.keyEvents; this.keyEvents = []; return k; },
    consumeTaps() { const t = this.taps; this.taps = []; return t; },
    clear() { this.hits = []; this.keyEvents = []; this.taps = []; },
  };

  // 觸控模式：決定 QTE 題型與引導 UI（初值猜裝置，之後跟著實際輸入走）
  let touchMode = matchMedia('(pointer: coarse)').matches;

  window.addEventListener('keydown', (e) => {
    if (PREVENT_KEYS.has(e.code)) e.preventDefault();   // 防空白鍵 / 方向鍵捲動
    if (e.repeat) return;                                // 不吃長按連發
    Audio.init();                                        // 鍵盤開局也要解鎖 WebAudio
    touchMode = false;
    if (e.code === 'KeyM') { Audio.toggleMute(); return; } // 靜音鍵不進輸入佇列（避免誤觸 QTE）
    Input.down.add(e.code);
    Input.keyEvents.push({ code: e.code });
    if (HIT_KEYS[e.code]) Input.hits.push({ hand: HIT_KEYS[e.code] });
  }, { passive: false });

  window.addEventListener('keyup', (e) => { Input.down.delete(e.code); });

  // 滑鼠：左鍵=左手，右鍵=右手
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    Audio.init();
    const p = toLogical(e.clientX, e.clientY);
    if (iconAt(p.x, p.y)) return; // 點常駐圖示不算出拳（click 會處理切換）
    if (e.button === 0) Input.hits.push({ hand: 'L' });
    else if (e.button === 2) Input.hits.push({ hand: 'R' });
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // 右鍵當右手，禁選單

  // 觸控：左半=左手，右半=右手（節奏關同時餵 F/J 當左右軌）
  // preventDefault 會擋掉合成 click，按鈕命中要在這裡自己做
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    Audio.init();
    touchMode = true;
    for (const t of e.changedTouches) {
      const p = toLogical(t.clientX, t.clientY);
      const ic = iconAt(p.x, p.y);
      if (ic) { ic.onClick(); continue; } // 常駐圖示（喇叭等）
      const pad = 10; // 手指沒滑鼠準，命中範圍外擴
      const b = buttons.find(b =>
        p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad);
      if (b) { b.onClick(); continue; }   // 點到按鈕就不當出拳
      const hand = p.x < W / 2 ? 'L' : 'R';
      Input.hits.push({ hand });
      Input.keyEvents.push({ code: hand === 'L' ? 'KeyF' : 'KeyJ' });
      Input.taps.push(p);
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

  // Emoji 粒子（QTE 成功時 💪 飄揚）
  const emojiFx = [];
  function emojiBurst(char, n) {
    for (let i = 0; i < (n || 16); i++) {
      const life = rand(1.1, 1.9);
      emojiFx.push({
        char, x: rand(80, W - 80), y: rand(H * 0.5, H + 30),
        vy: rand(110, 230), sway: rand(18, 46), ph: rand(0, Math.PI * 2),
        rot: rand(-0.4, 0.4), size: rand(26, 54), life, max: life,
      });
    }
  }
  function updateEmojiFx(dt) {
    for (let i = emojiFx.length - 1; i >= 0; i--) {
      const e = emojiFx[i];
      e.life -= dt; if (e.life <= 0) { emojiFx.splice(i, 1); continue; }
      e.y -= e.vy * dt; e.ph += dt * 3;
    }
  }
  function drawEmojiFx() {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const e of emojiFx) {
      ctx.save();
      ctx.globalAlpha = clamp(e.life / e.max * 1.6, 0, 1);
      ctx.translate(e.x + Math.sin(e.ph) * e.sway, e.y);
      ctx.rotate(e.rot + Math.sin(e.ph * 0.8) * 0.15);
      ctx.font = `${e.size}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
      ctx.fillText(e.char, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // 螢幕震動
  let shakeT = 0, shakeMag = 0;
  function shake(mag) { shakeT = 0.18; shakeMag = mag || 8; }

  // ---------- 全域色票（V1：淺水藍×白×金光環×粉的天空色系） ----------
  const PAL = {
    sky: '#a6d8ff',   // 主天空藍＝角色髮色同源
    halo: '#ffe27a',  // 金光環
    pink: '#ff6fa5',  // 主粉
    ink: '#2a3b5c',   // 標準墨色（白晝用）
  };

  // ---------- 背景（V4：三關分層 day 雲海 / dusk 霞光 / night 星空） ----------
  const BG_THEMES = {
    day: {
      stops: [PAL.sky, '#cfeeff', '#ffe9f3'], cloud: 'rgba(255,255,255,.85)',
      ground: '#bfe9c8', ink: PAL.ink, inkSoft: 'rgba(40,60,90,.7)',
    },
    dusk: {
      stops: ['#b393d9', '#ffb997', '#ffe3c9'], cloud: 'rgba(255,236,214,.85)',
      ground: '#a8c9a0', ink: '#4a3558', inkSoft: 'rgba(74,53,88,.75)',
    },
    night: {
      stops: ['#1c2a52', '#31447a', '#4a5a94'], cloud: 'rgba(255,255,255,.10)',
      ground: '#3a5068', ink: '#e7eeff', inkSoft: 'rgba(231,238,255,.75)',
    },
  };
  const STAGE_THEMES = ['day', 'dusk', 'night'];
  let bgTheme = 'day';
  function ink() { return BG_THEMES[bgTheme].ink; }
  function inkSoft() { return BG_THEMES[bgTheme].inkSoft; }
  function drawBackground(t, theme) {
    bgTheme = theme || 'day';
    const th = BG_THEMES[bgTheme];
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, th.stops[0]);
    g.addColorStop(0.55, th.stops[1]);
    g.addColorStop(1, th.stops[2]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (bgTheme === 'night') drawStars(t);
    if (bgTheme === 'dusk') { // 低垂的落日
      ctx.fillStyle = 'rgba(255,214,140,.25)';
      ctx.beginPath(); ctx.arc(W * 0.78, H - 150, 78, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,214,140,.9)';
      ctx.beginPath(); ctx.arc(W * 0.78, H - 150, 46, 0, 7); ctx.fill();
    }
    // 雲
    ctx.fillStyle = th.cloud;
    for (let i = 0; i < 4; i++) {
      const cx = ((t * 14 + i * 280) % (W + 240)) - 120;
      const cy = 70 + i * 30 + Math.sin(t + i) * 6;
      cloud(cx, cy, 1 - i * 0.12);
    }
    // 地面
    ctx.fillStyle = th.ground;
    ctx.beginPath();
    ctx.moveTo(0, H); ctx.lineTo(0, H - 90);
    ctx.quadraticCurveTo(W / 2, H - 130, W, H - 90); ctx.lineTo(W, H);
    ctx.closePath(); ctx.fill();
  }
  function drawStars(t) {
    // 黃金角散布的定點星星（不用亂數，避免每幀閃跳）
    for (let i = 0; i < 70; i++) {
      const x = (i * 137.5) % W;
      const y = (i * 91.7) % (H - 220);
      ctx.globalAlpha = 0.55 + Math.sin(t * 2 + i * 1.7) * 0.45;
      ctx.fillStyle = i % 9 === 0 ? PAL.halo : '#ffffff';
      if (i % 13 === 0) { star(x, y, 5, 2.2, 4); ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(x, y, i % 3 === 0 ? 1.6 : 1.1, 0, 7); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
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
    ctx.fillStyle = PAL.sky; // 髮色＝天空藍（V1）
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

  // ---------- 結算演出：勝利 / 敗北 ----------
  function drawAngelVictory(x, y, t) {
    ctx.save();
    ctx.translate(x, y - Math.abs(Math.sin(t * 5)) * 10); // 開心彈跳

    // 光環
    ctx.strokeStyle = '#ffe27a'; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.ellipse(0, -92, 34, 11, 0, 0, 7); ctx.stroke();
    // 翅膀
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    wing(-46, -30, -1); wing(46, -30, 1);
    // 身體
    ctx.fillStyle = '#eaf6ff';
    ctx.beginPath();
    ctx.moveTo(-30, 10); ctx.quadraticCurveTo(-46, 70, -34, 92);
    ctx.lineTo(34, 92); ctx.quadraticCurveTo(46, 70, 30, 10);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#bfe0f5'; ctx.lineWidth = 3; ctx.stroke();
    // 左手垂下、右手高舉（拳擊勝利！）
    drawArm(-30, 20, -1, 0);
    ctx.strokeStyle = '#fff4ee'; ctx.lineWidth = 12; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(30, 20); ctx.lineTo(48, -100); ctx.stroke();
    ctx.fillStyle = '#ff9ec7';
    ctx.beginPath(); ctx.arc(50, -110, 15, 0, 7); ctx.fill();
    ctx.strokeStyle = '#ff7bb0'; ctx.lineWidth = 2; ctx.stroke();
    // 舉拳閃光
    ctx.fillStyle = '#fff0a8';
    star(50, -138, 10 + Math.sin(t * 8) * 3, 4.5, 5); ctx.fill();

    // 頭
    ctx.fillStyle = '#fff4ee';
    ctx.beginPath(); ctx.arc(0, -40, 42, 0, 7); ctx.fill();
    // 後髮 + 瀏海 + 雙馬尾
    ctx.fillStyle = PAL.sky; // 髮色＝天空藍（V1）
    ctx.beginPath(); ctx.arc(0, -44, 46, Math.PI, 0); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-44, -52);
    ctx.quadraticCurveTo(-20, -92, 0, -78);
    ctx.quadraticCurveTo(20, -92, 44, -52);
    ctx.quadraticCurveTo(20, -64, 0, -60);
    ctx.quadraticCurveTo(-20, -64, -44, -52);
    ctx.fill();
    ctx.beginPath(); ctx.ellipse(-50, -34, 14, 30, 0.3, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(50, -34, 14, 30, -0.3, 0, 7); ctx.fill();
    // 笑瞇眼（∪∪）
    ctx.strokeStyle = '#3a4a6b'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(-16, -42, 8, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(16, -42, 8, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
    // 腮紅
    ctx.fillStyle = 'rgba(255,150,180,.55)';
    ctx.beginPath(); ctx.arc(-24, -28, 8, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(24, -28, 8, 0, 7); ctx.fill();
    // 大開口笑
    ctx.fillStyle = '#c66';
    ctx.beginPath(); ctx.arc(0, -20, 9, 0, Math.PI); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // 被捏爆冒煙的握力器（60KG）
  function drawGripper(x, y, t) {
    ctx.save(); ctx.translate(x, y);
    // 煙
    for (let i = 0; i < 3; i++) {
      const ph = ((t * 0.45) + i / 3) % 1;
      ctx.globalAlpha = (1 - ph) * 0.5;
      ctx.fillStyle = '#aab4c2';
      ctx.beginPath();
      ctx.arc(Math.sin((ph + i) * 6) * 10, -58 - ph * 70, 10 + ph * 16, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // 左右握把（斷開歪斜）
    gripHandle(-18, 2, -0.45);
    gripHandle(20, 4, 0.5);
    // 斷裂的彈簧鋸齒
    ctx.strokeStyle = '#9aa6b8'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-14, -30); ctx.lineTo(-6, -42); ctx.lineTo(-12, -50); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(16, -28); ctx.lineTo(8, -40); ctx.lineTo(14, -48); ctx.stroke();
    // 爆裂星
    ctx.fillStyle = '#ffd24a';
    star(1, -46, 14 + Math.sin(t * 10) * 2, 6, 5); ctx.fill();
    // 60KG 牌
    ctx.fillStyle = '#fff';
    roundRect(-36, 30, 72, 28, 8); ctx.fill();
    ctx.strokeStyle = '#9aa6b8'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#e04a6a';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '900 20px "Microsoft JhengHei", sans-serif';
    ctx.fillText('60KG', 0, 45);
    ctx.restore();
  }
  function gripHandle(hx, hy, rot) {
    ctx.save(); ctx.translate(hx, hy); ctx.rotate(rot);
    ctx.fillStyle = '#5b80c2';
    roundRect(-9, -28, 18, 56, 9); ctx.fill();
    ctx.strokeStyle = '#41639e'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }

  // 跪趴在地哭（嘴裡 murmur「ガッキー...」）
  function drawAngelDefeat(x, y, t) {
    ctx.save(); ctx.translate(x, y); // y = 地面線
    // 影子
    ctx.fillStyle = 'rgba(0,0,0,.10)';
    ctx.beginPath(); ctx.ellipse(-10, 10, 115, 18, 0, 0, 7); ctx.fill();
    // 掉在地上的光環
    ctx.strokeStyle = '#e0cd86'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.ellipse(-122, 6, 26, 8, 0, 0, 7); ctx.stroke();
    // 下垂的翅膀
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.save(); ctx.translate(34, -50); ctx.rotate(0.95); ctx.scale(0.8, 0.8);
    wing(0, 0, 1); ctx.restore();
    // 跪坐的腿
    ctx.fillStyle = '#eaf6ff';
    ctx.beginPath(); ctx.ellipse(48, -26, 34, 30, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#bfe0f5'; ctx.lineWidth = 3; ctx.stroke();
    // 前傾趴下的身體
    ctx.beginPath();
    ctx.moveTo(52, -46);
    ctx.quadraticCurveTo(0, -58, -34, -32);
    ctx.lineTo(-26, -6);
    ctx.quadraticCurveTo(10, -16, 54, -8);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // 雙手撐地
    ctx.strokeStyle = '#fff4ee'; ctx.lineWidth = 10; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-30, -26); ctx.lineTo(-52, 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-20, -22); ctx.lineTo(-32, 4); ctx.stroke();
    // 低垂的頭（肩膀微抖）
    const sob = Math.sin(t * 9) * 1.6;
    ctx.fillStyle = '#fff4ee';
    ctx.beginPath(); ctx.arc(-64, -28 + sob, 30, 0, 7); ctx.fill();
    // 髮
    ctx.fillStyle = PAL.sky; // 髮色＝天空藍（V1）
    ctx.beginPath(); ctx.arc(-64, -32 + sob, 33, Math.PI * 0.85, Math.PI * 2.1); ctx.fill();
    // 馬尾散落在地
    ctx.beginPath(); ctx.ellipse(-96, -4, 28, 10, 0.45, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(-36, 0, 22, 8, -0.3, 0, 7); ctx.fill();
    // ＞＜ 哭眼
    ctx.strokeStyle = '#3a4a6b'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-80, -34 + sob); ctx.lineTo(-70, -28 + sob);
    ctx.moveTo(-80, -22 + sob); ctx.lineTo(-70, -28 + sob);
    ctx.moveTo(-48, -34 + sob); ctx.lineTo(-58, -28 + sob);
    ctx.moveTo(-48, -22 + sob); ctx.lineTo(-58, -28 + sob);
    ctx.stroke();
    // 眼淚（滴落動畫 + 地上水灘）
    const drop = (t * 70) % 28;
    ctx.fillStyle = 'rgba(127,212,255,.9)';
    ctx.beginPath(); ctx.ellipse(-72, -12 + drop * 0.7, 3.5, 5.5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(127,212,255,.45)';
    ctx.beginPath(); ctx.ellipse(-68, 13, 26 + Math.sin(t * 2) * 3, 6, 0, 0, 7); ctx.fill();
    // murmur「ガッキー...」
    const dots = '.'.repeat(1 + (((t * 1.4) | 0) % 3));
    ctx.globalAlpha = 0.65 + Math.sin(t * 3) * 0.25;
    ctx.fillStyle = '#5b6c92';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.font = '700 26px "Microsoft JhengHei", sans-serif';
    ctx.fillText(`ガッキー${dots}`, -28, -86);
    ctx.globalAlpha = 1;
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
    ctx.fillStyle = inkSoft();
    ctx.fillText(label, x, y);
    ctx.font = '900 30px "Microsoft JhengHei", sans-serif';
    ctx.fillStyle = ink();
    ctx.fillText(value, x, y + 18);
  }
  function drawHUD() {
    drawTextBox(24, 18, '分數', String(G.score | 0), 'left');
    if (G.mode === 'single') drawTextBox(W - 24, 18, '單關挑戰', `肉 ${G.singleHp}KG`, 'right');
    else drawTextBox(W - 24, 18, '關卡', `${G.levelIndex + 1} / ${LEVELS.length}`, 'right');
  }
  // 簡易按鈕（Canvas 命中測試）
  const buttons = [];
  function button(x, y, w, h, label, onClick, fs) {
    const b = { x, y, w, h, label, onClick, fs: fs || 26 };
    buttons.push(b);
    return b;
  }
  function drawButtons(t) {
    for (const b of buttons) {
      const hover = pointer.x >= b.x && pointer.x <= b.x + b.w && pointer.y >= b.y && pointer.y <= b.y + b.h;
      ctx.fillStyle = hover ? '#ff7bb0' : '#ff9ec7';
      roundRect(b.x, b.y, b.w, b.h, 16); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `900 ${b.fs}px "Microsoft JhengHei", sans-serif`;
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

  // 常駐小圖示（跨場景，不隨 setScene 清空；例：喇叭）
  const icons = [];
  function icon(x, y, w, h, glyph, onClick) {
    const ic = { x, y, w, h, glyph, onClick, visible: null };
    icons.push(ic);
    return ic;
  }
  function iconAt(x, y) {
    return icons.find(ic => (!ic.visible || ic.visible()) &&
      x >= ic.x && x <= ic.x + ic.w && y >= ic.y && y <= ic.y + ic.h);
  }
  function drawIcons() {
    for (const ic of icons) {
      if (ic.visible && !ic.visible()) continue;
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      roundRect(ic.x, ic.y, ic.w, ic.h, 12); ctx.fill();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '22px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
      ctx.fillText(typeof ic.glyph === 'function' ? ic.glyph() : ic.glyph, ic.x + ic.w / 2, ic.y + ic.h / 2 + 1);
    }
  }
  icon(W - 66, 86, 44, 40, () => Audio.muted ? '🔇' : '🔊', () => Audio.toggleMute());

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
    const ic = iconAt(p.x, p.y);
    if (ic) { ic.onClick(); return; } // 常駐圖示（喇叭）
    for (const b of buttons) {
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) { b.onClick(); break; }
    }
  });

  // ===========================================================
  //  遊戲狀態 + 場景管理
  // ===========================================================
  const HP_OPTIONS = [60, 100, 300];
  const G = {
    score: 0,
    levelIndex: 0,
    mode: 'run', // 'run' = 全關卡挑戰；'single' = 單關挑戰
    high: Number(localStorage.getItem('kanata_high') || 0),
    singleHp: HP_OPTIONS.includes(Number(localStorage.getItem('kanata_hp')))
      ? Number(localStorage.getItem('kanata_hp')) : 100,
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
  // 打擊感分級：0=普通(小星輕震) 1=加成(中爆中震) 2=爆擊/PERFECT(hit-stop 40ms+白閃+大震)
  let hitstopT = 0, flashT = 0;
  function hitMeatFx(tier) {
    tier = tier === true ? 2 : tier === false ? 0 : tier;
    if (tier >= 2) {
      burst(MEAT_X, MEAT_Y, '#ffd86b', 26);
      shake(16);
      hitstopT = 0.04;
      flashT = 0.05;
    } else if (tier === 1) {
      burst(MEAT_X, MEAT_Y, '#ffb1d6', 16);
      shake(10);
    } else {
      burst(MEAT_X, MEAT_Y, '#ff8fc7', 8);
      shake(6);
    }
    Audio.punch();
  }

  // ---------- QTE 控制器（隨機事件） ----------
  const QTE_KEYS = [
    { code: 'ArrowLeft', label: '←' }, { code: 'ArrowRight', label: '→' },
    { code: 'ArrowUp', label: '↑' }, { code: 'ArrowDown', label: '↓' },
    { code: 'Space', label: '空白' }, { code: 'KeyF', label: 'F' }, { code: 'KeyJ', label: 'J' },
  ];
  const QTE_TARGET_R = 72; // 觸控圓靶半徑（邏輯座標）
  const QTE = {
    active: false, key: null, time: 0, dur: 1.3, onDone: null,
    touch: false, tx: 0, ty: 0,
    start(onDone) {
      this.active = true; this.key = choice(QTE_KEYS);
      this.touch = touchMode; // 題型開場時定案：鍵盤按鍵 / 觸控點圓靶
      this.tx = rand(150, W - 150); this.ty = rand(180, H - 140);
      this.time = this.dur; this.onDone = onDone;
      Input.clear();
      Audio.qte();
    },
    update(dt) {
      if (!this.active) return;
      this.time -= dt;
      if (this.touch) {
        Input.consumeKeys(); // 觸控題型不判鍵盤
        for (const p of Input.consumeTaps()) {
          const hit = Math.hypot(p.x - this.tx, p.y - this.ty) <= QTE_TARGET_R;
          return this.finish(hit); // 點偏也算失敗（同鍵盤按錯）
        }
      } else {
        Input.consumeTaps();
        for (const k of Input.consumeKeys()) {
          if (k.code === this.key.code) return this.finish(true);
          else return this.finish(false); // 按錯也算失敗
        }
      }
      if (this.time <= 0) this.finish(false);
    },
    finish(ok) {
      this.active = false;
      Input.clear(); // 答題的那一下不能漏到關卡裡變出拳/MISS
      if (ok) {
        const bonus = 300;
        G.score += bonus;
        pop(MEAT_X, MEAT_Y - 80, 'QTE 成功!', '#ffd24a', 46);
        hitMeatFx(true); hitMeatFx(true);
        emojiBurst('💪', 22);
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
      ctx.fillText(this.touch ? 'QTE！點圓靶' : 'QTE！快按', W / 2, H / 2 - 90);
      if (this.touch) {
        // 觸控圓靶：紅白同心圓＋倒數收縮外環
        const pulse = 1 + Math.sin((this.dur - this.time) * 14) * 0.04;
        ctx.save();
        ctx.translate(this.tx, this.ty);
        ctx.scale(pulse, pulse);
        const rings = [[QTE_TARGET_R, '#ff5d7a'], [QTE_TARGET_R * 0.68, '#fff'], [QTE_TARGET_R * 0.38, '#ff5d7a']];
        for (const [r, c] of rings) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); }
        ctx.fillStyle = '#fff'; ctx.font = '900 26px "Microsoft JhengHei", sans-serif';
        ctx.fillText('點我!', 0, QTE_TARGET_R * -1.35);
        ctx.restore();
        // 收縮外環＝剩餘時間
        const tr = clamp(this.time / this.dur, 0, 1);
        ctx.strokeStyle = tr > 0.35 ? '#ffd24a' : '#ff7b7b'; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.arc(this.tx, this.ty, QTE_TARGET_R + 14 + tr * 60, 0, 7); ctx.stroke();
      } else {
        // 按鍵框
        ctx.fillStyle = '#ffd24a';
        roundRect(W / 2 - 70, H / 2 - 50, 140, 100, 18); ctx.fill();
        ctx.fillStyle = '#2a3b5c'; ctx.font = '900 60px "Microsoft JhengHei", sans-serif';
        ctx.fillText(this.key.label, W / 2, H / 2 + 2);
      }
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
      button(W / 2 - 110, 408, 220, 62, '開打！', () => {
        Audio.init();
        G.score = 0; G.levelIndex = 0; G.mode = 'run';
        setScene(LEVELS[0]());
      });
      // 單關挑戰：三關獨立玩，可調肉的血量（各組合分開記最高分）
      const startSingle = (i) => {
        Audio.init();
        G.score = 0; G.levelIndex = i; G.mode = 'single';
        setScene(LEVELS[i]());
      };
      button(W / 2 - 281, 505, 128, 48, '①連打', () => startSingle(0), 22);
      button(W / 2 - 143, 505, 128, 48, '②連擊', () => startSingle(1), 22);
      button(W / 2 - 5, 505, 128, 48, '③節奏', () => startSingle(2), 22);
      const hpBtn = button(W / 2 + 133, 505, 148, 48, `肉 ${G.singleHp}KG`, () => {
        G.singleHp = HP_OPTIONS[(HP_OPTIONS.indexOf(G.singleHp) + 1) % HP_OPTIONS.length];
        localStorage.setItem('kanata_hp', String(G.singleHp));
        hpBtn.label = `肉 ${G.singleHp}KG`;
      }, 20);
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
      ctx.fillText(touchMode ? '點左半邊 = 左手　　點右半邊 = 右手' : 'F / 左鍵 = 左手　　J / 右鍵 = 右手', W / 2, 150);
      ctx.fillText(`最高分：${G.high}`, W / 2, 390);
      ctx.font = '700 16px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = '#5b6c92';
      ctx.fillText('單關挑戰：獨立計分拚紀錄，可調肉的血量', W / 2, 490);
    }
  };

  // ===========================================================
  //  第1關：連打地獄（在限時內把肉打到 0）
  // ===========================================================
  function Level1() {
    const maxhp = G.mode === 'single' ? G.singleHp : 100;
    return {
      name: '連打地獄', t: 0, time: 12, hp: maxhp, maxhp,
      squash: 0, qteFired: false, done: false, hits: 0, combo: 0,
      enter() { this.score0 = G.score | 0; pop(MEAT_X, MEAT_Y - 120, 'STAGE 1\n連打！', '#fff', 38); },
      update(dt) {
        this.t += dt;
        if (QTE.active) { QTE.update(dt); return; }
        this.time -= dt;
        this.squash = Math.max(0, this.squash - dt * 5);

        // 隨機觸發一次 QTE（剩約一半血時）
        if (!this.qteFired && this.hp < this.maxhp * 0.6) {
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
          hitMeatFx(alt && this.combo % 8 === 0 ? 2 : alt ? 1 : 0);
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
        endStage(1100, {
          stage: 0,
          stageScore: (G.score | 0) - this.score0,
          lines: [
            `出拳 ${this.hits} 次`,
            cleared ? `KO！剩餘 ${Math.ceil(this.time)} 秒` : '時間到…肉撐住了',
          ],
        });
      },
      render() {
        drawBackground(this.t);
        drawHUD();
        // 計時條
        bar(W/2 - 200, 24, 400, 18, this.time / 12, '#ffd24a');
        ctx.textAlign='center'; ctx.font='700 14px "Microsoft JhengHei"'; ctx.fillStyle=ink();
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
    const maxhp = G.mode === 'single' ? G.singleHp : 0; // 單關模式才有血條
    return {
      name: '連擊不斷', t: 0, beatT: 0, period: 0.62, ring: 0,
      combo: 0, maxCombo: 0, hits: 0, totalBeats: 28, beatCount: 0,
      qteFired: false, done: false, windowOpen: false, squash: 0,
      hp: maxhp, maxhp, ko: 0,
      enter() { this.score0 = G.score | 0; pop(MEAT_X, MEAT_Y - 120, 'STAGE 2\n連擊！', '#fff', 38); },
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
          const earlySec = (1 - phase) * this.period;   // 提前量（拍點前幾秒按）
          // X5 容錯：提前 80ms 內按在窗口邊緣算 GOOD，不斷 combo
          if (closeness < 0.10 || earlySec < 0.08) {
            this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo);
            const perfect = closeness < 0.045;
            G.score += perfect ? 60 : 35;
            pop(MEAT_X, MEAT_Y - 70, perfect ? 'PERFECT' : 'GOOD', perfect ? '#ffd24a' : '#7CFFB0', perfect ? 44 : 36);
            this.squash = 1; hitMeatFx(perfect ? 2 : 1); perfect ? Audio.perfect() : Audio.good();
            if (this.maxhp) applyMeatDamage(this, perfect ? 8 : 5);
          } else {
            if (this.combo > 0) pop(MEAT_X, MEAT_Y - 70, 'MISS', '#ff7b7b', 36);
            this.combo = 0; Audio.miss();
          }
        }

        // 數拍
        if (this.beatT >= this.period) {
          this.beatT -= this.period; this.beatCount++;
          // 後半逐步加速：第 14 拍起由 0.62s 緩降至 0.46s
          this.period = lerp(0.62, 0.46, clamp((this.beatCount - 14) / 12, 0, 1));
          if (!this.qteFired && this.beatCount === 14) { this.qteFired = true; QTE.start(() => {}); return; }
          if (this.beatCount >= this.totalBeats && !this.done) this.finish();
        }
      },
      finish() {
        this.done = true;
        G.score += this.maxCombo * 20;
        pop(MEAT_X, MEAT_Y - 80, `最高連擊 ${this.maxCombo}`, '#ffd24a', 40);
        Audio.clear(); shake(12);
        const lines = [`最高連擊 ${this.maxCombo}`];
        if (this.maxhp) lines.push(`KO ×${this.ko}`);
        endStage(1200, { stage: 1, stageScore: (G.score | 0) - this.score0, lines });
      },
      render() {
        drawBackground(this.t, 'dusk');
        drawHUD();
        ctx.textAlign='center'; ctx.font='700 14px "Microsoft JhengHei"'; ctx.fillStyle=ink();
        ctx.fillText(`STAGE 2 · 連擊不斷　Combo ${this.combo}`, W/2, 40);
        drawMeat(MEAT_X, MEAT_Y, 1.45, this.maxhp ? this.hp / this.maxhp : 0.6, this.squash, this.t);
        if (this.maxhp) {
          bar(MEAT_X - 100, MEAT_Y - 168, 200, 14, this.hp / this.maxhp, '#ff5d7a');
          if (this.ko) {
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.font = '900 18px "Microsoft JhengHei", sans-serif'; ctx.fillStyle = '#e0a32e';
            ctx.fillText(`KO ×${this.ko}`, MEAT_X + 112, MEAT_Y - 161);
          }
        }
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
    const maxhp = G.mode === 'single' ? G.singleHp : 0; // 單關模式才有血條
    return {
      name: '節奏打肉', t: 0, notes: [], spawnT: 0, idx: 0, done: false, squash: 0,
      chart: null, hitLineY: 470, judged: 0, totalNotes: 0,
      perfect: 0, good: 0, miss: 0,
      hp: maxhp, maxhp, ko: 0,
      enter() {
        this.score0 = G.score | 0;
        pop(MEAT_X, MEAT_Y - 120, 'STAGE 3\n節奏！', '#fff', 38);
        // 固定譜面（可背、可練），[軌, 到下一顆的間隔]；尾段密度拉高做高潮
        const pat = [
          ['L', .6], ['R', .6], ['L', .6], ['R', .6],                          // 熱身：左右交替
          ['L', .45], ['R', .45], ['LR', .75],                                  // 第一個雙押
          ['R', .45], ['L', .45], ['LR', .75],
          ['L', .5], ['L', .35], ['R', .5], ['R', .35],                         // 切分：同軌連兩顆
          ['LR', .7],
          ['L', .3], ['R', .3], ['L', .3], ['R', .3], ['L', .3], ['R', .3],     // 尾段高潮：密集交替
          ['LR', 0],                                                            // 收在雙押
        ];
        const ch = []; let tt = 1.2;
        for (const [p, gap] of pat) {
          if (p === 'LR') { ch.push({ t: tt, lane: 'L' }); ch.push({ t: tt, lane: 'R' }); }
          else ch.push({ t: tt, lane: p });
          tt += gap;
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
          // X5 容錯：音符還沒到線（提前按）多給 80ms 邊緣窗
          if (best && (bestd < 60 || (best.y < this.hitLineY && bestd < 60 + speed * 0.08))) {
            best.hit = true; this.judged++;
            const perfect = bestd < 24;
            if (perfect) { this.perfect++; G.score += 100; pop(laneX[lane], this.hitLineY - 40, 'PERFECT', '#ffd24a', 34); Audio.perfect(); }
            else { this.good++; G.score += 50; pop(laneX[lane], this.hitLineY - 40, 'GOOD', '#7CFFB0', 30); Audio.good(); }
            this.squash = 1; hitMeatFx(perfect ? 2 : 1);
            if (this.maxhp) applyMeatDamage(this, perfect ? 8 : 5);
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
        const lines = [`PERFECT ${this.perfect}／GOOD ${this.good}／MISS ${this.miss}`];
        if (this.maxhp) lines.push(`KO ×${this.ko}`);
        endStage(1300, { stage: 2, stageScore: (G.score | 0) - this.score0, lines });
      },
      render() {
        drawBackground(this.t, 'night');
        drawHUD();
        ctx.textAlign='center'; ctx.font='700 14px "Microsoft JhengHei"'; ctx.fillStyle=ink();
        ctx.fillText('STAGE 3 · 節奏打肉　F=左　J=右', W/2, 40);
        // 軌道
        for (const lane of ['L','R']) {
          const x = laneX[lane];
          ctx.fillStyle = 'rgba(255,255,255,.35)';
          roundRect(x - 34, 60, 68, this.hitLineY - 60 + 40, 12); ctx.fill();
          ctx.fillStyle = inkSoft();
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
        drawMeat(MEAT_X, MEAT_Y - 60, 1.0, this.maxhp ? this.hp / this.maxhp : 0.6, this.squash, this.t);
        if (this.maxhp) {
          bar(MEAT_X - 80, MEAT_Y - 150, 160, 12, this.hp / this.maxhp, '#ff5d7a');
          if (this.ko) {
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.font = '900 18px "Microsoft JhengHei", sans-serif'; ctx.fillStyle = '#e0a32e';
            ctx.fillText(`KO ×${this.ko}`, MEAT_X + 92, MEAT_Y - 144);
          }
        }
        // 觸控踏板：左粉右藍，被按時亮起（亮度借用出拳動畫的衰減值）
        if (touchMode) {
          const pads = [
            { x0: 16, glow: angel.punchL, rgb: '255,143,199', label: '左' },
            { x0: W / 2 + 4, glow: angel.punchR, rgb: '124,203,255', label: '右' },
          ];
          for (const pd of pads) {
            ctx.fillStyle = `rgba(${pd.rgb},${(0.18 + pd.glow * 0.3).toFixed(2)})`;
            roundRect(pd.x0, this.hitLineY + 36, W / 2 - 20, H - this.hitLineY - 52, 14); ctx.fill();
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.font = '900 24px "Microsoft JhengHei", sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,.85)';
            ctx.fillText(pd.label, pd.x0 + (W / 2 - 20) / 2, this.hitLineY + 36 + (H - this.hitLineY - 52) / 2);
          }
        }
        drawFists(this.t);
      }
    };
  }

  const LEVELS = [Level1, Level2, Level3];
  const STAGE_INFO = [
    { name: '連打地獄', tip: 'F / J（或滑鼠左右鍵）狂打！左右交替傷害更高' },
    { name: '連擊不斷', tip: '白環縮到內圈的瞬間出拳，PERFECT 拿高分' },
    { name: '節奏打肉', tip: '音符碰到判定線時按：F＝左軌　J＝右軌' },
  ];

  // 單關模式：打肉扣血，打空 = KO 加分後回滿繼續刷
  function applyMeatDamage(lv, d) {
    lv.hp -= d;
    if (lv.hp > 0) return;
    lv.hp = lv.maxhp; lv.ko++;
    G.score += 500;
    pop(MEAT_X, MEAT_Y - 115, 'KO！+500', '#ffd24a', 44);
    hitMeatFx(true);
  }

  // 關卡收尾：全關卡模式插入過場（最後一關直接進結算）；單關模式進單關結算
  function endStage(delay, summary) {
    setTimeout(() => {
      if (G.mode === 'single') { setScene(SingleResultScene(summary)); return; }
      G.levelIndex++;
      if (G.levelIndex >= LEVELS.length) setScene(ResultScene);
      else setScene(InterludeScene(summary));
    }, delay);
  }

  // ---------- 關卡間過場：本關小結 + 下一關預告，按任意鍵繼續 ----------
  function InterludeScene(summary) {
    return {
      t: 0,
      enter() { this.t = 0; },
      update(dt) {
        this.t += dt;
        const pressed = Input.consumeHits().length || Input.consumeKeys().length;
        if (this.t > 0.8 && pressed) setScene(LEVELS[G.levelIndex]());
      },
      render() {
        drawBackground(this.t, STAGE_THEMES[G.levelIndex]); // 過場先進下一關的天色
        ctx.fillStyle = 'rgba(20,30,55,.35)'; ctx.fillRect(0, 0, W, H);
        // 小結卡
        ctx.fillStyle = 'rgba(255,255,255,.94)';
        roundRect(W / 2 - 270, 78, 540, 440, 24); ctx.fill();
        ctx.strokeStyle = '#ffd0e2'; ctx.lineWidth = 4;
        roundRect(W / 2 - 270, 78, 540, 440, 24); ctx.stroke();

        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '900 38px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#ff6fa5';
        ctx.fillText(`STAGE ${summary.stage + 1} 完成！`, W / 2, 132);
        ctx.font = '900 52px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#e0a32e';
        ctx.fillText(`+${summary.stageScore}`, W / 2, 198);

        ctx.font = '700 22px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#3a4a6b';
        summary.lines.forEach((line, i) => ctx.fillText(line, W / 2, 252 + i * 34));
        ctx.fillStyle = '#5b6c92';
        ctx.fillText(`目前總分 ${G.score | 0}`, W / 2, 252 + summary.lines.length * 34);

        // 分隔線
        ctx.strokeStyle = '#ffd0e2'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(W / 2 - 210, 378); ctx.lineTo(W / 2 + 210, 378); ctx.stroke();

        // 下一關預告
        const next = STAGE_INFO[G.levelIndex];
        ctx.font = '900 28px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#2a3b5c';
        ctx.fillText(`NEXT ▶ STAGE ${G.levelIndex + 1}・${next.name}`, W / 2, 412);
        ctx.font = '700 18px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#5b6c92';
        ctx.fillText(next.tip, W / 2, 448);

        // 繼續提示（0.8 秒後才收輸入）
        ctx.globalAlpha = this.t < 0.8 ? 0.25 : 0.55 + Math.sin(this.t * 4) * 0.45;
        ctx.font = '900 22px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#ff6fa5';
        ctx.fillText('按任意鍵／點擊畫面 繼續', W / 2, 492);
        ctx.globalAlpha = 1;
      }
    };
  }

  // ---------- 分享（結算畫面截圖 → Twitter／剪貼簿／下載／系統分享面板） ----------
  function gameUrl() {
    return /^https?:$/.test(location.protocol) ? location.href.split(/[?#]/)[0] : '';
  }
  // 重畫一幀乾淨的結算畫面（不含按鈕/圖示），蓋上 hashtag 浮水印後輸出 PNG
  function captureResultBlob() {
    return new Promise((resolve, reject) => {
      if (scene && scene.render) scene.render();
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.font = '700 16px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = 'rgba(42,59,92,.55)';
      ctx.fillText('#天音彼方打肉', W - 16, H - 10);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('capture failed')), 'image/png');
    });
  }
  async function copyResultImage() {
    const blob = await captureResultBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }
  // Twitter web intent 不能夾圖：先把圖塞進剪貼簿，開推文視窗後請玩家 Ctrl+V
  async function shareToTwitter(text) {
    let copied = false;
    try { await copyResultImage(); copied = true; } catch (e) {}
    const p = new URLSearchParams({ text });
    const url = gameUrl();
    if (url) p.set('url', url);
    const w = window.open('https://twitter.com/intent/tweet?' + p.toString(), '_blank', 'noopener');
    if (copied) pop(W / 2, H / 2, '結算圖已複製，推文裡 Ctrl+V 貼圖', '#7CFFB0', 26);
    else pop(W / 2, H / 2, '圖片複製失敗，改用「下載紀念卡」', '#ff7b7b', 24);
    if (!w) pop(W / 2, H / 2 + 44, '彈窗被瀏覽器擋下，請允許後重試', '#ffd24a', 22);
  }
  function copyImageForDiscord() {
    copyResultImage()
      .then(() => pop(W / 2, H / 2, '已複製！貼到 Discord 就是圖', '#7CFFB0', 28))
      .catch(() => {
        downloadResultImage();
        pop(W / 2, H / 2 + 44, '剪貼簿不支援，改下載給你', '#ffd24a', 22);
      });
  }
  function downloadResultImage() {
    captureResultBlob().then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `kanata-uchiniku-${G.score | 0}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      pop(W / 2, H / 2, '紀念卡已下載', '#7CFFB0', 28);
    }).catch(() => pop(W / 2, H / 2, '截圖失敗…', '#ff7b7b', 26));
  }
  // 行動裝置：系統分享面板可直接帶圖（Twitter/Discord/LINE 通吃）
  // 注意：桌機 Chrome 也回報支援（Windows 分享面板），但那裡通常沒有 Twitter/Discord，
  // 所以只在觸控環境走系統面板，桌機一律用 Twitter/複製圖按鈕
  function canSystemShare() {
    if (!touchMode || !navigator.canShare) return false;
    try {
      return navigator.canShare({ files: [new File([new Uint8Array(8)], 't.png', { type: 'image/png' })] });
    } catch (e) { return false; }
  }
  function systemShare(text) {
    captureResultBlob().then(blob => {
      const file = new File([blob], `kanata-uchiniku-${G.score | 0}.png`, { type: 'image/png' });
      return navigator.share({ files: [file], text: text + (gameUrl() ? '\n' + gameUrl() : '') });
    }).catch(() => {}); // 玩家取消分享也會 reject，安靜略過
  }

  // ===========================================================
  //  結算
  // ===========================================================
  const WIN_SCORE = 4000; // 勝利門檻（A 級以上）
  const ResultScene = {
    t: 0, rank: 'C', isNewHigh: false, win: false,
    enter() {
      this.t = 0;
      this.isNewHigh = G.score > G.high;
      if (this.isNewHigh) { G.high = G.score | 0; localStorage.setItem('kanata_high', String(G.high)); }
      const s = G.score;
      this.rank = s >= 6000 ? 'S' : s >= 4000 ? 'A' : s >= 2200 ? 'B' : 'C';
      this.win = s >= WIN_SCORE;
      burst(W/2, 220, this.win ? '#ffd24a' : '#9fb3d9', 40);
      button(500, 425, 200, 46, '再來一次', () => { G.score = 0; G.levelIndex = 0; G.mode = 'run'; setScene(LEVELS[0]()); }, 22);
      button(710, 425, 200, 46, '回標題', () => setScene(TitleScene), 22);
      if (canSystemShare()) { // 行動裝置：系統面板直接帶圖
        button(500, 477, 200, 46, '分享（帶圖）', () => systemShare(this.shareText()), 20);
        button(710, 477, 200, 46, '下載紀念卡', downloadResultImage, 20);
      } else {
        button(500, 477, 200, 46, '分享到 Twitter', () => shareToTwitter(this.shareText()), 18);
        button(710, 477, 200, 46, '複製結算圖', copyImageForDiscord, 20);
        button(500, 529, 410, 44, '下載紀念卡', downloadResultImage, 20);
      }
      if (this.win) Audio.clear(); else Audio.miss();
    },
    shareText() {
      const flavor = this.win ? '，握力 60KG 全開💪' : '💪';
      return `我在「天音彼方 打肉！」拿到 ${G.score | 0} 分・${this.rank} 級${flavor} #天音彼方打肉`;
    },
    update(dt) { this.t += dt; },
    render() {
      drawBackground(this.t);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 54px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = '#ff6fa5'; ctx.fillText('結算', W / 2, 70);
      // 勝敗橫幅
      ctx.font = '900 30px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = this.win ? '#e0a32e' : '#5b6c92';
      ctx.fillText(this.win ? 'WINNER！握力 60KG 全開！' : '敗北………', W / 2, 125);
      // 評價
      const rc = { S: '#ffd24a', A: '#7CFFB0', B: '#7CCBFF', C: '#c9c9c9' }[this.rank];
      ctx.font = '900 120px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = rc;
      ctx.fillText(this.rank, W / 2 + 150, 250);
      ctx.font = '900 38px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = '#2a3b5c';
      ctx.fillText(`總分 ${G.score | 0}`, W / 2 + 150, 345);
      ctx.font = '700 22px "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = this.isNewHigh ? '#ff6fa5' : '#3a4a6b';
      ctx.fillText(this.isNewHigh ? '★ 新紀錄！ ★' : `最高分 ${G.high}`, W / 2 + 150, 400);
      // 勝敗演出（左側舞台）
      if (this.win) {
        if (!drawEndingImage('win', 240, 545, 360, 360)) {
          drawAngelVictory(230, 300, this.t);
          drawGripper(390, 330, this.t);
        }
      } else if (!drawEndingImage('lose', 250, 520, 390, 320)) {
        drawAngelDefeat(250, 390, this.t);
      }
    }
  };

  // ---------- 單關挑戰結算（關卡 × 血量 各自記最高分） ----------
  function SingleResultScene(summary) {
    const stage = summary.stage;
    const info = STAGE_INFO[stage];
    const bestKey = `kanata_best_s${stage + 1}_${G.singleHp}`;
    return {
      t: 0, best: 0, isNew: false,
      enter() {
        this.t = 0;
        this.best = Number(localStorage.getItem(bestKey) || 0);
        this.isNew = (G.score | 0) > this.best;
        if (this.isNew) { this.best = G.score | 0; localStorage.setItem(bestKey, String(this.best)); }
        burst(W / 2, 200, '#ffd24a', 36);
        Audio.clear();
        button(W / 2 - 230, 418, 220, 46, '再挑戰', () => { G.score = 0; setScene(LEVELS[stage]()); }, 22);
        button(W / 2 + 10, 418, 220, 46, '回標題', () => setScene(TitleScene), 22);
        if (canSystemShare()) {
          button(W / 2 - 230, 470, 220, 46, '分享（帶圖）', () => systemShare(this.shareText()), 20);
          button(W / 2 + 10, 470, 220, 46, '下載紀念卡', downloadResultImage, 20);
        } else {
          button(W / 2 - 230, 470, 220, 46, '分享到 Twitter', () => shareToTwitter(this.shareText()), 18);
          button(W / 2 + 10, 470, 220, 46, '複製結算圖', copyImageForDiscord, 20);
          button(W / 2 - 230, 522, 460, 44, '下載紀念卡', downloadResultImage, 20);
        }
      },
      shareText() {
        return `我在「天音彼方 打肉！」單關挑戰 STAGE ${stage + 1}・${info.name}（肉血量 ${G.singleHp}KG）打出 ${G.score | 0} 分！💪 #天音彼方打肉`;
      },
      update(dt) { this.t += dt; },
      render() {
        drawBackground(this.t);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '900 46px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#ff6fa5';
        ctx.fillText('單關挑戰 結算', W / 2, 66);
        ctx.font = '900 26px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#2a3b5c';
        ctx.fillText(`STAGE ${stage + 1}・${info.name}　肉血量 ${G.singleHp}KG`, W / 2, 122);
        ctx.font = '900 64px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#e0a32e';
        ctx.fillText(`${G.score | 0} 分`, W / 2, 210);
        ctx.font = '700 24px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = '#3a4a6b';
        summary.lines.forEach((line, i) => ctx.fillText(line, W / 2, 278 + i * 38));
        ctx.font = '700 24px "Microsoft JhengHei", sans-serif';
        ctx.fillStyle = this.isNew ? '#ff6fa5' : '#5b6c92';
        ctx.fillText(this.isNew ? '★ 新紀錄！ ★' : `此設定最佳 ${this.best}`, W / 2, 390);
      }
    };
  }

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
      if (hitstopT > 0) {
        hitstopT -= dt; // 凍幀：整個世界停 40ms，放大爆擊重量感
      } else {
        if (scene && scene.update) scene.update(dt);
        updateAngel(dt);
        updateParticles(dt);
        updateEmojiFx(dt);
        updatePops(dt);
        if (shakeT > 0) shakeT -= dt;
      }
      if (flashT > 0) flashT -= dt;
    }

    // 渲染
    ctx.save();
    if (shakeT > 0) {
      const m = shakeMag * (shakeT / 0.18);
      ctx.translate(rand(-m, m), rand(-m, m));
    }
    if (scene && scene.render) scene.render();
    drawParticles();
    drawEmojiFx();
    drawPops();
    drawButtons(t / 1000);
    ctx.restore();
    if (flashT > 0) { // 爆擊白閃
      ctx.fillStyle = `rgba(255,255,255,${(clamp(flashT / 0.05, 0, 1) * 0.6).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
    drawIcons(); // 常駐 UI 不跟著震動

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
