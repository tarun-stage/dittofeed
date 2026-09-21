import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The deployed worker reuses the pg dependency bundled with backend-lib.
// eslint-disable-next-line import/no-extraneous-dependencies
import pg from "pg";

const { Pool } = pg;
const EVENT_DATABASES = [
  "raw_prod_events",
  "raw_prod_events_web",
  "raw_prod_events_backend",
];
const SOURCE_TABLE_OVERRIDES = new Map([
  ["app_open", { database: "raw_prod_events", table: "fct_app_open" }],
]);
const EVENT_NODE_TYPES = new Set([
  "EventEntryNode",
  "KeyedPerformed",
  "LastPerformed",
  "Performed",
  "PerformedMany",
]);
const COMMON_EVENT_COLUMNS = new Set([
  "anonymous_id",
  "event",
  "event_id",
  "event_text",
  "id",
  "original_timestamp",
  "received_at",
  "sent_at",
  "timestamp",
  "user_id",
  "uuid_ts",
]);

function firstNonEmpty(...values) {
  return values.find(
    (value) => value !== null && value !== undefined && value !== "",
  );
}

function envNumber(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const config = {
  batchSize: envNumber("SELECTIVE_STREAM_BATCH_SIZE", 100, 10, 1000),
  bootstrapSeconds: envNumber(
    "SELECTIVE_STREAM_BOOTSTRAP_SECONDS",
    3600,
    0,
    21600,
  ),
  discoveryMs: envNumber("SELECTIVE_STREAM_DISCOVERY_MS", 60000, 10000, 600000),
  intervalMs: envNumber("SELECTIVE_STREAM_POLL_MS", 30000, 5000, 600000),
  maxBatchesPerPoll: envNumber(
    "SELECTIVE_STREAM_MAX_BATCHES_PER_POLL",
    2,
    1,
    20,
  ),
  maxProfileVersions: envNumber(
    "SELECTIVE_STREAM_MAX_PROFILE_VERSIONS",
    50000,
    1000,
    500000,
  ),
  maxEventReceipts: envNumber(
    "SELECTIVE_STREAM_MAX_EVENT_RECEIPTS",
    200000,
    1000,
    1000000,
  ),
  stateFile: firstNonEmpty(
    process.env.SELECTIVE_STREAM_STATE_FILE,
    "/state/selective-stream.json",
  ),
  batchUrl: firstNonEmpty(
    process.env.DITTOFEED_BATCH_URL,
    "http://stage-dittofeed-lite:3000/api/public/apps/batch",
  ),
};

function log(level, message, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ level, message, ...fields, at: new Date().toISOString() })}\n`,
  );
}

export function collectReferencedEvents(definitions) {
  const events = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (
      EVENT_NODE_TYPES.has(value.type) &&
      typeof value.event === "string" &&
      value.event.trim()
    ) {
      events.add(value.event.trim());
    }
    Object.values(value).forEach(visit);
  };
  definitions.forEach(visit);
  return [...events].sort();
}

export function normalizeEventTableName(eventName) {
  const unqualified = String(eventName).includes(".")
    ? String(eventName).split(".").at(-1)
    : String(eventName);
  const normalized = unqualified
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z_][a-z0-9_]*$/.test(normalized) ? normalized : null;
}

function toIso(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const parsed = new Date(
    /Z$|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`,
  );
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function cleanValue(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, 4096);
  if (["number", "boolean"].includes(typeof value)) return value;
  return JSON.stringify(value).slice(0, 4096);
}

