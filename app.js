const APP_VERSION = "v1.1.0";
const FOCUS_SECONDS = 25 * 60;
const BREAK_SECONDS = 4 * 60;
const FOCUS_ALARM_FADE_SECONDS = 20;
const BREAK_RETURN_FADE_SECONDS = 60;

const PROFILES = {
  focus: {
    label: "Focus",
    beatHz: 14,
    carrierHz: 196,
    padRootHz: 196,
    description: "A brighter beta-range split for sustained attention, masked with a warm, steady pad.",
  },
  creativity: {
    label: "Creativity",
    beatHz: 8,
    carrierHz: 174,
    padRootHz: 174,
    description: "An alpha-leaning drift for associative thinking with a softer, airier harmonic bed.",
  },
  relaxation: {
    label: "Relaxation",
    beatHz: 5,
    carrierHz: 160,
    padRootHz: 160,
    description: "A slower theta-side split with a gentler envelope and deeper, more meditative masking.",
  },
};

const State = Object.freeze({
  IDLE: "idle",
  FOCUS: "focus",
  FOCUS_DONE: "focus_done",
  BREAK: "break",
  BREAK_DONE: "break_done",
});

class SoundEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.masterTone = null;
    this.mixNodes = null;
    this.levels = {
      master: 0.86,
      focus: 1,
      binaural: 1,
      pads: 1,
      alarm: 1,
      breakAmbient: 1,
      cue: 1,
    };
    this.brownNoiseBuffer = null;
    this.focusLayer = null;
    this.focusAlarmLayer = null;
    this.breakAmbientLayer = null;
    this.breakReturnCueLayer = null;
  }

  clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  async ensureContext() {
    if (!this.ctx) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("Web Audio API is not available in this browser.");
      }
      this.ctx = new AudioContextCtor();
      this.master = this.ctx.createGain();
      this.masterTone = this.ctx.createBiquadFilter();
      this.masterTone.type = "lowpass";
      this.masterTone.frequency.value = 13500;
      this.masterTone.Q.value = 0.2;
      this.master.gain.value = this.levels.master;

      this.mixNodes = {
        focus: this.ctx.createGain(),
        alarm: this.ctx.createGain(),
        breakAmbient: this.ctx.createGain(),
        cue: this.ctx.createGain(),
      };

      this.mixNodes.focus.gain.value = this.levels.focus;
      this.mixNodes.alarm.gain.value = this.levels.alarm;
      this.mixNodes.breakAmbient.gain.value = this.levels.breakAmbient;
      this.mixNodes.cue.gain.value = this.levels.cue;

      this.mixNodes.focus.connect(this.master);
      this.mixNodes.alarm.connect(this.master);
      this.mixNodes.breakAmbient.connect(this.master);
      this.mixNodes.cue.connect(this.master);

      this.master.connect(this.masterTone);
      this.masterTone.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  setMasterLevel(level) {
    this.levels.master = this.clamp01(level);
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.levels.master, this.ctx.currentTime, 0.08);
    }
  }

  setMixLevel(name, level) {
    const clamped = this.clamp01(level);
    if (!(name in this.levels)) {
      return;
    }
    this.levels[name] = clamped;
    if (this.ctx && this.mixNodes?.[name]) {
      this.mixNodes[name].gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.08);
    }
    if (this.ctx && name === "binaural" && this.focusLayer?.binauralGroupGain) {
      this.focusLayer.binauralGroupGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.08);
    }
    if (this.ctx && name === "pads" && this.focusLayer?.padsGroupGain) {
      this.focusLayer.padsGroupGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.08);
    }
  }

  connectLayerBus(bus, mixName) {
    if (this.mixNodes?.[mixName]) {
      bus.connect(this.mixNodes[mixName]);
      return;
    }
    bus.connect(this.master);
  }

  buildBrownNoiseBuffer(durationSeconds = 4) {
    const frameCount = Math.floor(this.ctx.sampleRate * durationSeconds);
    const buffer = this.ctx.createBuffer(2, frameCount, this.ctx.sampleRate);

    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      let lastOut = 0;
      for (let i = 0; i < frameCount; i += 1) {
        const white = Math.random() * 2 - 1;
        lastOut = (lastOut + 0.025 * white) / 1.025;
        data[i] = lastOut * 2.95;
      }
    }
    return buffer;
  }

  createBrownNoiseSource() {
    if (!this.brownNoiseBuffer) {
      this.brownNoiseBuffer = this.buildBrownNoiseBuffer();
    }
    const source = this.ctx.createBufferSource();
    source.buffer = this.brownNoiseBuffer;
    source.loop = true;
    return source;
  }

  createPanNode(panValue) {
    if (typeof this.ctx.createStereoPanner === "function") {
      const pan = this.ctx.createStereoPanner();
      pan.pan.value = panValue;
      return pan;
    }

    const panner = this.ctx.createPanner();
    panner.panningModel = "equalpower";
    if ("positionX" in panner) {
      panner.positionX.value = panValue;
      panner.positionY.value = 0;
      panner.positionZ.value = 1 - Math.abs(panValue);
    } else if (typeof panner.setPosition === "function") {
      panner.setPosition(panValue, 0, 1 - Math.abs(panValue));
    }
    return panner;
  }

  stopLayer(layer, fadeSeconds = 2) {
    if (!layer || !this.ctx) {
      return;
    }
    const now = this.ctx.currentTime;
    if (layer.gainNode?.gain) {
      const gainParam = layer.gainNode.gain;
      gainParam.cancelScheduledValues(now);
      gainParam.setValueAtTime(gainParam.value, now);
      gainParam.linearRampToValueAtTime(0.0001, now + fadeSeconds);
    }
    const stopAt = now + fadeSeconds + 0.1;
    (layer.oscillators || []).forEach((osc) => {
      try {
        osc.stop(stopAt);
      } catch (_err) {
        // Oscillator already stopped.
      }
    });
    (layer.sources || []).forEach((source) => {
      try {
        source.stop(stopAt);
      } catch (_err) {
        // Source already stopped.
      }
    });
    window.setTimeout(() => {
      (layer.nodes || []).forEach((node) => {
        try {
          node.disconnect();
        } catch (_err) {
          // Node may already be disconnected.
        }
      });
    }, Math.max(250, (fadeSeconds + 0.4) * 1000));
  }

  async startFocus(profile) {
    await this.ensureContext();
    this.stopLayer(this.breakAmbientLayer, 2);
    this.stopLayer(this.breakReturnCueLayer, 2);
    this.stopLayer(this.focusAlarmLayer, 1.5);
    this.stopLayer(this.focusLayer, 1.5);
    this.breakAmbientLayer = null;
    this.breakReturnCueLayer = null;
    this.focusAlarmLayer = null;
    this.focusLayer = this.buildFocusLayer(profile);
  }

  async startFocusAlarm() {
    await this.ensureContext();
    if (this.focusAlarmLayer) {
      return;
    }
    this.focusAlarmLayer = this.buildFocusAlarmLayer();
  }

  async startBreak(profile) {
    await this.ensureContext();
    this.stopLayer(this.focusLayer, 2.6);
    this.stopLayer(this.focusAlarmLayer, 3.2);
    this.stopLayer(this.breakAmbientLayer, 1.2);
    this.stopLayer(this.breakReturnCueLayer, 1.2);
    this.focusLayer = null;
    this.focusAlarmLayer = null;
    this.breakAmbientLayer = null;
    this.breakReturnCueLayer = null;
    this.playHarmonicCue(profile, {
      attackSeconds: 0.45,
      holdSeconds: 1.2,
      releaseSeconds: 2.5,
      peak: 0.2,
    });
    this.breakAmbientLayer = this.buildBreakAmbientLayer();
  }

  async startBreakReturnCue(profile, rampSeconds = BREAK_RETURN_FADE_SECONDS) {
    await this.ensureContext();
    if (this.breakReturnCueLayer) {
      return;
    }
    this.breakReturnCueLayer = this.buildBreakReturnCueLayer(profile, rampSeconds);
  }

  stopAll(fadeSeconds = 2) {
    this.stopLayer(this.focusLayer, fadeSeconds);
    this.stopLayer(this.focusAlarmLayer, fadeSeconds);
    this.stopLayer(this.breakAmbientLayer, fadeSeconds);
    this.stopLayer(this.breakReturnCueLayer, fadeSeconds);
    this.focusLayer = null;
    this.focusAlarmLayer = null;
    this.breakAmbientLayer = null;
    this.breakReturnCueLayer = null;
  }

  buildFocusLayer(profile) {
    const now = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.value = 0;
    const binauralGroupGain = this.ctx.createGain();
    const padsGroupGain = this.ctx.createGain();
    binauralGroupGain.gain.value = this.levels.binaural;
    padsGroupGain.gain.value = this.levels.pads;

    const padFilter = this.ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 1500;
    padFilter.Q.value = 0.85;

    const padFilterLfo = this.ctx.createOscillator();
    const padFilterDepth = this.ctx.createGain();
    padFilterLfo.frequency.value = 0.055;
    padFilterDepth.gain.value = 260;

    padFilterLfo.connect(padFilterDepth);
    padFilterDepth.connect(padFilter.frequency);

    const shimmerLfo = this.ctx.createOscillator();
    const shimmerDepth = this.ctx.createGain();
    shimmerLfo.frequency.value = 0.11;
    shimmerDepth.gain.value = 0.015;

    shimmerLfo.connect(shimmerDepth);
    shimmerDepth.connect(bus.gain);

    padFilter.connect(bus);
    this.connectLayerBus(bus, "focus");

    const carrier = profile.carrierHz;
    const beat = profile.beatHz;

    const leftOsc = this.ctx.createOscillator();
    const rightOsc = this.ctx.createOscillator();
    leftOsc.type = "sine";
    rightOsc.type = "sine";
    leftOsc.frequency.value = carrier - beat / 2;
    rightOsc.frequency.value = carrier + beat / 2;

    const leftGain = this.ctx.createGain();
    const rightGain = this.ctx.createGain();
    leftGain.gain.value = 0.062;
    rightGain.gain.value = 0.062;

    const leftPan = this.createPanNode(-1);
    const rightPan = this.createPanNode(1);

    leftOsc.connect(leftGain);
    rightOsc.connect(rightGain);
    leftGain.connect(leftPan);
    rightGain.connect(rightPan);
    leftPan.connect(binauralGroupGain);
    rightPan.connect(binauralGroupGain);
    binauralGroupGain.connect(padFilter);

    const padRatios = [1, 1.25, 1.5, 2];
    const padTypes = ["triangle", "sawtooth", "triangle", "triangle"];
    const padOscs = [];
    const padGains = [];

    padRatios.forEach((ratio, index) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = padTypes[index % padTypes.length];
      osc.frequency.value = profile.padRootHz * ratio;
      osc.detune.value = (index - 1.5) * 5.4;
      gain.gain.value = 0.034 / (1 + index * 0.3);
      osc.connect(gain);
      gain.connect(padsGroupGain);
      padOscs.push(osc);
      padGains.push(gain);
    });
    padsGroupGain.connect(padFilter);

    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(0.29, now + 6);

    padFilterLfo.start(now);
    shimmerLfo.start(now);
    leftOsc.start(now);
    rightOsc.start(now);
    padOscs.forEach((osc) => osc.start(now));

    return {
      gainNode: bus,
      binauralGroupGain,
      padsGroupGain,
      oscillators: [padFilterLfo, shimmerLfo, leftOsc, rightOsc, ...padOscs],
      nodes: [
        bus,
        binauralGroupGain,
        padsGroupGain,
        padFilter,
        padFilterDepth,
        shimmerDepth,
        leftGain,
        rightGain,
        leftPan,
        rightPan,
        ...padGains,
      ],
    };
  }

  buildFocusAlarmLayer() {
    const now = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.value = 0;

    const highpass = this.ctx.createBiquadFilter();
    const lowpass = this.ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 95;
    lowpass.type = "lowpass";
    lowpass.frequency.value = 520;
    lowpass.Q.value = 1.2;

    const filterLfo = this.ctx.createOscillator();
    const filterDepth = this.ctx.createGain();
    filterLfo.type = "sine";
    filterLfo.frequency.value = 0.16;
    filterDepth.gain.value = 240;
    filterLfo.connect(filterDepth);
    filterDepth.connect(lowpass.frequency);

    const source = this.createBrownNoiseSource();
    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(bus);
    this.connectLayerBus(bus, "alarm");

    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(0.19, now + FOCUS_ALARM_FADE_SECONDS);

    source.start(now);
    filterLfo.start(now);

    return {
      gainNode: bus,
      oscillators: [filterLfo],
      sources: [source],
      nodes: [bus, highpass, lowpass, filterDepth],
    };
  }

  buildBreakAmbientLayer() {
    const now = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.value = 0;

    const highpass = this.ctx.createBiquadFilter();
    const lowpass = this.ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 72;
    lowpass.type = "lowpass";
    lowpass.frequency.value = 760;
    lowpass.Q.value = 0.65;

    const waveLfo = this.ctx.createOscillator();
    const waveDepth = this.ctx.createGain();
    waveLfo.frequency.value = 0.072;
    waveDepth.gain.value = 0.013;
    waveLfo.connect(waveDepth);
    waveDepth.connect(bus.gain);

    const filterLfo = this.ctx.createOscillator();
    const filterDepth = this.ctx.createGain();
    filterLfo.frequency.value = 0.035;
    filterDepth.gain.value = 220;
    filterLfo.connect(filterDepth);
    filterDepth.connect(lowpass.frequency);

    const source = this.createBrownNoiseSource();
    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(bus);
    this.connectLayerBus(bus, "breakAmbient");

    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(0.032, now + 5);

    source.start(now);
    waveLfo.start(now);
    filterLfo.start(now);

    return {
      gainNode: bus,
      oscillators: [waveLfo, filterLfo],
      sources: [source],
      nodes: [bus, highpass, lowpass, waveDepth, filterDepth],
    };
  }

  buildBreakReturnCueLayer(profile, rampSeconds) {
    const now = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.value = 0;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2500;
    filter.Q.value = 0.45;

    const tremolo = this.ctx.createOscillator();
    const tremoloDepth = this.ctx.createGain();
    tremolo.frequency.value = 0.05;
    tremoloDepth.gain.value = 0.012;
    tremolo.connect(tremoloDepth);
    tremoloDepth.connect(bus.gain);

    const base = profile.padRootHz * 0.72;
    const ratios = [1, 1.5, 2, 2.5, 3, 4];
    const partialOscs = [];
    const partialGains = [];

    ratios.forEach((ratio, index) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = index < 2 ? "triangle" : "sine";
      osc.frequency.value = base * ratio;
      osc.detune.value = (Math.random() * 2 - 1) * 4;
      gain.gain.value = 0.048 / Math.pow(ratio, 1.03);
      osc.connect(gain);
      gain.connect(filter);
      partialOscs.push(osc);
      partialGains.push(gain);
    });

    filter.connect(bus);
    this.connectLayerBus(bus, "cue");

    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(0.16, now + Math.max(2, rampSeconds));

    tremolo.start(now);
    partialOscs.forEach((osc) => osc.start(now));

    return {
      gainNode: bus,
      oscillators: [tremolo, ...partialOscs],
      nodes: [bus, filter, tremoloDepth, ...partialGains],
    };
  }

  playHarmonicCue(profile, envelope) {
    if (!this.ctx || !this.master) {
      return;
    }

    const now = this.ctx.currentTime;
    const attack = envelope.attackSeconds;
    const hold = envelope.holdSeconds;
    const release = envelope.releaseSeconds;
    const peak = envelope.peak;
    const total = attack + hold + release;

    const bus = this.ctx.createGain();
    bus.gain.value = 0;

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2900;
    filter.Q.value = 0.34;

    const base = profile.padRootHz * 0.78;
    const ratios = [1, 1.5, 2, 2.5, 3.25];
    const oscs = [];
    const gains = [];

    ratios.forEach((ratio, index) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = index < 2 ? "triangle" : "sine";
      osc.frequency.value = base * ratio;
      gain.gain.value = 0.052 / Math.pow(ratio, 1.08);
      osc.connect(gain);
      gain.connect(filter);
      oscs.push(osc);
      gains.push(gain);
    });

    filter.connect(bus);
    this.connectLayerBus(bus, "cue");

    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(peak, now + attack);
    bus.gain.linearRampToValueAtTime(peak * 0.34, now + attack + hold);
    bus.gain.linearRampToValueAtTime(0.0001, now + total);

    oscs.forEach((osc) => osc.start(now));
    oscs.forEach((osc) => osc.stop(now + total + 0.05));

    window.setTimeout(() => {
      [...oscs, ...gains, filter, bus].forEach((node) => {
        try {
          node.disconnect();
        } catch (_err) {
          // Node may already be disconnected.
        }
      });
    }, (total + 0.4) * 1000);
  }
}

