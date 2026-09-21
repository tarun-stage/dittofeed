import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIdentifyMessage,
  buildTrackMessage,
  collectReferencedEvents,
  normalizeEventTableName,
} from "./stage-selective-stream.mjs";

test("collects only events referenced by supported segment and journey nodes", () => {
  assert.deepEqual(
    collectReferencedEvents([
      {
        entryNode: { type: "EventEntryNode", event: "app_open" },
        nodes: [
          { type: "Performed", event: "playback_started" },
          { type: "MessageNode", event: "not-an-event-source" },
        ],
      },
      { type: "Trait", path: "event" },
    ]),
    ["app_open", "playback_started"],
  );
});

test("normalizes an event name to its warehouse table", () => {
  assert.equal(normalizeEventTableName("App Opened"), "app_opened");
  assert.equal(
    normalizeEventTableName("raw_prod_events.playback_started"),
    "playback_started",
  );
  assert.equal(normalizeEventTableName("!!!"), null);
});

test("builds a deterministic Dittofeed track message", () => {
  const message = buildTrackMessage(
    {
      database: "raw_prod_events",
      table: "app_open",
      eventName: "app_open",
    },
    {
      id: "source-1",
      user_id: "user-1",
      event: "app_open",
      received_at: "2026-09-10 05:00:00.000",
      city: "Noida",
    },
  );
  assert.equal(message.messageId, "warehouse:raw_prod_events.app_open:source-1");
  assert.equal(message.userId, "user-1");
  assert.equal(message.properties.city, "Noida");
  assert.equal(message.properties.received_at, undefined);
});

test("maps profile and device fields to targeting traits", () => {
  const message = buildIdentifyMessage(
    "user-1",
    {
      email: "user@stage.invalid",
      language: "hi",
      primary_mobile_number: "919999999999",
      subscription_status: "active",
    },
    { firebaseToken: "token", deviceId: "device", cursor: 42 },
  );
  assert.equal(message.traits.phone, "919999999999");
  assert.equal(message.traits.deviceToken, "token");
  assert.equal(message.traits.subscriptionStatus, "active");
});
