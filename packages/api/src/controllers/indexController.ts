/* eslint-disable no-await-in-loop */
import { randomUUID } from "node:crypto";

import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Static, Type } from "@sinclair/typebox";
import { submitBatch } from "backend-lib/src/apps/batch";
import { clickhouseClient } from "backend-lib/src/clickhouse";
import config from "backend-lib/src/config";
import { generateDigest } from "backend-lib/src/crypto";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import {
  BroadcastV2Config,
  ChannelType,
  EventType,
  InAppTemplateResource,
  InternalEventType,
} from "backend-lib/src/types";
import { and, eq } from "drizzle-orm";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { schemaValidateWithErr } from "isomorphic-lib/src/resultHandling/schemaValidation";

const PendingQuery = Type.Object({
  user_id: Type.String({ minLength: 1, maxLength: 200 }),
  event: Type.String({ minLength: 1, maxLength: 100 }),
  screen: Type.Optional(Type.String({ maxLength: 200 })),
  app_version: Type.Optional(Type.String({ maxLength: 50 })),
  platform: Type.Optional(Type.String({ maxLength: 20 })),
  session_id: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
});

const InAppEventBody = Type.Object({
  user_id: Type.String({ minLength: 1, maxLength: 200 }),
  msg_id: Type.String({ minLength: 1, maxLength: 200 }),
  template: Type.Optional(Type.String({ maxLength: 100 })),
  session_id: Type.Optional(Type.String({ maxLength: 200 })),
  device_ts: Type.Optional(Type.String({ maxLength: 50 })),
  deeplink: Type.Optional(Type.String({ maxLength: 2000 })),
  source: Type.Optional(Type.String({ maxLength: 100 })),
  cta_id: Type.Optional(Type.String({ maxLength: 100 })),
});

type InAppEventBody = Static<typeof InAppEventBody>;

function safeImageUrl(value?: string): string {
  if (!value) return "";
  try {
    return new URL(value).protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}

function safeDeeplink(value: string): string {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "stage:" ? value : "";
  } catch {
    return "";
  }
}

async function inAudience({
  workspaceId,
  broadcastId,
  runId,
  userId,
}: {
  workspaceId: string;
  broadcastId: string;
  runId: string;
  userId: string;
}) {
  const result = await clickhouseClient().query({
    query: `
      SELECT 1
      FROM stage_warehouse_audience
      WHERE workspace_id = {workspaceId:String}
        AND broadcast_id = {broadcastId:String}
        AND run_id = {runId:String}
        AND user_id = {userId:String}
      LIMIT 1
    `,
    query_params: { workspaceId, broadcastId, runId, userId },
    format: "JSONEachRow",
  });
  return (await result.json()).length > 0;
}

async function withinFrequencyCaps({
  workspaceId,
  broadcastId,
  userId,
  sessionId,
  definition,
}: {
  workspaceId: string;
  broadcastId: string;
  userId: string;
  sessionId?: string;
  definition: InAppTemplateResource;
}) {
  const result = await clickhouseClient().query({
    query: `
      SELECT
        countIf(event_time >= now() - INTERVAL 24 HOUR) AS count_24h,
        countIf(event_time >= now() - INTERVAL 7 DAY) AS count_7d,
        countIf({sessionId:String} != '' AND JSONExtractString(properties, 'sessionId') = {sessionId:String}) AS count_session,
        max(toUnixTimestamp(event_time)) AS last_shown
      FROM internal_events
      WHERE workspace_id = {workspaceId:String}
        AND broadcast_id = {broadcastId:String}
        AND user_id = {userId:String}
        AND event = {event:String}
        AND event_time >= now() - INTERVAL 7 DAY
    `,
    query_params: {
      workspaceId,
      broadcastId,
      userId,
      sessionId: sessionId ?? "",
      event: InternalEventType.InAppImpression,
    },
    format: "JSONEachRow",
  });
  const [row] = await result.json<{
    count_24h: string;
    count_7d: string;
    count_session: string;
    last_shown: string;
  }>();
  if (!row) return true;
  const secondsSinceLast =
    Math.floor(Date.now() / 1000) - Number(row.last_shown);
  return (
    Number(row.count_24h) < definition.maxPer24h &&
    Number(row.count_7d) < definition.maxPer7d &&
    (!sessionId || Number(row.count_session) < definition.maxPerSession) &&
    (!Number(row.last_shown) ||
      secondsSinceLast >= definition.minGapBetweenShowsSec)
  );
}

