'use client';

/**
 * A short two-tone notification chime synthesized with the Web Audio
 * API — no audio asset to ship, works offline, and the volume is
 * fixed low. Browsers block audio until the first user gesture, so
 * `unlockNotifySound()` primes the context on the first interaction
 * and `playNotifyTone()` is a no-op until then.
 */

let ctx: AudioContext | null = null;
let muted = false;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/** Call once from a user-gesture handler (pointerdown / keydown). */
export function unlockNotifySound(): void {
  const c = getCtx();
  if (c && c.state === 'suspended') void c.resume();
}

export function setNotifySoundMuted(value: boolean): void {
  muted = value;
}

export function playNotifyTone(): void {
  if (muted) return;
  const c = getCtx();
  if (!c || c.state !== 'running') return;

  const now = c.currentTime;
  const beep = (freq: number, start: number, dur: number) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(0.14, now + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(now + start);
    osc.stop(now + start + dur + 0.02);
  };
  beep(880, 0, 0.16); // A5
  beep(1174.66, 0.11, 0.22); // D6
}
