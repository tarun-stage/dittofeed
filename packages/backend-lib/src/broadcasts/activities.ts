import { Row } from "@clickhouse/client";
import { zonedTimeToUtc } from "date-fns-tz";
import { and, eq } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { omit } from "remeda";
import { v4 as uuidV4, v5 as uuidV5 } from "uuid";

import { submitBatch } from "../apps/batch";
import {
  clickhouseClient,
  command as clickhouseCommand,
  stageWarehouseClickhouseClient,
} from "../clickhouse";
import { ComputePropertiesArgs } from "../computedProperties/computePropertiesIncremental";
import { computePropertiesIncremental } from "../computedProperties/computePropertiesWorkflow/activities/computeProperties";
import { db } from "../db";
import * as schema from "../db/schema";
import { searchDeliveries } from "../deliveries";
import logger from "../logger";
import {
  isNonRetryableError,
  Sender,
  sendMessage,
  SendMessageParameters,
  SendMessageParametersBase,
  SubscriptionGroupDetailsWithName,
} from "../messaging";
import { withSpan } from "../openTelemetry";
import {
  buildStageWarehouseAudienceQuery,
  toSegmentResource,
} from "../segments";
import {
  getSubscriptionGroupDetails,
  getSubscriptionGroupsWithAssignments,
} from "../subscriptionGroups";
import {
  BackendMessageSendResult,
  BatchTrackData,
  BroadcastResourceV2,
  BroadcastV2Config,
  BroadcastV2Status,
  ChannelType,
  DBWorkspaceOccupantType,
  EventType,
  GetUsersResponseItem,
  InternalEventType,
  JSONValue,
  MessageTags,
  SavedSegmentResource,
  TrackData,
} from "../types";
import { getStageWarehouseUserProperties, getUsers } from "../users";

export { markBroadcastStatus } from "../broadcasts";

/**
 * Computes the timezones for all users in a broadcast using timezone, lat/lon,
 * ip address, or default timezone for the broadcast.
 * @param param0
 * @returns A list of unique timezones corresponding to the users in the broadcast.
 */
export async function computeTimezones({
  workspaceId,
  defaultTimezone,
}: {
  workspaceId: string;
  defaultTimezone: string;
}): Promise<{
  timezones: string[];
}> {
  // FIXME validate timezones and submit errors to user events for users with invalid timezones
  throw new Error("Not implemented");
}

export async function getBroadcast({
  workspaceId,
  broadcastId,
}: {
  workspaceId: string;
  broadcastId: string;
}): Promise<BroadcastResourceV2 | null> {
  const model = await db().query.broadcast.findFirst({
    where: and(
      eq(schema.broadcast.id, broadcastId),
      eq(schema.broadcast.workspaceId, workspaceId),
    ),
  });
  if (!model) {
    return null;
  }
  const configResult = schemaValidateWithErr(model.config, BroadcastV2Config);
  if (configResult.isErr()) {
    logger().error(
      {
        err: configResult.error,
        broadcastId,
        workspaceId,
      },
      "Error validating broadcast config",
    );
    return null;
  }
  if (model.statusV2 === null) {
    logger().error(
      {
        broadcastId,
        workspaceId,
      },
      "Broadcast status is null",
    );
    return null;
  }
  if (model.version !== "V2") {
    logger().error(
      {
        broadcastId,
        workspaceId,
      },
      "Broadcast version is not V2",
    );
    return null;
  }
  return {
    workspaceId: model.workspaceId,
    config: configResult.value,
    id: model.id,
    name: model.name,
    status: model.statusV2,
    messageTemplateId: model.messageTemplateId ?? undefined,
    segmentId: model.segmentId ?? undefined,
    scheduledAt: model.scheduledAt ?? undefined,
    subscriptionGroupId: model.subscriptionGroupId ?? undefined,
    createdAt: model.createdAt.getTime(),
    updatedAt: model.updatedAt.getTime(),
    version: model.version,
  };
}

export interface SendMessagesResponse {
  messagesSent: number;
  nextCursor?: string;
  includesNonRetryableError: boolean;
}

