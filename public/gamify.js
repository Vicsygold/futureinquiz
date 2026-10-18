// FutureIN Quiz — Gamification Engine (Streaks, Live Badges & Animated Mascot Companion)
// Zero external dependencies: Uses HTML5 Canvas and native Web Audio API.

(function (root) {
  'use strict';

  let actx = null;
  function getAudioCtx() {
    if (!actx) {
      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) {}
    }
    if (actx && actx.state === 'suspended') {
      actx.resume().catch(() => {});
    }
    return actx;
  }

  function playTone(freq, start, dur, type = 'triangle', vol = 0.18) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur);
    } catch (_) {}
  }

  // Melodic sounds
  function playStreakSound(level) {
    if (level === 1) {
      // 1-2 in a row: 2 ascending cheerful notes
      [523.25, 659.25].forEach((f, i) => playTone(f, i * 0.08, 0.22, 'triangle', 0.15));
    } else if (level === 2) {
      // 3-4 in a row: 3 notes rising higher
      [523.25, 659.25, 783.99].forEach((f, i) => playTone(f, i * 0.08, 0.28, 'triangle', 0.2));
    } else {
      // 5+ in a row: Supercharged 4-note victory chord!
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => playTone(f, i * 0.07, 0.35, 'triangle', 0.22));
    }
  }

  function playFanfareSound() {
    const chord = [440, 554.37, 659.25, 880];
    chord.forEach((f, i) => playTone(f, i * 0.09, 0.45, 'triangle', 0.18));
  }

  function playEncourageSound() {
    playTone(392, 0, 0.15, 'sine', 0.12);
    playTone(440, 0.12, 0.22, 'sine', 0.14);
  }

  function playMascotChirp() {
    playTone(659.25, 0, 0.08, 'sine', 0.15);
    playTone(880, 0.08, 0.14, 'triangle', 0.18);
  }

  /* ---------- Canvas Confetti Engine ---------- */
  let confettiCanvas = null;
  let confettiCtx = null;
  let particles = [];
  let animFrame = null;

  function ensureCanvas() {
    if (!confettiCanvas) {
      confettiCanvas = document.createElement('canvas');
      confettiCanvas.className = 'fin-confetti-canvas';
      document.body.appendChild(confettiCanvas);
      confettiCtx = confettiCanvas.getContext('2d');
      resizeCanvas();
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('resize', resizeCanvas);
      }
    }
  }

  function resizeCanvas() {
    if (confettiCanvas) {
      confettiCanvas.width = window.innerWidth;
      confettiCanvas.height = window.innerHeight;
    }
  }

  const COLORS = ['#ff6b9a', '#ffc93c', '#36c46b', '#4cb8ff', '#9b6bff', '#ff9a3c', '#ffffff'];

  function fireConfetti(options = {}) {
    ensureCanvas();
    const count = options.count || 45;
    const originX = options.x !== undefined ? options.x : window.innerWidth / 2;
    const originY = options.y !== undefined ? options.y : window.innerHeight * 0.4;

    for (let i = 0; i < count; i++) {
      const angle = (Math.random() * Math.PI * 2);
      const speed = 4 + Math.random() * 9;
      particles.push({
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 3,
        size: 7 + Math.random() * 8,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 12,
        gravity: 0.22 + Math.random() * 0.1,
        life: 1,
        decay: 0.012 + Math.random() * 0.01,
        isStar: Math.random() > 0.65
      });
    }

    if (!animFrame) {
      animFrame = requestAnimationFrame(updateConfetti);
    }
  }

  function updateConfetti() {
    if (!confettiCtx) return;
    confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.rotation += p.rotationSpeed;
      p.life -= p.decay;

      if (p.life <= 0 || p.y > window.innerHeight) {
        particles.splice(i, 1);
        continue;
      }

      confettiCtx.save();
      confettiCtx.translate(p.x, p.y);
      confettiCtx.rotate((p.rotation * Math.PI) / 180);
      confettiCtx.globalAlpha = Math.max(0, p.life);
      confettiCtx.fillStyle = p.color;

      if (p.isStar) {
        drawStar(confettiCtx, 0, 0, 5, p.size, p.size / 2);
      } else {
        confettiCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      }
      confettiCtx.restore();
    }

    if (particles.length > 0) {
      animFrame = requestAnimationFrame(updateConfetti);
    } else {
      animFrame = null;
      if (confettiCanvas && confettiCanvas.parentNode) {
        confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
      }
    }
  }

  function drawStar(ctx, cx, cy, spikes, outerRadius, innerRadius) {
    let rot = (Math.PI / 2) * 3;
    let x = cx;
    let y = cy;
    const step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    for (let i = 0; i < spikes; i++) {
      x = cx + Math.cos(rot) * outerRadius;
      y = cy + Math.sin(rot) * outerRadius;
      ctx.lineTo(x, y);
      rot += step;

      x = cx + Math.cos(rot) * innerRadius;
      y = cy + Math.sin(rot) * innerRadius;
      ctx.lineTo(x, y);
      rot += step;
    }
    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
    ctx.fill();
  }

  /* ---------- Mascot SVG Generator ---------- */
  function getMascotSVG(mood = 'happy') {
    let eyeLeft = `<circle cx="72" cy="74" r="14" fill="#3ddc84"/><circle cx="76" cy="70" r="5" fill="#fff"/>`;
    let eyeRight = `<circle cx="128" cy="74" r="14" fill="#3ddc84"/><circle cx="132" cy="70" r="5" fill="#fff"/>`;
    let mouth = `<path d="M80 94 Q100 114 120 94" stroke="#ffc629" stroke-width="6" fill="none" stroke-linecap="round"/>`;
    let shades = '';
    let antennaSpark = '';

    if (mood === 'excited' || mood === 'celebrate') {
      eyeLeft = `<polygon points="72,62 76,71 86,72 78,79 80,89 72,83 64,89 66,79 58,72 68,71" fill="#ffeb3b"/>`;
      eyeRight = `<polygon points="128,62 132,71 142,72 134,79 136,89 128,83 120,89 122,79 114,72 124,71" fill="#ffeb3b"/>`;
      mouth = `<path d="M76 92 Q100 122 124 92 Z" fill="#ffc629"/>`;
      antennaSpark = `<circle cx="100" cy="8" r="9" fill="#ffeb3b" opacity=".8"/>`;
    } else if (mood === 'fire') {
      shades = `
        <polygon points="50,66 94,66 88,86 56,86" fill="#111" stroke="#ffc629" stroke-width="2"/>
        <polygon points="106,66 150,66 144,86 112,86" fill="#111" stroke="#ffc629" stroke-width="2"/>
        <line x1="94" y1="72" x2="106" y2="72" stroke="#ffc629" stroke-width="3"/>
        <line x1="58" y1="70" x2="80" y2="70" stroke="#fff" stroke-width="2" opacity=".7"/>
        <line x1="114" y1="70" x2="136" y2="70" stroke="#fff" stroke-width="2" opacity=".7"/>
      `;
      antennaSpark = `<polygon points="100,0 106,12 118,14 108,22 111,34 100,27 89,34 92,22 82,14 94,12" fill="#ff5722"/>`;
    } else if (mood === 'oops') {
      eyeLeft = `<circle cx="72" cy="74" r="12" fill="#4cb8ff"/><circle cx="72" cy="70" r="4" fill="#fff"/>`;
      eyeRight = `<circle cx="128" cy="74" r="12" fill="#4cb8ff"/><circle cx="128" cy="70" r="4" fill="#fff"/>`;
      mouth = `<ellipse cx="100" cy="100" rx="10" ry="6" fill="#ffc629"/>`;
    }

    return `
      <svg viewBox="0 0 200 200" class="fin-mascot-svg ${mood}">
        <!-- Antenna -->
        <line x1="100" y1="28" x2="100" y2="6" stroke="#ffc629" stroke-width="6" stroke-linecap="round"/>
        <polygon points="100,4 105,13 115,14 107,21 109,31 100,25 91,31 93,21 85,14 95,13" fill="#ffc629"/>
        ${antennaSpark}
        <!-- Body -->
        <rect x="22" y="28" width="156" height="114" rx="26" fill="#9b4dff" stroke="#7a34d6" stroke-width="5"/>
        <!-- Face Screen -->
        <rect x="36" y="40" width="128" height="90" rx="18" fill="#140833"/>
        <!-- Eyes & Cheeks -->
        ${eyeLeft}
        ${eyeRight}
        ${shades}
        <circle cx="56" cy="94" r="9" fill="#ff6b9a" opacity=".7"/>
        <circle cx="144" cy="94" r="9" fill="#ff6b9a" opacity=".7"/>
        <!-- Smile / Mouth -->
        ${mouth}
        <!-- Neck & Base Stand -->
        <rect x="88" y="142" width="24" height="18" fill="#7a34d6"/>
        <rect x="52" y="158" width="96" height="16" rx="8" fill="#ffc629" stroke="#cc8600" stroke-width="3"/>
      </svg>
    `;
  }

  /* ---------- Gamification Controller ---------- */
  class GamifyController {
    constructor() {
      this.streak = 0;
      this.maxStreak = 0;
      this.correctCount = 0;
      this.totalAnswered = 0;
      this.hasMistake = false;
      this.streakMasterUnlocked = false;

      this.hudWrap = null;
      this.mascotDock = null;
      this.mascotAvatar = null;
      this.mascotBubble = null;
      this.speechTimeout = null;

      // Auto-inject HUD on DOM ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.ensureQuizHUD());
      } else {
        setTimeout(() => this.ensureQuizHUD(), 50);
      }
    }

    reset() {
      this.streak = 0;
      this.maxStreak = 0;
      this.correctCount = 0;
      this.totalAnswered = 0;
      this.hasMistake = false;
      this.streakMasterUnlocked = false;

      this.checkVisibility();
      this.updateHUD();
      this.setMascotMood('happy', "Hi! I'm Sparky! 🚀 Tap the right picture to win stars!");
    }

    startQuiz() {
      this.ensureQuizHUD();
      this.checkVisibility();
      this.updateHUD();
      this.setMascotMood('happy', "Hi! I'm Sparky! 🚀 Tap the right picture to win stars!");
    }

    /* Inject Persistent Top HUD & Animated Mascot Companion */
    ensureQuizHUD() {
      const quizSection = document.getElementById('quiz') || document.getElementById('c_quiz') || document.querySelector('.wrap') || document.body;
      if (!quizSection) return;

      // 1. Persistent Top HUD
      if (!this.hudWrap) {
        this.hudWrap = document.createElement('div');
        this.hudWrap.className = 'fin-hud-wrap';
        this.hudWrap.innerHTML = `
          <div class="fin-hud-streak-row">
            <div class="fin-hud-streak-pill">
              <span class="fin-hud-flame">🔥</span>
              <span id="finStreakText">Streak: 0</span>
            </div>
            <div class="fin-hud-meter">
              <div class="fin-hud-meter-fill" id="finMeterFill"></div>
            </div>
            <div class="fin-hud-multiplier" id="finMultiplier">1.0x Combo</div>
          </div>
          <div class="fin-hud-badges-row">
            <span class="fin-quest-chip active" id="chipSharpshooter">
              <span class="fin-quest-icon">🎯</span>
              <span>Sharpshooter</span>
              <span class="fin-quest-status" id="chipSharpStatus">100%</span>
            </span>
            <span class="fin-quest-chip" id="chipStreakMaster">
              <span class="fin-quest-icon">🔥</span>
              <span>Streak Master</span>
              <span class="fin-quest-status" id="chipStreakStatus">0/3</span>
            </span>
            <span class="fin-quest-chip active" id="chipSpeedStar">
              <span class="fin-quest-icon">⚡</span>
              <span>Speedstar</span>
              <span class="fin-quest-status">Active</span>
            </span>
          </div>
        `;

        // Insert at the top of the quiz or above q-area
        const topEl = (quizSection.querySelector && (quizSection.querySelector('.top') || quizSection.querySelector('.c-top'))) || null;
        if (topEl && topEl.parentNode) {
          topEl.parentNode.insertBefore(this.hudWrap, topEl.nextSibling);
        } else if (quizSection.prepend) {
          quizSection.prepend(this.hudWrap);
        } else if (quizSection.appendChild) {
          quizSection.appendChild(this.hudWrap);
        }
      }

      // 2. Interactive Robot Mascot Companion
      if (!this.mascotDock) {
        this.mascotDock = document.createElement('div');
        this.mascotDock.className = 'fin-mascot-dock';
        this.mascotDock.innerHTML = `
          <div class="fin-mascot-bubble" id="finMascotBubble">
            Hi! I'm Sparky! 🚀 Tap the right picture to win stars!
          </div>
          <div class="fin-mascot-avatar" id="finMascotAvatar" title="Sparky the Robot - Tap me!">
            ${getMascotSVG('happy')}
          </div>
        `;
        document.body.appendChild(this.mascotDock);

        this.mascotAvatar = (this.mascotDock.querySelector && this.mascotDock.querySelector('#finMascotAvatar')) || document.getElementById('finMascotAvatar');
        this.mascotBubble = (this.mascotDock.querySelector && this.mascotDock.querySelector('#finMascotBubble')) || document.getElementById('finMascotBubble');

        // Tap Mascot for cheer
        if (this.mascotAvatar) {
          this.mascotAvatar.onclick = () => {
            playMascotChirp();
            this.mascotAvatar.classList.remove('jump', 'wobble');
            void this.mascotAvatar.offsetWidth;
            this.mascotAvatar.classList.add('jump');

            const cheers = [
              "You have a super tech brain! 💡",
              "I'm cheering for you! 🌟 Let's win!",
              "Beep boop! Look at you go, superstar! 🚀",
              "Keep tapping! Every question makes you smarter! ⭐"
            ];
            this.setMascotMood('excited', cheers[Math.floor(Math.random() * cheers.length)]);
          };
        }
      }

      // 3. Auto screen visibility
      this.checkVisibility();
      if (!this.observerSetup) {
        this.observerSetup = true;
        const qEl = document.getElementById('quiz') || document.getElementById('c_quiz');
        if (qEl) {
          const obs = new MutationObserver(() => this.checkVisibility());
          obs.observe(qEl, { attributes: true, attributeFilter: ['class', 'hidden'] });
        }
      }

      this.updateHUD();
    }

    checkVisibility() {
      const quiz = document.getElementById('quiz') || document.getElementById('c_quiz');
      const end = document.getElementById('end') || document.getElementById('c_done');
      const isQuiz = quiz && !quiz.classList.contains('hidden') && !quiz.hidden;
      const isEnd = end && !end.classList.contains('hidden') && !end.hidden;

      if (this.hudWrap) {
        this.hudWrap.style.display = isQuiz ? 'flex' : 'none';
      }
      if (this.mascotDock) {
        this.mascotDock.style.display = (isQuiz || isEnd) ? 'flex' : 'none';
      }
    }

    updateHUD() {
      const getEl = (id) => document.getElementById(id) || (this.hudWrap && this.hudWrap.querySelector && this.hudWrap.querySelector('#' + id));
      const textEl = getEl('finStreakText');
      const meterEl = getEl('finMeterFill');
      const multEl = getEl('finMultiplier');
      const sharpStatusEl = getEl('chipSharpStatus');
      const chipSharpEl = getEl('chipSharpshooter');
      const chipStreakEl = getEl('chipStreakMaster');
      const chipStreakStatus = getEl('chipStreakStatus');

      // Streak text & flame
      if (textEl) {
        textEl.textContent = `Streak: ${this.streak}`;
      }

      // Combo multiplier & progress bar
      let multText = '1.0x Combo';
      let progressPercent = 0;
      let isSuper = false;

      if (this.streak >= 5) {
        multText = '🚀 3.0x MEGA COMBO!';
        progressPercent = 100;
        isSuper = true;
      } else if (this.streak >= 3) {
        multText = '🔥 2.0x Super Combo!';
        progressPercent = 60 + (this.streak - 3) * 20;
      } else if (this.streak >= 2) {
        multText = '⚡ 1.5x Combo!';
        progressPercent = 50;
      } else if (this.streak === 1) {
        multText = '🔥 1.2x Spark!';
        progressPercent = 25;
      } else {
        multText = '1.0x Combo';
        progressPercent = 0;
      }

      if (multEl) {
        multEl.textContent = multText;
        multEl.className = 'fin-hud-multiplier' + (isSuper ? ' super' : '');
      }
      if (meterEl) {
        meterEl.style.width = `${progressPercent}%`;
      }

      // Sharpshooter chip
      if (chipSharpEl && sharpStatusEl) {
        if (this.hasMistake) {
          chipSharpEl.className = 'fin-quest-chip failed';
          sharpStatusEl.textContent = 'Missed';
        } else {
          chipSharpEl.className = 'fin-quest-chip active';
          sharpStatusEl.textContent = '100%';
        }
      }

      // Streak Master chip (target 3)
      if (chipStreakEl && chipStreakStatus) {
        if (this.streakMasterUnlocked || this.maxStreak >= 3) {
          chipStreakEl.className = 'fin-quest-chip unlocked';
          chipStreakStatus.textContent = 'UNLOCKED! 🏆';
        } else {
          chipStreakEl.className = 'fin-quest-chip';
          chipStreakStatus.textContent = `${Math.min(3, this.streak)}/3`;
        }
      }
    }

    setMascotMood(mood, text) {
      if (this.mascotAvatar) {
        this.mascotAvatar.innerHTML = getMascotSVG(mood);
      }
      if (this.mascotBubble && text) {
        this.mascotBubble.textContent = text;
        this.mascotBubble.style.display = 'block';

        clearTimeout(this.speechTimeout);
        this.speechTimeout = setTimeout(() => {
          if (this.mascotBubble && this.streak === 0) {
            this.mascotBubble.textContent = "Focus on the next one! You've got this! 🌟";
          }
        }, 4000);
      }
    }

    recordAnswer(isCorrect, eventOrBtn = null) {
      this.ensureQuizHUD();
      this.totalAnswered++;

      let clickX = window.innerWidth / 2;
      let clickY = window.innerHeight * 0.45;
      if (eventOrBtn) {
        const rect = eventOrBtn.getBoundingClientRect ? eventOrBtn.getBoundingClientRect() : null;
        if (rect) {
          clickX = rect.left + rect.width / 2;
          clickY = rect.top + rect.height / 2;
        }
      }

      if (isCorrect) {
        this.correctCount++;
        this.streak++;
        this.maxStreak = Math.max(this.maxStreak, this.streak);

        // Always fire festive particle confetti
        fireConfetti({ x: clickX, y: clickY, count: this.streak >= 3 ? 65 : 45 });

        // Mascot jumps with joy
        if (this.mascotAvatar) {
          this.mascotAvatar.classList.remove('jump', 'wobble');
          void this.mascotAvatar.offsetWidth;
          this.mascotAvatar.classList.add('jump');
        }

        // Mascot feedback & sounds based on streak
        if (this.streak >= 5) {
          playStreakSound(3);
          this.setMascotMood('fire', `🚀 ${this.streak} STREAK! SUPERCHARGED POWER! 🔥`);
        } else if (this.streak >= 3) {
          playStreakSound(2);
          this.setMascotMood('fire', `🔥 ${this.streak} In a Row! You're on FIRE! 🌟`);

          // Trigger live mid-quiz badge unlock for Streak Master!
          if (!this.streakMasterUnlocked) {
            this.streakMasterUnlocked = true;
            this.showBadgeUnlockToast({
              icon: '🔥',
              name: 'Streak Master Unlocked!',
              desc: '3 Correct answers in a row! Awesome combo!'
            });
          }
        } else if (this.streak >= 2) {
          playStreakSound(1);
          this.setMascotMood('excited', `⚡ 2 Streak! 1.5x Multiplier Active! 🎉`);
        } else {
          // Streak = 1 (First answer correct)
          playStreakSound(1);
          this.setMascotMood('excited', `🎉 Spot on! +1 Star! Streak started! ⭐`);
        }
      } else {
        this.hasMistake = true;
        this.streak = 0;

        playEncourageSound();

        // Mascot tilts with gentle encouragement
        if (this.mascotAvatar) {
          this.mascotAvatar.classList.remove('jump', 'wobble');
          void this.mascotAvatar.offsetWidth;
          this.mascotAvatar.classList.add('wobble');
        }

        const cheers = [
          "Don't worry! Try again, you can do it! 💙",
          "Almost had it! Mistakes help our brains grow! 🌟",
          "Shake it off, young innovator! Keep going! 🚀",
          "Good try! Focus and tap again! ⭐"
        ];
        this.setMascotMood('oops', cheers[Math.floor(Math.random() * cheers.length)]);
      }

      this.updateHUD();

      return {
        streak: this.streak,
        maxStreak: this.maxStreak,
        isCorrect
      };
    }

    showBadgeUnlockToast(badge) {
      playFanfareSound();
      fireConfetti({ count: 70, y: window.innerHeight * 0.25 });

      const toast = document.createElement('div');
      toast.className = 'fin-badge-toast';
      toast.innerHTML = `
        <span class="fin-badge-toast-icon">${badge.icon}</span>
        <div class="fin-badge-toast-content">
          <h4>${badge.name}</h4>
          <p>${badge.desc}</p>
        </div>
      `;
      document.body.appendChild(toast);

      setTimeout(() => {
        toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
        toast.style.opacity = '0';
        setTimeout(() => {
          if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
        }, 450);
      }, 3500);
    }

    /* ---------- Achievement Badges Generator (End Screen) ---------- */
    getUnlockedBadges(stats = {}) {
      const score = Number(stats.score) || 0;
      const total = Number(stats.total) || 15;
      const durationMs = Number(stats.durationMs) || 60000;
      const maxStreak = Number(stats.maxStreak !== undefined ? stats.maxStreak : this.maxStreak) || 0;
      const avgSec = durationMs / 1000 / Math.max(1, total);

      const badges = [];

      // 1. Sharpshooter (100% Score)
      if (score === total && total > 0) {
        badges.push({
          id: 'sharpshooter',
          icon: '🎯',
          name: 'Sharpshooter',
          desc: '100% Perfect Accuracy! Every single answer was spot on!',
          tag: 'Flawless'
        });
      }

      // 2. Speedstar (Avg <= 14s per question)
      if (avgSec <= 14 && score >= Math.ceil(total * 0.6)) {
        badges.push({
          id: 'speedstar',
          icon: '⚡',
          name: 'Speedstar',
          desc: `Lightning fast! Averaged ${avgSec.toFixed(1)}s per question!`,
          tag: 'Quick Mind'
        });
      }

      // 3. Streak Master (3+ consecutive correct)
      if (maxStreak >= 3 || this.streakMasterUnlocked) {
        badges.push({
          id: 'streak_master',
          icon: '🔥',
          name: 'Streak Master',
          desc: `Unstoppable streak of ${Math.max(3, maxStreak)} correct in a row!`,
          tag: 'Combo Pro'
        });
      }

      // 4. Comeback Hero (Missed at least one, but finished strong)
      if (score < total && score >= Math.ceil(total * 0.5)) {
        badges.push({
          id: 'perseverance',
          icon: '🛡️',
          name: 'Comeback Star',
          desc: 'Showed true grit, perseverance and finished strong!',
          tag: 'Resilient'
        });
      }

      // 5. Future Innovator (Scored at least 70%)
      if (score >= Math.ceil(total * 0.7) && score < total) {
        badges.push({
          id: 'innovator',
          icon: '🌟',
          name: 'Future Innovator',
          desc: 'Outstanding performance in computer tech mastery!',
          tag: 'High Achiever'
        });
      }

      // 6. First Launch (Always awarded for participating)
      if (badges.length < 2) {
        badges.push({
          id: 'first_launch',
          icon: '🚀',
          name: 'Young Pioneer',
          desc: 'Explored new technology ideas and completed the mission!',
          tag: 'Explorer'
        });
      }

      return badges;
    }

    renderBadges(containerOrId, stats = {}) {
      // Hide top HUD during finish screen so badges take center stage
      if (this.hudWrap) this.hudWrap.style.display = 'none';

      // Cheer the student on the finish screen
      this.setMascotMood('celebrate', "🏆 YOU DID IT! Check out your awesome badges! 🌟");

      const container = typeof containerOrId === 'string' ? document.getElementById(containerOrId) : containerOrId;
      if (!container) return;

      const badges = this.getUnlockedBadges(stats);
      if (!badges.length) return;

      playFanfareSound();
      fireConfetti({ count: 80, y: window.innerHeight * 0.35 });

      let wrap = container.querySelector('.fin-badges-section');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'fin-badges-section';
        container.appendChild(wrap);
      }

      wrap.innerHTML = `
        <h3 class="fin-badges-title">🏆 Achievement Badges Unlocked! 🌟</h3>
        <div class="fin-badges-grid">
          ${badges.map((b, i) => `
            <div class="fin-badge-card" style="animation-delay: ${i * 0.14}s">
              <span class="fin-badge-icon">${b.icon}</span>
              <h4 class="fin-badge-name">${b.name}</h4>
              <p class="fin-badge-desc">${b.desc}</p>
              <span class="fin-badge-tag">${b.tag}</span>
            </div>
          `).join('')}
        </div>
      `;
    }
  }

  // Global singleton
  root.Gamify = new GamifyController();
  root.Gamify.fireConfetti = fireConfetti;

})(window);