async function recordInAppEvent({
  campaignId,
  event,
  body,
}: {
  campaignId: string;
  event: InternalEventType;
  body: InAppEventBody;
}) {
  const broadcast = await db().query.broadcast.findFirst({
    where: eq(schema.broadcast.id, campaignId),
  });
  if (!broadcast) return false;
  const timestamp = body.device_ts ? new Date(body.device_ts) : new Date();
  await submitBatch({
    workspaceId: broadcast.workspaceId,
    data: {
      context: { source: "webhook" },
      batch: [
        {
          type: EventType.Track,
          event,
          userId: body.user_id,
          messageId: generateDigest({
            rawBody: `${body.msg_id}:${event}`,
            sharedSecret: broadcast.workspaceId,
          }),
          timestamp: Number.isNaN(timestamp.getTime())
            ? new Date().toISOString()
            : timestamp.toISOString(),
          properties: {
            broadcastId: campaignId,
            templateId: broadcast.messageTemplateId ?? "",
            messageId: body.msg_id,
            sessionId: body.session_id ?? "",
            template: body.template ?? "",
            deeplink: body.deeplink ?? "",
            source: body.source ?? "",
            ctaId: body.cta_id ?? "",
            variant: { type: ChannelType.InApp },
          },
        },
      ],
    },
  });
  return true;
}

// eslint-disable-next-line @typescript-eslint/require-await
export default async function indexController(
  fastify: FastifyInstance,
  options: { inAppCallbacksOnly?: boolean },
) {
  if (!options.inAppCallbacksOnly) {
    fastify.get(
      "/",
      { schema: { description: "Application health check endpoint." } },
      async (_request: FastifyRequest, reply: FastifyReply) =>
        reply.status(200).send({ version: config().appVersion }),
    );

    fastify
      .withTypeProvider<TypeBoxTypeProvider>()
      .get(
        "/inapp/pending",
        { schema: { querystring: PendingQuery } },
        async (request, reply) => {
          const {
            user_id: userId,
            event,
            screen,
            session_id: sessionId,
          } = request.query;
          const broadcasts = await db().query.broadcast.findMany({
            where: eq(schema.broadcast.statusV2, "Running"),
          });
          const candidates: {
            broadcast: (typeof broadcasts)[number];
            definition: InAppTemplateResource;
          }[] = [];
          for (const broadcast of broadcasts) {
            const parsedConfig = schemaValidateWithErr(
              broadcast.config,
              BroadcastV2Config,
            );
            if (
              parsedConfig.isErr() ||
              parsedConfig.value.message.type !== ChannelType.InApp
            )
              continue;
            const runId = parsedConfig.value.warehouseAudienceRunId;
            if (!runId || !broadcast.messageTemplateId) continue;
            const template = await db().query.messageTemplate.findFirst({
              where: and(
                eq(schema.messageTemplate.id, broadcast.messageTemplateId),
                eq(schema.messageTemplate.workspaceId, broadcast.workspaceId),
              ),
            });
            const parsedTemplate = schemaValidateWithErr(
              template?.definition,
              InAppTemplateResource,
            );
            if (parsedTemplate.isErr()) continue;
            const definition = parsedTemplate.value;
            if (
              definition.trigger !== event ||
              (definition.screen && definition.screen !== screen)
            )
              continue;
            if (
              !(await inAudience({
                workspaceId: broadcast.workspaceId,
                broadcastId: broadcast.id,
                runId,
                userId,
              }))
            )
              continue;
            if (
              !(await withinFrequencyCaps({
                workspaceId: broadcast.workspaceId,
                broadcastId: broadcast.id,
                userId,
                sessionId,
                definition,
              }))
            )
              continue;
            candidates.push({ broadcast, definition });
          }
          candidates.sort(
            (a, b) =>
              b.definition.displayPriority - a.definition.displayPriority,
          );
          const campaigns = candidates
            .slice(0, request.query.limit ?? 1)
            .map(({ broadcast, definition }) => ({
              campaign_id: broadcast.id,
              msg_id: randomUUID(),
              template: definition.template,
              title: definition.title,
              body: definition.body,
              image_url: safeImageUrl(definition.imageUrl),
              cta: definition.cta
                .map((cta) => ({
                  ...cta,
                  deeplink: safeDeeplink(cta.deeplink),
                }))
                .filter((cta) => cta.deeplink),
              dismissible: definition.dismissible,
              display_priority: definition.displayPriority,
            }));
          return reply.status(200).send({
            campaigns,
            server_ts: new Date().toISOString(),
            next_check_in_sec: 60,
          });
        },
      );
  }

  const eventRoutes = [
    ["impression", InternalEventType.InAppImpression],
    ["click", InternalEventType.InAppClicked],
    ["dismiss", InternalEventType.InAppDismissed],
  ] as const;
  for (const [path, event] of eventRoutes) {
    fastify.withTypeProvider<TypeBoxTypeProvider>().post(
      `/inapp/:campaignId/${path}`,
      {
        schema: {
          params: Type.Object({ campaignId: Type.String({ format: "uuid" }) }),
          body: InAppEventBody,
        },
      },
      async (request, reply) => {
        const recorded = await recordInAppEvent({
          campaignId: request.params.campaignId,
          event,
          body: request.body,
        });
        return reply.status(recorded ? 200 : 404).send({ recorded });
      },
    );
  }
}