interface SendMessagesParams {
  workspaceId: string;
  broadcastId: string;
  workspaceOccupantId?: string;
  workspaceOccupantType?: DBWorkspaceOccupantType;
  now: number;
  timezones?: string[];
  cursor?: string;
  limit: number;
}

function getMessageId({
  broadcastId,
  userId,
  workspaceId,
}: {
  broadcastId: string;
  userId: string;
  workspaceId: string;
}): string {
  return uuidV5(`${userId}-${broadcastId}`, workspaceId);
}

async function getUnmessagedUsers(
  params: Parameters<typeof getUsers>[0] & {
    broadcastId: string;
    now: number;
  },
): Promise<{
  users: GetUsersResponseItem[];
  nextCursor?: string;
}> {
  const { broadcastId, ...rest } = params;
  const { users, nextCursor } = await getUsers(rest, {
    allowInternalSegment: true,
  }).then(unwrap);
  const nowDate = new Date(params.now);

  const alreadySent = await searchDeliveries({
    workspaceId: params.workspaceId,
    broadcastId,
    userId: users.map((user) => user.id),
    limit: params.limit,
    endDate: nowDate.toISOString(),
    startDate: new Date(params.now - 1000 * 60 * 60 * 24).toISOString(),
  });
  return {
    users: users.filter(
      (user) => !alreadySent.items.some((item) => item.userId === user.id),
    ),
    nextCursor,
  };
}

let stageWarehouseAudienceTablePromise: Promise<unknown> | null = null;

function ensureStageWarehouseAudienceTable() {
  if (!stageWarehouseAudienceTablePromise) {
    stageWarehouseAudienceTablePromise = clickhouseCommand({
      query: `
        CREATE TABLE IF NOT EXISTS stage_warehouse_audience
        (
          workspace_id String,
          broadcast_id String,
          run_id String,
          user_id String,
          created_at DateTime
        )
        ENGINE = MergeTree
        PARTITION BY toDate(created_at)
        ORDER BY (workspace_id, broadcast_id, run_id, user_id)
        TTL created_at + INTERVAL 7 DAY DELETE
      `,
    }).catch((error) => {
      stageWarehouseAudienceTablePromise = null;
      throw error;
    });
  }
  return stageWarehouseAudienceTablePromise;
}

async function filterUnmessagedUsers({
  users,
  workspaceId,
  broadcastId,
  now,
  limit,
}: {
  users: GetUsersResponseItem[];
  workspaceId: string;
  broadcastId: string;
  now: number;
  limit: number;
}) {
  if (users.length === 0) return users;
  const alreadySent = await searchDeliveries({
    workspaceId,
    broadcastId,
    userId: users.map((user) => user.id),
    limit,
    endDate: new Date(now).toISOString(),
    startDate: new Date(now - 1000 * 60 * 60 * 24).toISOString(),
  });
  const sentUserIds = new Set(alreadySent.items.map((item) => item.userId));
  return users.filter((user) => !sentUserIds.has(user.id));
}

function stageWarehouseProperties(values: Record<string, JSONValue>) {
  return Object.entries(values).reduce<GetUsersResponseItem["properties"]>(
    (properties, [name, value]) => ({
      ...properties,
      [name]: { name, value },
    }),
    {},
  );
}

function isClickhouseRow(value: unknown): value is Row {
  return (
    typeof value === "object" &&
    value !== null &&
    "json" in value &&
    typeof value.json === "function"
  );
}

function isClickhouseRowBatch(value: unknown): value is Row[] {
  return Array.isArray(value) && value.every(isClickhouseRow);
}