const ui = {
  intentionInput: document.getElementById("intentionInput"),
  profileSelect: document.getElementById("profileSelect"),
  phaseLabel: document.getElementById("phaseLabel"),
  timerDisplay: document.getElementById("timerDisplay"),
  statusText: document.getElementById("statusText"),
  intentionPreview: document.getElementById("intentionPreview"),
  enableAudioBtn: document.getElementById("enableAudioBtn"),
  startFocusBtn: document.getElementById("startFocusBtn"),
  startBreakBtn: document.getElementById("startBreakBtn"),
  startNextFocusBtn: document.getElementById("startNextFocusBtn"),
  transitionEarlyBtn: document.getElementById("transitionEarlyBtn"),
  resetBtn: document.getElementById("resetBtn"),
  profileHz: document.getElementById("profileHz"),
  profileDescription: document.getElementById("profileDescription"),
  appVersion: document.getElementById("appVersion"),
  masterSlider: document.getElementById("masterSlider"),
  masterValue: document.getElementById("masterValue"),
  focusSlider: document.getElementById("focusSlider"),
  focusValue: document.getElementById("focusValue"),
  binauralSlider: document.getElementById("binauralSlider"),
  binauralValue: document.getElementById("binauralValue"),
  padsSlider: document.getElementById("padsSlider"),
  padsValue: document.getElementById("padsValue"),
  alarmSlider: document.getElementById("alarmSlider"),
  alarmValue: document.getElementById("alarmValue"),
  breakAmbientSlider: document.getElementById("breakAmbientSlider"),
  breakAmbientValue: document.getElementById("breakAmbientValue"),
  cueSlider: document.getElementById("cueSlider"),
  cueValue: document.getElementById("cueValue"),
};