export function buildTrackMessage(source, row) {
  const userId = String(row.user_id ?? "").trim();
  const anonymousId = String(row.anonymous_id ?? "").trim();
  const sourceId = String(firstNonEmpty(row.event_id, row.id, "")).trim();
  if ((!userId && !anonymousId) || !sourceId) return null;
  const properties = {};
  for (const [key, value] of Object.entries(row).slice(0, 256)) {
    if (COMMON_EVENT_COLUMNS.has(key)) continue;
    const cleaned = cleanValue(value);
    if (cleaned !== undefined) properties[key] = cleaned;
  }
  const event = String(firstNonEmpty(row.event, source.eventName)).trim();
  return {
    type: "track",
    ...(userId ? { userId } : { anonymousId }),
    messageId: `warehouse:${source.database}.${source.table}:${sourceId}`,
    event,
    timestamp: toIso(row.received_at) ?? new Date().toISOString(),
    properties,
    context: {
      source: "stage-warehouse-selective",
      sourceTable: `${source.database}.${source.table}`,
      platform: String(
        firstNonEmpty(
          row.platform,
          row.device_platform,
          row.context_os_name,
          "",
        ),
      ).slice(0, 128),
      deviceId: String(
        firstNonEmpty(row.context_device_id, row.device_id, ""),
      ).slice(0, 512),
    },
  };
}

export function buildIdentifyMessage(userId, profile = {}, device = {}) {
  const traits = {
    email: cleanValue(profile.email),
    language: cleanValue(profile.language),
    phone: cleanValue(
      firstNonEmpty(profile.primary_mobile_number, device.primaryMobileNumber),
    ),
    subscriptionStatus: cleanValue(profile.subscription_status),
    subscriptionSource: cleanValue(profile.subscription_source),
    subscriptionStartedAt: cleanValue(profile.subscription_started_at),
    deviceToken: cleanValue(device.firebaseToken),
    deviceId: cleanValue(device.deviceId),
    platform: cleanValue(firstNonEmpty(device.platform, device.os)),
  };
  const populatedTraits = Object.fromEntries(
    Object.entries(traits).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  );
  const profileVersion = `${String(device.cursor ?? "")}:${String(
    profile.updated_at ?? "",
  )}`.slice(0, 180);
  return {
    type: "identify",
    userId,
    messageId: `warehouse-profile:${userId}:${firstNonEmpty(profileVersion, "current")}`,
    timestamp: new Date().toISOString(),
    traits: populatedTraits,
    context: { source: "stage-warehouse-selective" },
  };
}

export function selectUnseenMessages(messages, receipts) {
  const selected = [];
  const pending = {};
  for (const message of messages) {
    if (receipts[message.messageId] || pending[message.messageId]) continue;
    pending[message.messageId] = new Date().toISOString();
    selected.push(message);
  }
  return { messages: selected, pending };
}

function sqlString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

