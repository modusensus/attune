import type { AudioFrame } from "./frames.ts";

/**
 * The listening layer's judgement call: from a stream of acoustic frames, decide
 * what the character should be doing right now.
 *
 * This is the part the project exists for. VAD answers "is there sound". It
 * cannot answer "is this pause a full stop or a breath", and that difference is
 * the entire difference between a machine that waits and a person who listens.
 *
 * Two signals carry it without a model:
 *
 *   f0 contour   A falling contour is a statement closing; a level or rising one
 *                is a clause still in the air. Speakers raise pitch on the last
 *                stressed syllable of a non-final clause. This is one of the
 *                more robust findings in prosody research and it survives a
 *                cheap microphone.
 *   burst length A short voiced burst inside someone else's turn is a nod, not
 *                a turn attempt. A long one is a turn attempt.
 *
 * A learned model (MaAI or similar) belongs behind the same interface: it
 * consumes the same frames and emits the same cues. Nothing downstream should
 * be able to tell which one produced them.
 *
 * Timing is the point, not an afterthought. The first reaction fires at
 * `holdSilenceMs` (220ms) — well inside the 300ms budget in ARCHITECTURE.md —
 * because "I am still here" must arrive before the speaker wonders whether they
 * are talking to a wall. The handover decision comes later, at `endSilenceMs`.
 */

export type CueType =
  /** Short positive noise mid-turn: nod, "mm", "yeah". */
  | "backchannel"
  /** The speaker has finished and is handing over. */
  | "turn_take"
  /** The speaker paused but is still holding the floor. Stay quiet, keep watching. */
  | "hold"
  /** Nothing to react to. Only ever emitted when a whole clip produced nothing. */
  | "idle";

export interface Cue {
  type: CueType;
  /** Milliseconds into the clip where this judgement lands. */
  at: number;
  /** 0..1. Downstream scales the reaction by this; it does not gate on it. */
  confidence: number;
  /** Why, in one phrase. For logs and tests; never shown to a user. */
  reason: string;
}

export interface ListenOptions {
  /** Silence this long ends a turn. Default 700ms. */
  endSilenceMs?: number;
  /** Silence this long (but < endSilenceMs) is a hold. Default 220ms. */
  holdSilenceMs?: number;
  /** A voiced burst in this range, inside someone else's turn, is a backchannel. */
  backchannelMinMs?: number;
  backchannelMaxMs?: number;
  /** F0 must drop at least this fraction across the run to call it a fall. Default 0.12. */
  fallRatio?: number;
  /** Frames at or below this RMS count as silence. Default 0.01. */
  silenceRms?: number;
  /** Do not emit two cues of the same kind closer together than this. Default 400ms. */
  minGapMs?: number;
  /** A rising contour pushes the handover out to this multiple of endSilenceMs. Default 2. */
  risingFactor?: number;
  /**
   * Minimum spacing between two *holds*. Default 2500ms.
   *
   * `minGapMs` only stops the same cue type repeating, so without a budget the
   * character alternates hold/backchannel/hold/backchannel through a monologue
   * and looks like a screensaver with a neck: 236 reactions in 94 seconds.
   *
   * Holds get the long budget because a hold is the ambient "still here"
   * signal — a brow lift every 300ms is not attentiveness, it is a tic.
   */
  minHoldGapMs?: number;
  /** Minimum spacing between two backchannels. Default 2500ms. */
  minBackchannelGapMs?: number;
  /**
   * Minimum spacing between ANY two reactions of any kind. Default 1500ms.
   *
   * This is the one that actually decides whether the thing looks alive or
   * mechanical. Per-type gaps are not enough: alternating hold/backchannel/hold
   * passes both of them and still fires twice a second. A person gives minimal
   * feedback roughly every 3-5 seconds when a friend is talking; faster than
   * that is not attentiveness, it is a tic.
   *
   * turn_take is exempt. Suppressing the handover because the character lifted
   * an eyebrow recently would leave the user talking into a wall.
   */
  minReactionGapMs?: number;
}