async function getStageWarehouseUsers({
  workspaceId,
  broadcastId,
  runId,
  cursor,
  limit,
  now,
  channel,
}: {
  workspaceId: string;
  broadcastId: string;
  runId: string;
  cursor?: string;
  limit: number;
  now: number;
  channel: ChannelType;
}): Promise<{ users: GetUsersResponseItem[]; nextCursor?: string }> {
  await ensureStageWarehouseAudienceTable();
  const effectiveLimit = Math.max(limit, 500);
  const snapshotResult = await clickhouseClient().query({
    query: `
      SELECT user_id
      FROM stage_warehouse_audience
      WHERE workspace_id = {workspaceId:String}
        AND broadcast_id = {broadcastId:String}
        AND run_id = {runId:String}
        AND user_id > {cursor:String}
      ORDER BY user_id
      LIMIT {limit:UInt32}
    `,
    query_params: {
      workspaceId,
      broadcastId,
      runId,
      cursor: cursor ?? "",
      limit: effectiveLimit,
    },
    format: "JSONEachRow",
  });
  const snapshotRows = await snapshotResult.json<{ user_id: string }>();
  if (snapshotRows.length === 0) return { users: [] };
  const userIds = snapshotRows.map((row) => row.user_id);
  const warehouseProperties = await getStageWarehouseUserProperties({
    userIds,
  });
  const eligibleUserIds = userIds.filter((userId) => {
    if (channel !== ChannelType.MobilePush) return true;
    return warehouseProperties.get(userId)?.mobilePushEligible === true;
  });
  const users = eligibleUserIds.map((userId) => {
    const properties = stageWarehouseProperties(
      warehouseProperties.get(userId)?.properties ?? { id: userId },
    );
    return { id: userId, properties, segments: [] };
  });
  const filteredUsers = await filterUnmessagedUsers({
    users,
    workspaceId,
    broadcastId,
    now,
    limit: effectiveLimit,
  });
  return {
    users: filteredUsers,
    nextCursor:
      snapshotRows.length === effectiveLimit
        ? snapshotRows.at(-1)?.user_id
        : undefined,
  };
}

async function materializeStageWarehouseAudience({
  workspaceId,
  broadcastId,
  definition,
  now,
}: {
  workspaceId: string;
  broadcastId: string;
  definition: SavedSegmentResource["definition"];
  now: number;
}) {
  await ensureStageWarehouseAudienceTable();
  const runId = uuidV4();
  const bucketCount = 16;
  const compiled = await buildStageWarehouseAudienceQuery({
    definition,
    now,
    shardCount: bucketCount,
  });
  const createdAt = new Date(now).toISOString().slice(0, 19).replace("T", " ");
  let users = 0;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    // Buckets run sequentially to stay below the source warehouse memory limit.
    // eslint-disable-next-line no-await-in-loop
    const result = await stageWarehouseClickhouseClient().query({
      query: `
        SELECT user_id
        FROM (${compiled.query})
      `,
      query_params: { ...compiled.queryParams, warehouseBucket: bucket },
      format: "JSONEachRow",
      clickhouse_settings: {
        group_by_two_level_threshold: "100000",
        group_by_two_level_threshold_bytes: String(64 * 1024 * 1024),
        max_block_size: "8192",
        max_bytes_before_external_group_by: String(64 * 1024 * 1024),
        max_memory_usage: String(512 * 1024 * 1024),
        max_threads: 1,
      },
    });
    const stream: AsyncIterable<unknown> = result.stream();
    const bucketRows: { user_id: string }[] = [];
    // eslint-disable-next-line no-await-in-loop
    for await (const batch of stream) {
      if (!isClickhouseRowBatch(batch)) {
        throw new Error("Stage warehouse returned an invalid audience batch");
      }
      const rows = await Promise.all(
        batch.map((row) => row.json<{ user_id: string }>()),
      );
      bucketRows.push(...rows);
    }
    if (bucketRows.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      await clickhouseClient().insert({
        table: "stage_warehouse_audience",
        values: bucketRows.map((row) => ({
          workspace_id: workspaceId,
          broadcast_id: broadcastId,
          run_id: runId,
          user_id: row.user_id,
          created_at: createdAt,
        })),
        format: "JSONEachRow",
        clickhouse_settings: { wait_end_of_query: 1 },
      });
      users += bucketRows.length;
    }
  }
  return { runId, users };
}

