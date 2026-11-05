// sound synthesizer using Web Audio API
class SoundEffects {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  playTone(freq, type = "sine", duration = 0.2, gainValue = 0.2, startTime = 0) {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    const t = this.ctx.currentTime + startTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);

    gain.gain.setValueAtTime(gainValue, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(t);
    osc.stop(t + duration);
  }

  // صوت إجابة صحيحة (نغمة صاعدة مبهجة)
  playCorrect() {
    this.playTone(523.25, "triangle", 0.15, 0.25, 0);       // C5
    this.playTone(659.25, "triangle", 0.15, 0.25, 0.12);    // E5
    this.playTone(783.99, "triangle", 0.35, 0.3, 0.24);     // G5
    this.playTone(1046.50, "sine", 0.45, 0.35, 0.36);       // C6
  }

  // صوت إجابة خاطئة (بوق منخفض)
  playWrong() {
    this.playTone(220, "sawtooth", 0.2, 0.2, 0);
    this.playTone(185, "sawtooth", 0.35, 0.25, 0.15);
  }

  // صوت تكتكة المؤقت
  playTick() {
    this.playTone(880, "sine", 0.04, 0.08);
  }

  // صوت فتح بطاقة السؤال
  playFlip() {
    this.playTone(440, "sine", 0.08, 0.15, 0);
    this.playTone(587.33, "triangle", 0.1, 0.2, 0.05);
  }

  // لحن الفوز النهائي
  playVictory() {
    const notes = [
      [523.25, 0.2],
      [523.25, 0.2],
      [523.25, 0.2],
      [659.25, 0.4],
      [587.33, 0.2],
      [523.25, 0.2],
      [659.25, 0.6],
    ];
    let offset = 0;
    notes.forEach(([freq, dur]) => {
      this.playTone(freq, "triangle", dur, 0.3, offset);
      offset += dur * 0.85;
    });
  }
}

export const sounds = new SoundEffects();