const sound = new SoundEngine();

let state = State.IDLE;
let audioEnabled = false;
let tickerId = null;
let focusEndAt = 0;
let breakEndAt = 0;
let focusAlarmTimeoutId = null;
let breakCueTimeoutId = null;

const MIXER_BINDINGS = [
  { slider: "masterSlider", value: "masterValue", target: "master" },
  { slider: "focusSlider", value: "focusValue", target: "focus" },
  { slider: "binauralSlider", value: "binauralValue", target: "binaural" },
  { slider: "padsSlider", value: "padsValue", target: "pads" },
  { slider: "alarmSlider", value: "alarmValue", target: "alarm" },
  { slider: "breakAmbientSlider", value: "breakAmbientValue", target: "breakAmbient" },
  { slider: "cueSlider", value: "cueValue", target: "cue" },
];

function getProfile() {
  return PROFILES[ui.profileSelect.value] || PROFILES.focus;
}

function sliderPercentToGain(percent) {
  return Math.pow(Math.max(0, Math.min(100, percent)) / 100, 1.15);
}

function updateSliderReadout(element, percent) {
  element.textContent = `${Math.round(percent)}%`;
}

function applyMixerBinding(binding) {
  const sliderEl = ui[binding.slider];
  const valueEl = ui[binding.value];
  const percent = Number(sliderEl.value);
  updateSliderReadout(valueEl, percent);
  const gain = sliderPercentToGain(percent);
  if (binding.target === "master") {
    sound.setMasterLevel(gain);
  } else {
    sound.setMixLevel(binding.target, gain);
  }
}

