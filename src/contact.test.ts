import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeContactability, contactSignals, UNVERIFIABLE } from "./contact.js";

test("notifications_enabled: false is a suppression signal", () => {
  const { signals } = analyzeContactability({ notifications_enabled: false });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "notifications_off");
});

test("a do-not-contact tag is a suppression signal", () => {
  const { signals } = analyzeContactability({ tags: ["Do Not Contact"] });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "do_not_contact_tag");
  assert.equal(signals[0].value, "Do Not Contact");
});

test("a direct directive in notes is a suppression signal", () => {
  const { signals, review } = analyzeContactability({
    notes: "Do not contact this customer.",
  });
  assert.equal(review.length, 0);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "notes_language");
});

test("the shop describing its own service lines is not a customer flag", () => {
  const { signals, review } = analyzeContactability({
    notes: "We do not service gas anymore.",
  });
  assert.equal(signals.length, 0);
  assert.equal(review.length, 0);
});

test("a lifted flag goes to review, not to signals", () => {
  const { signals, review } = analyzeContactability({
    notes: "Removed from DNS.",
  });
  assert.equal(signals.length, 0);
  assert.equal(review.length, 1);
  assert.equal(review[0].kind, "notes_reversal");
});

test("a conditional gate goes to review, not to signals", () => {
  const { signals, review } = analyzeContactability({
    notes: "Do not schedule without a deposit.",
  });
  assert.equal(signals.length, 0);
  assert.equal(review.length, 1);
  assert.equal(review[0].kind, "notes_conditional");
});

test("narrative disappointment is neither a signal nor a review item", () => {
  const { signals, review } = analyzeContactability({
    notes: "Refused to pay for the last visit. No longer our customer.",
  });
  assert.equal(signals.length, 0);
  assert.equal(review.length, 0);
});

test("contactSignals is the signals half of analyzeContactability", () => {
  const c = { notifications_enabled: false, tags: ["unsubscribe"] };
  assert.deepEqual(contactSignals(c), analyzeContactability(c).signals);
});

test("UNVERIFIABLE always names the Do Not Service checkbox", () => {
  assert.equal(UNVERIFIABLE.length, 1);
  assert.match(UNVERIFIABLE[0], /do not service/i);
});
