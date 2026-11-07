import { Framer, type AudioFrame, type FrameOptions } from "./frames.ts";
import { CueTracker, type Cue, type ListenOptions } from "./cues.ts";
import type { WavAudio } from "../audio/wav.ts";

/**
 * The live half of the listening layer.
 *
 * The offline path (framesFromWav + judge) sees the whole clip at once. A live
 * caller cannot: audio arrives in chunks and the character has to react inside
 * the 300ms budget, not after the sentence is over. So this class runs one
 * Framer and one CueTracker incrementally, which is the same pair the offline
 * path uses — the cues agree by construction, and test/listen.test.ts asserts it
 * on synthetic audio rather than trusting the claim.
 *
 * Barge-in is the other half and it is deliberately not a cue. A cue cannot fire
 * before 220ms, and by then the character has already talked over the user. So
 * the listener watches raw frames and fires `barge-in` on the first voiced frame
 * above the floor: a 20ms decision, not a 220ms one.
 */

export type ListenEvent =
  | { type: "cue"; cue: Cue }
  /** The user started talking while the character was speaking. */
  | { type: "barge-in"; at: number; rms: number };

export interface ListenerOptions {
  frames?: FrameOptions;
  cues?: ListenOptions;
  /** RMS above which a frame can interrupt. Defaults to silenceRms * 2.5. */
  bargeInRms?: number;
}

export class Listener {
  private readonly sampleRate: number | null;
  private readonly framer: Framer | null;
  private readonly tracker: CueTracker;
  private readonly bargeInRms: number;
  private speaking = false;
  private interrupted = false;
  private lastAt = Number.NaN;

  constructor(sampleRate: number | null = null, opts: ListenerOptions = {}) {
    this.sampleRate = sampleRate;
    this.framer = sampleRate === null ? null : new Framer(sampleRate, opts.frames ?? {});
    this.tracker = new CueTracker(opts.cues ?? {});
    const floor = opts.cues?.silenceRms ?? 0.01;
    this.bargeInRms = opts.bargeInRms ?? floor * 2.5;
  }

  /** Tell the listener what the character is doing right now. */
  setSpeaking(speaking: boolean): void {
    if (speaking !== this.speaking) this.interrupted = false;
    this.speaking = speaking;
  }

  /** Feed one analysis frame you already have. */
  pushFrame(frame: AudioFrame): ListenEvent[] {
    this.lastAt = frame.at;
    return this.reactTo(frame, this.tracker.push(frame));
  }

  /** Feed mono PCM in any chunk size. Frames are cut on the stream grid. */
  pushPcm(samples: Float32Array, sampleRate?: number): ListenEvent[] {
    const framer = this.framer;
    if (!framer) {
      throw new Error("Listener needs a sample rate at construction before pushPcm");
    }
    if (sampleRate !== undefined && sampleRate !== this.sampleRate) {
      throw new Error(
        "pushPcm got " + sampleRate + "Hz but the listener was built for " + this.sampleRate + "Hz",
      );
    }
    const events: ListenEvent[] = [];
    for (const frame of framer.push(samples)) {
      if (frame.at <= this.lastAt) continue;
      events.push(...this.pushFrame(frame));
    }
    return events;
  }

  flush(): ListenEvent[] {
    const events: ListenEvent[] = [];
    if (this.framer) {
      for (const frame of this.framer.flush()) {
        if (frame.at <= this.lastAt) continue;
        events.push(...this.pushFrame(frame));
      }
    }
    for (const cue of this.tracker.flush()) events.push({ type: "cue", cue });
    return events;
  }

  /** Everything decided so far. */
  get cues(): Cue[] {
    return this.tracker.cues;
  }

  private reactTo(frame: AudioFrame, cues: Cue[]): ListenEvent[] {
    const events: ListenEvent[] = [];
    if (this.speaking && !this.interrupted && frame.voiced && frame.rms > this.bargeInRms) {
      this.interrupted = true;
      events.push({ type: "barge-in", at: frame.at, rms: frame.rms });
    }
    for (const cue of cues) events.push({ type: "cue", cue });
    return events;
  }
}

/** Offline convenience: a whole clip -> every event, in time order. */
export function listenTo(audio: WavAudio, opts: ListenerOptions = {}): ListenEvent[] {
  const listener = new Listener(audio.sampleRate, opts);
  const events = listener.pushPcm(audio.samples);
  events.push(...listener.flush());
  return events;
}