export function sendMessagesFactory(sender: Sender) {
  return async function sendMessagesWithSender(
    params: SendMessagesParams,
  ): Promise<SendMessagesResponse> {
    return withSpan({ name: "send-messages" }, async (span) => {
      const now = new Date(params.now);
      span.setAttributes({
        workspaceId: params.workspaceId,
        broadcastId: params.broadcastId,
        timezones: params.timezones,
        workspaceOccupantId: params.workspaceOccupantId,
        workspaceOccupantType: params.workspaceOccupantType,
        cursor: params.cursor,
        limit: params.limit,
      });
      const broadcast = await getBroadcast({
        workspaceId: params.workspaceId,
        broadcastId: params.broadcastId,
      });
      if (!broadcast) {
        throw new Error("Broadcast not found");
      }
      if (broadcast.status !== "Running") {
        return {
          messagesSent: 0,
          nextCursor: params.cursor,
          includesNonRetryableError: false,
        };
      }
      const { messageTemplateId, config: unparsedConfig } = broadcast;
      if (!messageTemplateId) {
        throw new Error("Broadcast template is null");
      }
      const configResult = schemaValidateWithErr(
        unparsedConfig,
        BroadcastV2Config,
      );
      if (configResult.isErr()) {
        throw new Error("Broadcast config is invalid");
      }
      const config = configResult.value;

      span.setAttributes({
        segmentId: broadcast.segmentId,
        subscriptionGroupId: broadcast.subscriptionGroupId,
        templateId: broadcast.messageTemplateId,
      });

      if (!broadcast.subscriptionGroupId) {
        throw new Error("Broadcast subscription group is null");
      }

      const { users, nextCursor } =
        config.audienceSource === "StageWarehouse"
          ? await getStageWarehouseUsers({
              workspaceId: params.workspaceId,
              broadcastId: params.broadcastId,
              runId:
                config.warehouseAudienceRunId ??
                (() => {
                  throw new Error("Warehouse audience snapshot is missing");
                })(),
              cursor: params.cursor,
              limit: params.limit,
              now: params.now,
              channel: config.message.type,
            })
          : await getUnmessagedUsers({
              workspaceId: params.workspaceId,
              segmentFilter: broadcast.segmentId
                ? [broadcast.segmentId]
                : undefined,
              // This will account for subscription group logic
              subscriptionGroupFilter: broadcast.subscriptionGroupId
                ? [broadcast.subscriptionGroupId]
                : undefined,
              cursor: params.cursor,
              limit: params.limit,
              broadcastId: params.broadcastId,
              now: params.now,
            });

      const subscriptionGroup = await getSubscriptionGroupsWithAssignments({
        subscriptionGroupIds: [broadcast.subscriptionGroupId],
        userIds: users.map((user) => user.id),
        workspaceId: params.workspaceId,
      });

      const subscriptionGroupDetailsByUserId = subscriptionGroup.reduce(
        (acc, sg) => {
          acc.set(sg.userId, {
            ...getSubscriptionGroupDetails(sg),
            name: sg.name,
          });
          return acc;
        },
        new Map<string, SubscriptionGroupDetailsWithName>(),
      );

      const promises: Promise<{
        userId: string;
        result: BackendMessageSendResult;
        isAnonymous: boolean;
      }>[] = users.flatMap((user) => {
        return withSpan({ name: "send-messages-user" }, async (usersSpan) => {
          const isAnonymous = Object.values(user.properties).some(
            (property) => property.name === "anonymousId",
          );

          usersSpan.setAttributes({
            userId: user.id,
            isAnonymous,
            workspaceOccupantId: params.workspaceOccupantId,
            workspaceOccupantType: params.workspaceOccupantType,
            workspaceId: params.workspaceId,
            broadcastId: params.broadcastId,
            templateId: broadcast.messageTemplateId,
            segmentId: broadcast.segmentId,
            subscriptionGroupId: broadcast.subscriptionGroupId,
          });

          const userPropertyAssignments = Object.entries(
            user.properties,
          ).reduce<Record<string, JSONValue>>((acc, [_id, { value, name }]) => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            acc[name] = value;
            return acc;
          }, {});

          const messageId = getMessageId({
            broadcastId: params.broadcastId,
            userId: user.id,
            workspaceId: params.workspaceId,
          });
          const messageTags: MessageTags = {
            workspaceId: params.workspaceId,
            broadcastId: params.broadcastId,
            templateId: messageTemplateId,
            messageId,
            userId: user.id,
            channel: config.message.type,
          };
          if (params.workspaceOccupantId) {
            messageTags.workspaceOccupantId = params.workspaceOccupantId;
          }
          if (params.workspaceOccupantType) {
            messageTags.workspaceOccupantType = params.workspaceOccupantType;
          }
          const subscriptionGroupDetails = subscriptionGroupDetailsByUserId.get(
            user.id,
          );
          const baseParams: SendMessageParametersBase = {
            userId: user.id,
            workspaceId: params.workspaceId,
            templateId: messageTemplateId,
            useDraft: false,
            userPropertyAssignments,
            messageTags,
            subscriptionGroupDetails,
          };
          let messageVariant: SendMessageParameters;
          switch (config.message.type) {
            case ChannelType.Email:
              messageVariant = {
                ...baseParams,
                ...config.message,
                channel: ChannelType.Email,
              };
              break;
            case ChannelType.Sms:
              messageVariant = {
                ...baseParams,
                ...config.message,
                channel: ChannelType.Sms,
              };
              break;
            case ChannelType.Webhook:
              messageVariant = {
                ...baseParams,
                ...config.message,
                channel: ChannelType.Webhook,
              };
              break;
            case ChannelType.MobilePush:
              messageVariant = {
                ...baseParams,
                ...config.message,
                channel: ChannelType.MobilePush,
              };
              break;
          }
          logger().debug({ messageVariant }, "Sending broadcast message");
          const result = await sender(messageVariant);
          return {
            userId: user.id,
            isAnonymous,
            result,
          };
        });
      });
      const results = await Promise.all(promises);
      const baseProperties: TrackData["properties"] = {
        broadcastId: params.broadcastId,
        templateId: broadcast.messageTemplateId,
        workspaceId: params.workspaceId,
      };
      const events: BatchTrackData[] = results.map(
        ({ userId, result, isAnonymous }) => {
          const messageId = getMessageId({
            broadcastId: params.broadcastId,
            userId,
            workspaceId: params.workspaceId,
          });
          let event: InternalEventType;
          let trackingProperties: TrackData["properties"];
          if (result.isErr()) {
            event = result.error.type;
            trackingProperties = {
              ...baseProperties,
              ...omit(result.error, ["type"]),
            };
          } else {
            event = result.value.type;
            trackingProperties = {
              ...baseProperties,
              ...omit(result.value, ["type"]),
            };
          }
          return {
            ...(isAnonymous
              ? {
                  anonymousId: userId,
                }
              : {
                  userId,
                }),
            messageId,
            type: EventType.Track,
            timestamp: now.toISOString(),
            event,
            properties: trackingProperties,
          };
        },
      );
      logger().debug({ events }, "Broadcast events");
      await submitBatch({
        workspaceId: params.workspaceId,
        data: {
          batch: events,
        },
      });
      const includesNonRetryableError =
        config.errorHandling === "PauseOnError" &&
        results.some(
          ({ result }) => result.isErr() && isNonRetryableError(result.error),
        );
      return {
        messagesSent: results.length,
        nextCursor,
        includesNonRetryableError,
      };
    });
  };
}