async function sourceQuery(sql) {
  const secure =
    String(process.env.SOURCE_CLICKHOUSE_SECURE ?? "true").toLowerCase() !==
    "false";
  const transport = secure ? https : http;
  const host = process.env.SOURCE_CLICKHOUSE_HOST;
  const user = process.env.SOURCE_CLICKHOUSE_USER;
  const password = process.env.SOURCE_CLICKHOUSE_PASSWORD;
  const port = Number(
    firstNonEmpty(process.env.SOURCE_CLICKHOUSE_PORT, secure ? 443 : 8123),
  );
  if (!host || !user || !password) {
    throw new Error("Source ClickHouse configuration is incomplete");
  }
  const authorization = Buffer.from(`${user}:${password}`).toString("base64");
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        hostname: host,
        port,
        path: "/",
        method: "POST",
        rejectUnauthorized: secure,
        headers: {
          Authorization: `Basic ${authorization}`,
          "Content-Type": "text/plain",
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `Source ClickHouse returned ${response.statusCode}: ${body.slice(0, 300)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body).data ?? []);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(60000, () =>
      request.destroy(new Error("Source query timed out")),
    );
    request.on("error", reject);
    request.end(`${sql.trim().replace(/;$/, "")}\nFORMAT JSON`);
  });
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(config.stateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      version: 1,
      cursors: {},
      eventReceipts: {},
      profileVersions: {},
    };
  }
}

async function saveJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, file);
}

async function activeDefinitions(pool) {
  const result = await pool.query(`
    SELECT definition FROM "Segment" WHERE status = 'Running'
    UNION ALL
    SELECT definition FROM "Journey" WHERE status IN ('Running', 'Broadcast')
    UNION ALL
    SELECT definition FROM "UserProperty" WHERE status = 'Running'
  `);
  return result.rows.map((row) => row.definition).filter(Boolean);
}

async function resolveSources(eventNames) {
  const sources = await Promise.all(
    eventNames.map(async (eventName) => {
      const qualified = String(eventName).split(".");
      if (
        qualified.length === 2 &&
        EVENT_DATABASES.includes(qualified[0]) &&
        /^[a-z_][a-z0-9_]*$/.test(qualified[1])
      ) {
        return { database: qualified[0], table: qualified[1], eventName };
      }
      const table = normalizeEventTableName(eventName);
      if (!table) return null;
      const override = SOURCE_TABLE_OVERRIDES.get(table);
      if (override) {
        return { ...override, eventName };
      }
      const databases = EVENT_DATABASES.map((database) => `'${database}'`).join(
        ",",
      );
      const rows = await sourceQuery(`
      SELECT database, name AS table
      FROM system.tables
      WHERE database IN (${databases}) AND name = '${sqlString(table)}'
      ORDER BY indexOf([${databases}], database)
      LIMIT 1
    `);
      return rows[0] ? { ...rows[0], eventName } : null;
    }),
  );
  return sources.filter(Boolean);
}

async function fetchProfiles(userIds) {
  if (userIds.length === 0) return new Map();
  const ids = userIds.map((id) => `'${sqlString(id)}'`).join(",");
  const [profiles, devices] = await Promise.all([
    sourceQuery(`
      SELECT user_id, email, language, primary_mobile_number,
             subscription_status, subscription_source,
             subscription_started_at, updated_at
      FROM analytics_prod_core.dim_users
      WHERE user_id IN (${ids})
    `),
    sourceQuery(`
      SELECT _id AS user_id,
             argMax(firebaseToken, _ab_cdc_cursor) AS firebaseToken,
             argMax(deviceId, _ab_cdc_cursor) AS deviceId,
             argMax(primaryMobileNumber, _ab_cdc_cursor) AS primaryMobileNumber,
             argMax(platform, _ab_cdc_cursor) AS platform,
             argMax(os, _ab_cdc_cursor) AS os,
             max(_ab_cdc_cursor) AS cursor
      FROM raw_prod.users
      WHERE _id IN (${ids})
      GROUP BY _id
    `),
  ]);
  const byUser = new Map();
  profiles.forEach((profile) => {
    byUser.set(profile.user_id, { profile, device: {} });
  });
  devices.forEach((device) => {
    const existing = byUser.get(device.user_id) ?? { profile: {}, device: {} };
    existing.device = device;
    byUser.set(device.user_id, existing);
  });
  return byUser;
}

async function submitBatch(messages) {
  if (messages.length === 0) return;
  const writeKey = process.env.DITTOFEED_WRITE_KEY;
  if (!writeKey?.startsWith("Basic ")) {
    throw new Error("DITTOFEED_WRITE_KEY is missing or invalid");
  }
  const response = await fetch(config.batchUrl, {
    method: "POST",
    headers: {
      Authorization: writeKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ batch: messages }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(
      `Dittofeed batch returned ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
}

async function pollSource(source, state) {
  const key = `${source.database}.${source.table}`;
  const stored = state.cursors[key];
  const initial = new Date(
    Date.now() - config.bootstrapSeconds * 1000,
  ).toISOString();
  const cursor = stored ?? { receivedAt: initial, id: "" };
  const receivedAt = cursor.receivedAt
    .slice(0, 23)
    .replace("T", " ")
    .replace("Z", "");
  const rows = await sourceQuery(`
    SELECT *
    FROM ${key}
    WHERE received_at IS NOT NULL
      AND id IS NOT NULL
      AND (
        received_at > parseDateTime64BestEffort('${sqlString(receivedAt)}')
        OR (
          received_at = parseDateTime64BestEffort('${sqlString(receivedAt)}')
          AND id > '${sqlString(cursor.id)}'
        )
      )
    ORDER BY received_at ASC, id ASC
    LIMIT ${config.batchSize}
  `);
  if (rows.length === 0) return 0;
  const eventReceipts = state.eventReceipts ?? {};
  const builtTracks = rows
    .map((row) => buildTrackMessage(source, row))
    .filter(Boolean);
  const selectedTracks = selectUnseenMessages(builtTracks, eventReceipts);
  const tracks = selectedTracks.messages;
  const userIds = [
    ...new Set(tracks.map((message) => message.userId).filter(Boolean)),
  ];
  const profiles = await fetchProfiles(userIds);
  const profileVersions = state.profileVersions ?? {};
  const pendingProfileVersions = {};
  const identifies = userIds.flatMap((userId) => {
    const value = profiles.get(userId) ?? {};
    const message = buildIdentifyMessage(userId, value.profile, value.device);
    if (profileVersions[userId] === message.messageId) return [];
    pendingProfileVersions[userId] = message.messageId;
    return [message];
  });
  await submitBatch([...identifies, ...tracks]);
  const updatedEventReceipts = Object.fromEntries(
    Object.entries({ ...eventReceipts, ...selectedTracks.pending }).slice(
      -config.maxEventReceipts,
    ),
  );
  const updatedProfileVersions = Object.fromEntries(
    Object.entries({ ...profileVersions, ...pendingProfileVersions }).slice(
      -config.maxProfileVersions,
    ),
  );
  const last = rows.at(-1);
  Object.assign(state, {
    eventReceipts: updatedEventReceipts,
    profileVersions: updatedProfileVersions,
    cursors: {
      ...state.cursors,
      [key]: {
        receivedAt: toIso(last.received_at),
        id: String(last.id),
      },
    },
  });
  await saveJson(config.stateFile, state);
  return tracks.length;
}

async function main() {
  const pool = new Pool({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? 5432),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME ?? "dittofeed_stage_test",
    max: 2,
  });
  const state = await loadState();
  let sources = [];
  let lastDiscovery = 0;
  let busy = false;
  const healthFile = path.join(path.dirname(config.stateFile), "health.json");

  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      if (Date.now() - lastDiscovery >= config.discoveryMs) {
        const eventNames = collectReferencedEvents(
          await activeDefinitions(pool),
        );
        sources = await resolveSources(eventNames);
        lastDiscovery = Date.now();
        log("info", "refreshed selective sources", {
          referencedEvents: eventNames,
          sources: sources.map(
            (source) => `${source.database}.${source.table}`,
          ),
        });
      }
      let streamed = 0;
      /* eslint-disable no-await-in-loop -- polling is deliberately sequential to cap load */
      for (const source of sources) {
        for (let batch = 0; batch < config.maxBatchesPerPoll; batch += 1) {
          const count = await pollSource(source, state);
          streamed += count;
          if (count < config.batchSize) break;
          await new Promise((resolve) => {
            setTimeout(resolve, 1000);
          });
        }
      }
      /* eslint-enable no-await-in-loop */
      await saveJson(healthFile, {
        status: "healthy",
        lastSuccessAt: new Date().toISOString(),
        sourceCount: sources.length,
        streamed,
      });
      if (streamed > 0) log("info", "streamed events", { streamed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", "selective stream poll failed", { error: message });
      await saveJson(healthFile, {
        status: "unhealthy",
        lastErrorAt: new Date().toISOString(),
        error: message.slice(0, 500),
      });
    } finally {
      busy = false;
    }
  };

  const stop = async () => {
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log("info", "starting selective warehouse stream", {
    batchSize: config.batchSize,
    bootstrapSeconds: config.bootstrapSeconds,
    intervalMs: config.intervalMs,
    maxBatchesPerPoll: config.maxBatchesPerPoll,
  });
  await poll();
  setInterval(poll, config.intervalMs);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    log("error", "selective stream terminated", { error: message });
    process.exit(1);
  });
}
