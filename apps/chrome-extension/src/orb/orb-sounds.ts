import { ORB_SOUNDS_KEY, orbFlag } from "@aeon/ui";

// Optional, off by default: a soft tone when a run starts, when it needs you, and when it's done.
// Synthesized, so there are no audio files to ship.

export type OrbSound = "start" | "needs" | "done";

const NOTES: Record<OrbSound, number[]> = {
  start: [523.25],
  needs: [659.25, 523.25],
  done: [523.25, 783.99],
};

let audio: AudioContext | undefined;

export function playSound(sound: OrbSound): void {
  if (!orbFlag(ORB_SOUNDS_KEY)) return;
  try {
    audio ??= new AudioContext();
    const start = audio.currentTime + 0.02;
    NOTES[sound].forEach((frequency, index) =>
      tone(audio as AudioContext, frequency, start + index * 0.12),
    );
  } catch {
    /* No audio output; the island still shows the change. */
  }
}

function tone(context: AudioContext, frequency: number, at: number): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.08, at + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + 0.25);
}