export const sendMessages = sendMessagesFactory(sendMessage);

/**
 * Converts a naive datetime string (YYYY-MM-DD HH:MM:SS) to a Unix timestamp
 * (in seconds) by interpreting it within the given timezone, using date-fns-tz.
 *
 * @param naiveDateTimeString - The naive datetime string (e.g., "2025-12-25 09:30:00").
 * Assumes a format parseable by date-fns (ISO-like is safest).
 * @param timeZone - The IANA timezone identifier (e.g., "America/New_York", "Europe/London").
 * @returns The Unix timestamp in milliseconds since the epoch.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function getZonedTimestamp({
  naiveDateTimeString,
  timeZone,
}: {
  naiveDateTimeString: string;
  timeZone: string;
}): Promise<{
  timestamp: number | null;
}> {
  try {
    // 1. Parse the naive string, interpreting it in the specified timezone.
    // zonedTimeToUtc takes the date string and the timezone it *represents*.
    // It returns a standard JS Date object holding the equivalent UTC time.
    // Note: Ensure naiveDateTimeString is in a format date-fns can parse.
    // Common formats like 'YYYY-MM-DD HH:MM:SS' are usually okay,
    // but ISO 'YYYY-MM-DDTHH:MM:SS' is generally safer.
    const utcDate: Date = zonedTimeToUtc(naiveDateTimeString, timeZone);

    logger().debug(
      {
        utcDate: utcDate.toISOString(),
        naiveDateTimeString,
        timeZone,
      },
      "getZonedTimestamp",
    );
    return {
      timestamp: utcDate.getTime(),
    };
  } catch (error) {
    logger().error(
      {
        naiveDateTimeString,
        timeZone,
        error,
      },
      "Error converting naive datetime to timestamp with date-fns",
    );
    return { timestamp: null };
  }
}

export async function getBroadcastStatus({
  workspaceId,
  broadcastId,
}: {
  workspaceId: string;
  broadcastId: string;
}): Promise<BroadcastV2Status | null> {
  const model = await db().query.broadcast.findFirst({
    where: and(
      eq(schema.broadcast.id, broadcastId),
      eq(schema.broadcast.workspaceId, workspaceId),
    ),
  });
  if (!model) {
    return null;
  }
  if (model.statusV2 === null) {
    logger().error(
      {
        broadcastId,
        workspaceId,
      },
      "Broadcast status is null",
    );
    return null;
  }
  return model.statusV2;
}

export async function recomputeBroadcastSegment({
  workspaceId,
  broadcastId,
  now,
}: {
  workspaceId: string;
  broadcastId: string;
  now: number;
}): Promise<boolean> {
  const broadcast = await db().query.broadcast.findFirst({
    where: and(
      eq(schema.broadcast.id, broadcastId),
      eq(schema.broadcast.workspaceId, workspaceId),
    ),
    with: {
      segment: true,
    },
  });
  if (!broadcast) {
    logger().error(
      {
        broadcastId,
        workspaceId,
      },
      "Broadcast not found",
    );
    return false;
  }
  if (!broadcast.segmentId) {
    logger().debug(
      {
        broadcastId,
        workspaceId,
      },
      "Broadcast segment is null skipping recompute",
    );
    return false;
  }
  if (!broadcast.segment) {
    logger().error(
      {
        broadcastId,
        workspaceId,
      },
      "Broadcast segment not found",
    );
    return false;
  }
  const configResult = schemaValidateWithErr(
    broadcast.config,
    BroadcastV2Config,
  );
  if (configResult.isErr()) {
    logger().error(
      { broadcastId, workspaceId, err: configResult.error },
      "Broadcast config is invalid",
    );
    return false;
  }
  const segmentResource: SavedSegmentResource = unwrap(
    toSegmentResource(broadcast.segment),
  );
  if (configResult.value.audienceSource === "StageWarehouse") {
    const { runId, users } = await materializeStageWarehouseAudience({
      workspaceId,
      broadcastId,
      definition: segmentResource.definition,
      now,
    });
    await db()
      .update(schema.broadcast)
      .set({
        config: {
          ...configResult.value,
          warehouseAudienceRunId: runId,
        },
      })
      .where(
        and(
          eq(schema.broadcast.id, broadcastId),
          eq(schema.broadcast.workspaceId, workspaceId),
        ),
      );
    logger().info(
      { broadcastId, workspaceId, runId, users },
      "Stage warehouse audience materialized",
    );
    return true;
  }
  if (broadcast.segment.resourceType !== "Internal") {
    logger().info(
      {
        broadcastId,
        workspaceId,
      },
      "Broadcast segment is not internal skipping recompute",
    );
    return false;
  }
  const args: ComputePropertiesArgs = {
    workspaceId,
    segments: [segmentResource],
    userProperties: [],
    journeys: [],
    integrations: [],
    now,
  };
  await computePropertiesIncremental(args);
  return true;
}