function applyMixerValues() {
  MIXER_BINDINGS.forEach(applyMixerBinding);
}

function formatClock(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function setTimer(seconds) {
  ui.timerDisplay.textContent = formatClock(seconds);
}

function setStatus(message) {
  ui.statusText.textContent = message;
}

function setPhaseLabel(text) {
  ui.phaseLabel.textContent = text;
}

function setVisualState(nextState) {
  document.body.dataset.phase = nextState;
}

function updateIntentionPreview() {
  const value = ui.intentionInput.value.trim();
  ui.intentionPreview.textContent = value ? `Current intention: "${value}"` : "No intention set yet.";
}

function updateProfileCard() {
  const profile = getProfile();
  const left = (profile.carrierHz - profile.beatHz / 2).toFixed(1);
  const right = (profile.carrierHz + profile.beatHz / 2).toFixed(1);
  ui.profileHz.textContent = `${profile.beatHz.toFixed(1)} Hz split (${left} Hz left / ${right} Hz right)`;
  ui.profileDescription.textContent = profile.description;
}

function updateTransitionButton() {
  const isTransitionState = state === State.FOCUS || state === State.BREAK;
  ui.transitionEarlyBtn.hidden = !isTransitionState;
  if (state === State.FOCUS) {
    ui.transitionEarlyBtn.textContent = "Transition To Focus End Cue";
  } else if (state === State.BREAK) {
    ui.transitionEarlyBtn.textContent = "Transition To Break End Cue";
  }
}

function renderAudioState() {
  ui.enableAudioBtn.hidden = audioEnabled;
  ui.startFocusBtn.disabled = !audioEnabled;
  ui.startBreakBtn.disabled = !audioEnabled;
  ui.startNextFocusBtn.disabled = !audioEnabled;
  ui.transitionEarlyBtn.disabled = !audioEnabled;
}

function renderButtons() {
  ui.startFocusBtn.hidden = state !== State.IDLE;
  ui.startBreakBtn.hidden = state !== State.FOCUS_DONE;
  ui.startNextFocusBtn.hidden = state !== State.BREAK_DONE;
  updateTransitionButton();
  renderAudioState();
}

function clearRuntimeTimers() {
  if (tickerId !== null) {
    window.clearInterval(tickerId);
    tickerId = null;
  }
  if (focusAlarmTimeoutId !== null) {
    window.clearTimeout(focusAlarmTimeoutId);
    focusAlarmTimeoutId = null;
  }
  if (breakCueTimeoutId !== null) {
    window.clearTimeout(breakCueTimeoutId);
    breakCueTimeoutId = null;
  }
  focusEndAt = 0;
  breakEndAt = 0;
}

function tick() {
  const now = Date.now();
  if (state === State.FOCUS) {
    const remaining = (focusEndAt - now) / 1000;
    if (remaining <= 0) {
      completeFocus();
      return;
    }
    setTimer(remaining);
  } else if (state === State.BREAK) {
    const remaining = (breakEndAt - now) / 1000;
    if (remaining <= 0) {
      completeBreak();
      return;
    }
    setTimer(remaining);
  }
}

function requireAudioEnabled() {
  if (audioEnabled) {
    return true;
  }
  setStatus("Tap To Enable Audio first. Mobile browsers require this before synthesis can play.");
  return false;
}

async function enableAudio() {
  await sound.ensureContext();
  audioEnabled = true;
  applyMixerValues();
  renderAudioState();
  if (state === State.IDLE) {
    setStatus("Audio enabled. Press Start Focus to begin.");
  }
}

async function startFocus() {
  if (state === State.FOCUS || state === State.BREAK) {
    return;
  }
  if (!requireAudioEnabled()) {
    return;
  }

  clearRuntimeTimers();
  const profile = getProfile();
  await sound.startFocus(profile);
  state = State.FOCUS;
  setVisualState(state);
  renderButtons();
  setPhaseLabel("Focus Session");
  const intention = ui.intentionInput.value.trim();
  setStatus(
    intention
      ? `Focusing on "${intention}". Binaural split and pads are active.`
      : "Focus session started. Binaural split and pads are active."
  );

  setTimer(FOCUS_SECONDS);
  focusEndAt = Date.now() + FOCUS_SECONDS * 1000;
  const alarmDelay = Math.max(0, (FOCUS_SECONDS - FOCUS_ALARM_FADE_SECONDS) * 1000);
  focusAlarmTimeoutId = window.setTimeout(() => {
    sound.startFocusAlarm().catch((error) => {
      console.error(error);
      setStatus("Could not start the focus end cue. Try pressing Start Focus again.");
    });
  }, alarmDelay);

  tickerId = window.setInterval(tick, 250);
}

function completeFocus() {
  if (state !== State.FOCUS) {
    return;
  }
  if (tickerId !== null) {
    window.clearInterval(tickerId);
    tickerId = null;
  }
  if (focusAlarmTimeoutId !== null) {
    window.clearTimeout(focusAlarmTimeoutId);
    focusAlarmTimeoutId = null;
  }
  state = State.FOCUS_DONE;
  setVisualState(state);
  renderButtons();
  setTimer(0);
  setPhaseLabel("Focus Complete");
  setStatus("Focus block complete. Press Start Break when ready.");
  sound.startFocusAlarm().catch((error) => {
    console.error(error);
  });
}

async function startBreak() {
  if (state !== State.FOCUS_DONE) {
    return;
  }
  if (!requireAudioEnabled()) {
    return;
  }
  if (focusAlarmTimeoutId !== null) {
    window.clearTimeout(focusAlarmTimeoutId);
    focusAlarmTimeoutId = null;
  }

  const profile = getProfile();
  await sound.startBreak(profile);
  state = State.BREAK;
  setVisualState(state);
  renderButtons();
  setPhaseLabel("Break Session");
  setStatus("Break started. Ocean-like ambience is active. The harmonic return cue blooms near the end.");

  setTimer(BREAK_SECONDS);
  breakEndAt = Date.now() + BREAK_SECONDS * 1000;
  const cueDelay = Math.max(0, (BREAK_SECONDS - BREAK_RETURN_FADE_SECONDS) * 1000);
  breakCueTimeoutId = window.setTimeout(() => {
    sound.startBreakReturnCue(profile, BREAK_RETURN_FADE_SECONDS).catch((error) => {
      console.error(error);
    });
  }, cueDelay);

  tickerId = window.setInterval(tick, 250);
}

function completeBreak() {
  if (state !== State.BREAK) {
    return;
  }
  if (tickerId !== null) {
    window.clearInterval(tickerId);
    tickerId = null;
  }
  if (breakCueTimeoutId !== null) {
    window.clearTimeout(breakCueTimeoutId);
    breakCueTimeoutId = null;
  }
  state = State.BREAK_DONE;
  setVisualState(state);
  renderButtons();
  setTimer(0);
  setPhaseLabel("Break Complete");
  setStatus("Break complete. Press Start Next Focus when ready.");

  sound.startBreakReturnCue(getProfile(), 8).catch((error) => {
    console.error(error);
  });
}

async function startNextFocus() {
  if (state !== State.BREAK_DONE) {
    return;
  }
  await startFocus();
}

async function transitionToEndCue() {
  if (!requireAudioEnabled()) {
    return;
  }
  if (state === State.FOCUS) {
    const remaining = Math.max(0, (focusEndAt - Date.now()) / 1000);
    if (focusAlarmTimeoutId !== null) {
      window.clearTimeout(focusAlarmTimeoutId);
      focusAlarmTimeoutId = null;
    }
    await sound.startFocusAlarm();
    if (remaining > FOCUS_ALARM_FADE_SECONDS + 0.2) {
      focusEndAt = Date.now() + FOCUS_ALARM_FADE_SECONDS * 1000;
      setStatus("Transitioning to focus end cue now (about 20 seconds).");
    } else {
      setStatus("Focus session is already in its final transition.");
    }
    tick();
    return;
  }

  if (state === State.BREAK) {
    const remaining = Math.max(0, (breakEndAt - Date.now()) / 1000);
    if (breakCueTimeoutId !== null) {
      window.clearTimeout(breakCueTimeoutId);
      breakCueTimeoutId = null;
    }
    const ramp = remaining > BREAK_RETURN_FADE_SECONDS ? BREAK_RETURN_FADE_SECONDS : Math.max(8, remaining);
    await sound.startBreakReturnCue(getProfile(), ramp);
    if (remaining > BREAK_RETURN_FADE_SECONDS + 0.2) {
      breakEndAt = Date.now() + BREAK_RETURN_FADE_SECONDS * 1000;
      setStatus("Transitioning to break end cue now (about 1 minute).");
    } else {
      setStatus("Break session is already in its final transition.");
    }
    tick();
  }
}

function resetTimer() {
  clearRuntimeTimers();
  state = State.IDLE;
  setVisualState(state);
  renderButtons();
  setPhaseLabel("Ready");
  setTimer(FOCUS_SECONDS);
  setStatus(
    audioEnabled
      ? "Press Start Focus to begin your first block."
      : "Tap To Enable Audio first, then press Start Focus."
  );
  sound.stopAll(1.8);
}

function runWithGuard(asyncFn) {
  asyncFn().catch((error) => {
    console.error(error);
    setStatus("Audio could not be started. Tap Enable Audio and try again.");
  });
}

ui.intentionInput.addEventListener("input", updateIntentionPreview);

ui.profileSelect.addEventListener("change", () => {
  updateProfileCard();
});

ui.enableAudioBtn.addEventListener("click", () => {
  runWithGuard(enableAudio);
});

ui.startFocusBtn.addEventListener("click", () => {
  runWithGuard(startFocus);
});

ui.startBreakBtn.addEventListener("click", () => {
  runWithGuard(startBreak);
});

ui.startNextFocusBtn.addEventListener("click", () => {
  runWithGuard(startNextFocus);
});

ui.transitionEarlyBtn.addEventListener("click", () => {
  runWithGuard(transitionToEndCue);
});

ui.resetBtn.addEventListener("click", resetTimer);

MIXER_BINDINGS.forEach((binding) => {
  ui[binding.slider].addEventListener("input", () => {
    applyMixerBinding(binding);
  });
});

ui.appVersion.textContent = APP_VERSION;
updateIntentionPreview();
updateProfileCard();
applyMixerValues();
resetTimer();