const DEFAULTS = {
  endSilenceMs: 700,
  holdSilenceMs: 220,
  backchannelMinMs: 120,
  backchannelMaxMs: 350,
  fallRatio: 0.12,
  silenceRms: 0.01,
  minGapMs: 400,
  risingFactor: 2,
  minHoldGapMs: 4000,
  minBackchannelGapMs: 2500,
  minReactionGapMs: 1500,
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Fractional pitch change across a voiced run: last third against first third.
 * Negative means the voice came down at the end — the shape of a full stop.
 * Returns 0 when there is not enough voiced material to say anything.
 */
export function fallFromContour(f0s: number[]): number {
  if (f0s.length < 6) return 0;
  const third = Math.max(2, Math.floor(f0s.length / 3));
  const head = median(f0s.slice(0, third).filter((v) => v > 0));
  const tail = median(f0s.slice(f0s.length - third).filter((v) => v > 0));
  if (head <= 0 || tail <= 0) return 0;
  return (tail - head) / head;
}

interface RunState {
  fromAt: number;
  toAt: number;
  f0s: number[];
  backchannelSent: boolean;
}

/**
 * Incremental judge. Feed it frames in order; it hands back the cues that became
 * true at that frame. The batch `judge()` below is this same object fed to the
 * end, so the two cannot disagree — that is by construction, not by testing.
 */
export class CueTracker {
  private readonly opts: Required<ListenOptions>;
  private run: RunState | null = null;
  private silenceFromAt: number | null = null;
  private lastFall = 0;
  private spokenBefore = false;
  private holdSent = false;
  private turnSent = false;
  private step = 20;
  private lastAt = Number.NaN;
  private emitted: Cue[] = [];
  /**
   * Whether anything voiced has been heard at all. A room with nobody in it must
   * not produce "they paused" or "they finished" — the cues mean things about a
   * speaker, and there is no speaker yet.
   */
  private heard = false;

  constructor(opts: ListenOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Cues decided at this frame. Usually empty. */
  push(frame: AudioFrame): Cue[] {
    if (!Number.isNaN(this.lastAt)) {
      const d = frame.at - this.lastAt;
      if (d > 0) this.step = d;
    }
    this.lastAt = frame.at;

    const silent = frame.rms <= this.opts.silenceRms;
    const out: Cue[] = [];

    if (!silent) {
      if (this.silenceFromAt !== null) {
        // A new run begins; the previous gap is closed and no longer grows.
        this.silenceFromAt = null;
        this.holdSent = false;
        this.turnSent = false;
      }
      this.heard = true;
      if (!this.run) this.run = { fromAt: frame.at, toAt: frame.at, f0s: [], backchannelSent: false };
      this.run.toAt = frame.at;
      this.run.f0s.push(frame.f0);

      const runMs = this.run.toAt - this.run.fromAt + this.step;
      if (
        !this.run.backchannelSent &&
        this.spokenBefore &&
        runMs >= this.opts.backchannelMinMs &&
        runMs <= this.opts.backchannelMaxMs
      ) {
        // Sent the moment the burst is long enough to be a nod, not at its end:
        // waiting for the end would spend the whole burst's budget on nothing.
        this.run.backchannelSent = true;
        const bc = this.emit("backchannel", frame.at, 0.55, "short voiced burst inside a turn (" + Math.round(runMs) + "ms)");
        if (bc) out.push(bc);
      }
      return out;
    }

    // Silent frame.
    if (this.run) {
      const runMs = this.run.toAt - this.run.fromAt + this.step;
      this.lastFall = fallFromContour(this.run.f0s);
      if (runMs > this.opts.backchannelMaxMs) this.spokenBefore = true;
      this.run = null;
      this.silenceFromAt = frame.at;
      this.holdSent = false;
      this.turnSent = false;
      return out;
    }

    if (this.silenceFromAt === null) {
      this.silenceFromAt = frame.at;
      this.holdSent = false;
      this.turnSent = false;
      return out;
    }

    const silenceMs = frame.at - this.silenceFromAt + this.step;

    // Nothing has been said in this stream at all: no holds, no handover. The
    // only honest cue is the idle emitted at flush.
    if (!this.heard) return out;

    if (!this.holdSent && silenceMs >= this.opts.holdSilenceMs) {
      this.holdSent = true;
      const h = this.emit("hold", frame.at, 0.7, "pause of " + Math.round(silenceMs) + "ms, turn still open");
      if (h) out.push(h);
    }

    if (!this.turnSent) {
      const rising = this.lastFall >= this.opts.fallRatio;
      const falling = this.lastFall <= -this.opts.fallRatio;
      // Only a falling contour earns the short handover. A level one is someone
      // mid-thought, and jumping in there is exactly the "talking to a machine"
      // failure this project is about. Being slow is recoverable; being rude is
      // not.
      const need = falling ? this.opts.endSilenceMs : this.opts.endSilenceMs * this.opts.risingFactor;
      if (silenceMs >= need) {
        this.turnSent = true;
        const tt = this.emit(
          "turn_take",
          frame.at,
          rising ? 0.35 : falling ? 0.9 : 0.55,
          "silence " + Math.round(silenceMs) + "ms after a " +
            (falling ? "falling" : rising ? "rising" : "level") +
            " contour (" + (this.lastFall * 100).toFixed(0) + "%)",
        );
        if (tt) out.push(tt);
      }
    }

    return out;
  }

  /** End of stream: nothing is still open, so anything left is an idle clip. */
  flush(): Cue[] {
    if (!this.heard) {
      const idle = this.emit("idle", 0, 0.2, "no speech detected");
      return idle ? [idle] : [];
    }
    this.run = null;
    return [];
  }

  /** Every cue emitted so far, in order. */
  get cues(): Cue[] {
    return this.emitted;
  }

  /**
   * Record a cue, unless the same kind fired too recently. Returns null when it
   * was suppressed — handing the cue back anyway would make the caller react to
   * something the log says never happened.
   */
  private emit(type: CueType, at: number, confidence: number, reason: string): Cue | null {
    const prev = [...this.emitted].reverse().find((c) => c.type === type);
    if (prev && at - prev.at < this.opts.minGapMs) return null;

    // Ambient reactions are budgeted separately from evidence-driven ones.
    //
    // turn_take is exempt entirely: it is the cue the whole conversation hangs
    // on, and suppressing it because the character happened to lift an eyebrow
    // recently would leave the user talking into a wall for reasons they cannot
    // see. Being late is recoverable; never taking the turn is not.
    if (type !== "turn_take") {
      const last = this.emitted[this.emitted.length - 1];
      // Global floor first: whatever kind it was, the face has only just moved.
      //
      // Except after a turn_take. Handing the turn over starts a new turn, and
      // the budget belongs to the old one — otherwise the character takes the
      // turn, the user keeps talking, and the first nod of the new turn gets
      // swallowed by a limit that was about the previous one.
      if (last && last.type !== "turn_take" && at - last.at < this.opts.minReactionGapMs) return null;
      if (type === "hold") {
        const prev = [...this.emitted].reverse().find((c) => c.type === "hold");
        if (prev && at - prev.at < this.opts.minHoldGapMs) return null;
      } else if (type === "backchannel") {
        const prev = [...this.emitted].reverse().find((c) => c.type === "backchannel");
        if (prev && at - prev.at < this.opts.minBackchannelGapMs) return null;
      }
    }
    const cue: Cue = { type, at, confidence, reason };
    this.emitted.push(cue);
    return cue;
  }
}

/**
 * Judge a whole clip at once. Same tracker, fed to the end — the live path and
 * this one produce identical cues for identical input.
 */
export function judge(frames: AudioFrame[], opts: ListenOptions = {}): Cue[] {
  const tracker = new CueTracker(opts);
  for (const frame of frames) tracker.push(frame);
  // flush() records into `cues` and also returns what it emitted for live
  // callers. Reading `cues` afterwards is the whole list — concatenating both
  // would count the closing cue twice.
  tracker.flush();
  return tracker.cues;
}