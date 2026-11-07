import type { AudioFrame } from "./frames.ts";
import type { Cue } from "./cues.ts";
import type { Gesture } from "../render/gesture.ts";
import { Listener, type ListenerOptions, type ListenEvent } from "./listener.ts";
import { mapCues, type RenderMapping, DEFAULT_MAPPING } from "../render/mapping.ts";
import type { EngineState } from "../types.ts";

/**
 * The three-state gate. What the microphone means depends entirely on what the
 * character is doing, and conflating the three is the single most common way a
 * talking avatar ends up interrupting itself:
 *
 *   listening  The user has the floor. Frames become cues, cues become gestures.
 *   thinking   A short, closed window (a few hundred ms). The mic is ignored. Any
 *              reaction here is a reaction to the user's echo or the tail of
 *              their own breath, and it will land on top of the reply.
 *   speaking   The character has the floor. Frames are not interpreted at all;
 *              the only thing worth detecting is the user cutting in, and that
 *              must be detected in tens of milliseconds rather than in the
 *              couple of hundred a cue takes.
 *
 * The gate is one-way on purpose: a barge-in does not stop the speech here. It
 * reports, and the transport that owns the audio output decides whether to kill
 * it. This module has no idea how sound gets made.
 */

export interface Reaction {
  cues: Cue[];
  gestures: Gesture[];
}

export interface BargeInReaction {
  at: number;
  rms: number;
}

export class ListenSession {
  private readonly listener: Listener;
  private readonly mapping: RenderMapping;
  private state: EngineState = "listening";
  private readonly cueLog: Cue[] = [];
  private readonly bargeLog: BargeInReaction[] = [];

  constructor(sampleRate: number | null = null, options: ListenerOptions = {}, mapping: RenderMapping = DEFAULT_MAPPING) {
    this.listener = new Listener(sampleRate, options);
    this.mapping = mapping;
  }

  get currentState(): EngineState {
    return this.state;
  }

  /** Every cue this session has produced, in order. */
  get cues(): Cue[] {
    return this.cueLog;
  }

  /** Every barge-in, in order. More than one means the user kept cutting in. */
  get bargeIns(): BargeInReaction[] {
    return this.bargeLog;
  }

  /** Drive from the engine's state events. Idempotent. */
  setState(state: EngineState): void {
    if (state === this.state) return;
    this.state = state;
    // The listener only needs to know about the speaking edge: that is what
    // arms barge-in detection.
    this.listener.setSpeaking(state === "speaking");
  }

  /**
   * Feed microphone audio. Returns the gestures that just became due — empty for
   * most chunks, which is the point: reactions are sparse, not a stream.
   */
  pushPcm(samples: Float32Array, sampleRate?: number): { gestures: Gesture[]; bargeIn: BargeInReaction | null } {
    const events = this.listener.pushPcm(samples, sampleRate);
    return this.absorb(events);
  }

  pushFrame(frame: AudioFrame): { gestures: Gesture[]; bargeIn: BargeInReaction | null } {
    return this.absorb(this.listener.pushFrame(frame));
  }

  private absorb(events: ListenEvent[]): { gestures: Gesture[]; bargeIn: BargeInReaction | null } {
    let bargeIn: BargeInReaction | null = null;
    const fresh: Cue[] = [];

    for (const event of events) {
      if (event.type === "barge-in") {
        // Only the first one in a speaking turn is news. The listener already
        // suppresses repeats, but a second report would still look like a second
        // interruption in a log that a human reads.
        if (!bargeIn) {
          bargeIn = { at: event.at, rms: event.rms };
          this.bargeLog.push(bargeIn);
        }
        continue;
      }
      if (this.state !== "listening") continue;
      fresh.push(event.cue);
      this.cueLog.push(event.cue);
    }

    return { gestures: fresh.length ? mapCues(fresh, this.mapping) : [], bargeIn };
  }

  /** End of the user's turn: flush anything still open. */
  flush(): { gestures: Gesture[]; bargeIn: BargeInReaction | null } {
    return this.absorb(this.listener.flush());
  }
}
