import { test } from "node:test";
import assert from "node:assert/strict";
import { isSpeakable, speakableText } from "../src/audio/script.ts";

test("a stage direction is shown but never spoken", () => {
  assert.equal(speakableText("（笑）你还知道回来。"), "你还知道回来。");
  assert.equal(speakableText("(sighs) You came back."), "You came back.");
});

test("ascii and full-width brackets both count as asides", () => {
  assert.equal(speakableText("【叹气】算了。"), "算了。");
  assert.equal(speakableText("[smiles] 嗯。"), "嗯。");
  assert.equal(speakableText("〔停顿〕我在。"), "我在。");
});

test("an aside in the middle of a sentence leaves the sentence intact", () => {
  assert.equal(speakableText("我（想了想）觉得不行。"), "我觉得不行。");
  assert.equal(speakableText("你回来了，我（笑）很高兴。"), "你回来了，我很高兴。");
});

test("asterisk actions are removed", () => {
  assert.equal(speakableText("*轻轻点头* 嗯。"), "嗯。");
  assert.equal(speakableText("好。*转身*"), "好。");
});

test("nested asides do not leak the inner text", () => {
  assert.equal(speakableText("（他（小声）说）走吧。"), "走吧。");
});

test("an unbalanced open bracket swallows the rest of the line", () => {
  // Better to say nothing than to read half an aside aloud.
  assert.equal(speakableText("我回来了（其实"), "我回来了");
});

test("punctuation left dangling by a removal is cleaned up", () => {
  // A lone full stop carries no sound, so a reply that was nothing but an
  // aside plus punctuation has nothing left to say.
  assert.equal(speakableText("（笑）。"), "");
  assert.equal(speakableText("，。（笑）"), "");
  // But punctuation that still follows real words is kept.
  assert.equal(speakableText("（笑）好。"), "好。");
});

test("ordinary text passes through untouched", () => {
  assert.equal(speakableText("今晚有人来吗？"), "今晚有人来吗？");
  assert.equal(speakableText("嗯，我在。"), "嗯，我在。");
});

test("a reply that is only a stage direction has nothing to say", () => {
  assert.equal(speakableText("（沉默）"), "");
  assert.equal(speakableText("*sighs*"), "");
  assert.equal(isSpeakable(""), false);
  assert.equal(isSpeakable("嗯"), true);
  assert.equal(isSpeakable("123"), true);
  assert.equal(isSpeakable("..."), false);
  assert.equal(isSpeakable("……"), false);
});

test("an ellipsis alone is not speech", () => {
  assert.equal(speakableText("（叹气）……"), "……");
  assert.equal(isSpeakable("……"), false);
});
