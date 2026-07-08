// WebAudioによる手続き音源。外部アセットを持たず、すべてその場で合成する。
// ブラウザの自動再生制限のため、最初のユーザー操作で resume() を呼んで
// AudioContext を起動する(それまでの再生要求は無視される)。

const MUTE_KEY = 'semifab.muted';

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
  }

  // 最初のユーザー操作で呼ぶ。以降は何度呼んでも安全
  resume() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return; // WebAudio非対応環境では黙って無効化
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(this.ctx.destination);
      this.startAmbient();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch { /* 保存できなくても動作は続ける */ }
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05);
    }
  }

  // FFUの低い送風音: ループするノイズ+ローパス
  private startAmbient() {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < len; i++) {
      brown = (brown + (Math.random() * 2 - 1) * 0.02) * 0.996;
      data[i] = brown * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    this.ambientGain = ctx.createGain();
    this.ambientGain.gain.value = 0.05;
    src.connect(lp).connect(this.ambientGain).connect(this.master!);
    src.start();
  }

  // 単発トーン(エンベロープ付き)
  private tone(
    freq: number, dur: number, type: OscillatorType, gain: number,
    delay = 0, glideTo?: number,
  ) {
    if (!this.ctx || !this.master || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // ノイズバースト(設置音などの「ゴトッ」)
  private thud(dur: number, cutoff: number, gain: number) {
    if (!this.ctx || !this.master || this.muted) return;
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
  }

  click() { this.tone(1250, 0.05, 'triangle', 0.08); }
  place() {
    this.thud(0.14, 700, 0.5);
    this.tone(130, 0.16, 'sine', 0.25);
  }
  rail() { this.tone(880, 0.05, 'square', 0.05); }
  deny() { this.tone(180, 0.16, 'sawtooth', 0.12, 0, 130); }
  chime() {
    this.tone(660, 0.14, 'sine', 0.16);
    this.tone(990, 0.22, 'sine', 0.14, 0.09);
  }
  unlock() {
    this.tone(520, 0.12, 'sine', 0.15);
    this.tone(660, 0.12, 'sine', 0.15, 0.1);
    this.tone(880, 0.26, 'sine', 0.15, 0.2);
  }
  alarm() {
    this.tone(440, 0.12, 'square', 0.09);
    this.tone(440, 0.12, 'square', 0.09, 0.18);
  }
}

export const sound = new Sound();
