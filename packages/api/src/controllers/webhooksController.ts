import formbody from "@fastify/formbody";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { SpanStatusCode } from "@opentelemetry/api";
import { Type } from "@sinclair/typebox";
import { submitBatch } from "backend-lib/src/apps/batch";
import { canWorkspaceReceiveEvents } from "backend-lib/src/auth";
import {
  clickhouseClient,
  ClickHouseQueryBuilder,
} from "backend-lib/src/clickhouse";
import backendConfig from "backend-lib/src/config";
import { generateDigest } from "backend-lib/src/crypto";
import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import {
  confirmSubscription,
  handleSesNotification,
  validSNSSignature,
} from "backend-lib/src/destinations/amazonses";
import { submitMailChimpEvents } from "backend-lib/src/destinations/mailchimp";
import { submitPostmarkEvents } from "backend-lib/src/destinations/postmark";
import { submitResendEvents } from "backend-lib/src/destinations/resend";
import { handleSendgridEvents } from "backend-lib/src/destinations/sendgrid";
import { submitTwilioEvents } from "backend-lib/src/destinations/twilio";
import logger from "backend-lib/src/logger";
import { withSpan } from "backend-lib/src/openTelemetry";
import {
  AmazonSNSEvent,
  AmazonSNSEventTypes,
  BatchTrackData,
  EventType,
  InternalEventType,
  MailChimpEvent,
  PostMarkEvent,
  ResendEvent,
  SendgridEvent,
  TwilioEventSms,
} from "backend-lib/src/types";
import { insertUserEvents } from "backend-lib/src/userEvents";
import { createHmac, timingSafeEqual } from "crypto";
import { and, eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { fastifyRawBody } from "fastify-raw-body";
import {
  SecretNames,
  SourceType,
  WORKSPACE_ID_HEADER,
} from "isomorphic-lib/src/constants";
import {
  jsonParseSafe,
  schemaValidateWithErr,
} from "isomorphic-lib/src/resultHandling/schemaValidation";
import {
  MailChimpSecret,
  PostMarkSecret,
  ResendSecret,
  TwilioSecret,
  TwilioWebhookRequest,
  WorkspaceId,
} from "isomorphic-lib/src/types";
import * as R from "remeda";
import { Webhook } from "svix";
import { validateRequest } from "twilio";

import { getWorkspaceId } from "../workspace";

const TWILIO_CONFIG_ERR_MSG = "Twilio configuration not found";

const CeletelDlrStatus = Type.Union([Type.String(), Type.Number()]);

const CeletelDlr = Type.Object(
  {
    payloadVersion: Type.Optional(Type.String()),
    statuses: Type.Array(
      Type.Object(
        {
          msgId: Type.String(),
          status: CeletelDlrStatus,
          timestamp: Type.Optional(CeletelDlrStatus),
          url: Type.Optional(Type.String()),
          shortUrl: Type.Optional(Type.String()),
          userAgent: Type.Optional(Type.String()),
          error: Type.Optional(
            Type.Object(
              {
                code: Type.Optional(CeletelDlrStatus),
                title: Type.Optional(Type.String()),
              },
              { additionalProperties: true },
            ),
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const CeletelWebhookSecret = Type.Object(
  { celetelWebhookKey: Type.String() },
  { additionalProperties: true },
);

const MobilePushReceipt = Type.Object({
  event: Type.Union([Type.Literal("delivered"), Type.Literal("clicked")]),
  messageId: Type.String({ minLength: 1, maxLength: 200 }),
  userId: Type.String({ maxLength: 200 }),
  receiptToken: Type.String({ minLength: 1, maxLength: 200 }),
  timestamp: Type.Optional(Type.String({ maxLength: 50 })),
  deeplink: Type.Optional(Type.String({ maxLength: 2000 })),
  templateId: Type.Optional(Type.String({ maxLength: 200 })),
  broadcastId: Type.Optional(Type.String({ maxLength: 200 })),
  journeyId: Type.Optional(Type.String({ maxLength: 200 })),
  source: Type.Optional(Type.String({ maxLength: 100 })),
});

const LegacyMobilePushReceipt = Type.Object(
  {
    msg_id: Type.String({ minLength: 42, maxLength: 300 }),
    user_id: Type.Optional(Type.String({ maxLength: 200 })),
    deeplink: Type.Optional(Type.String({ maxLength: 2000 })),
    source: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: true },
);

interface CeletelMessageContext {
  message_id: string;
  user_id: string;
  anonymous_id: string;
  properties: string;
  template_id: string;
  broadcast_id: string;
  journey_id: string;
}

function celetelStatusEvent(status: string): InternalEventType | null {
  switch (status.toLowerCase()) {
    case "processed":
      return InternalEventType.WebhookProcessed;
    case "sent":
      return InternalEventType.WebhookSent;
    case "delivered":
      return InternalEventType.WebhookDelivered;
    case "read":
      return InternalEventType.WebhookRead;
    case "clicked":
      return InternalEventType.WebhookClicked;
    case "failed":
      return InternalEventType.WebhookFailed;
    default:
      return null;
  }
}

async function findCeletelMessageContexts({
  workspaceId,
  messageIds,
}: {
  workspaceId: string;
  messageIds: string[];
}): Promise<Map<string, CeletelMessageContext>> {
  const qb = new ClickHouseQueryBuilder();
  const result = await clickhouseClient().query({
    query: `
      SELECT
        message_id,
        user_id,
        anonymous_id,
        properties,
        template_id,
        broadcast_id,
        journey_id
      FROM internal_events
      WHERE
        workspace_id = ${qb.addQueryValue(workspaceId, "String")}
        AND message_id IN ${qb.addQueryValue(messageIds, "Array(String)")}
        AND event = '${InternalEventType.MessageSent}'
        AND channel_type = 'Webhook'
      ORDER BY processing_time DESC
    `,
    query_params: qb.getQueries(),
    format: "JSONEachRow",
  });
  const rows = await result.json<CeletelMessageContext>();
  return new Map(rows.map((row) => [row.message_id, row]));
}

function validCeletelWebhookKey({
  expected,
  received,
}: {
  expected: string;
  received: string;
}): boolean {
  const expectedBuffer = new TextEncoder().encode(expected);
  const receivedBuffer = new TextEncoder().encode(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

// eslint-disable-next-line @typescript-eslint/require-await
export default async function webhookController(fastify: FastifyInstance) {
  await fastify.register(formbody);
  await fastify.register(fastifyRawBody);

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  fastify.addHook("onSend", async (_request, reply, payload) => {
    if (reply.statusCode !== 400) {
      return payload;
    }
    logger().error(
      {
        payload,
      },
      "Failed to validate webhook payload.",
    );
    return payload;
  });

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/mobile-push",
    {
      schema: {
        description:
          "Records signed mobile push delivered and clicked receipts.",
        tags: ["Webhooks"],
        querystring: Type.Object({
          workspaceId: WorkspaceId,
        }),
        body: MobilePushReceipt,
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.query;
      const secret = await db().query.secret.findFirst({
        where: and(
          eq(schema.secret.workspaceId, workspaceId),
          eq(schema.secret.name, SecretNames.Fcm),
        ),
        with: {
          workspace: true,
        },
      });
      const key =
        secret?.value ??
        (secret?.configValue ? JSON.stringify(secret.configValue) : null);
      if (
        !key ||
        !secret?.workspace ||
        !canWorkspaceReceiveEvents({ workspace: secret.workspace })
      ) {
        return reply.status(401).send({ message: "Workspace not eligible." });
      }

      const expectedToken = generateDigest({
        rawBody: `${workspaceId}:${request.body.messageId}:${request.body.userId}`,
        sharedSecret: key,
      });
      if (
        !validCeletelWebhookKey({
          expected: expectedToken,
          received: request.body.receiptToken,
        })
      ) {
        return reply.status(401).send({ message: "Invalid receipt token." });
      }

      const event =
        request.body.event === "delivered"
          ? InternalEventType.MobilePushDelivered
          : InternalEventType.MobilePushClicked;
      const properties = {
        workspaceId,
        messageId: request.body.messageId,
        templateId: request.body.templateId,
        broadcastId: request.body.broadcastId,
        journeyId: request.body.journeyId,
        provider: "firebase",
        source: request.body.source ?? `dittofeed_push_${request.body.event}`,
        deeplink: request.body.deeplink,
      };
      const timestampValue = request.body.timestamp
        ? new Date(request.body.timestamp)
        : new Date();
      await submitBatch({
        workspaceId,
        data: {
          context: {
            source: SourceType.Webhook,
            provider: "firebase",
          },
          batch: [
            {
              type: EventType.Track,
              event,
              messageId: generateDigest({
                rawBody: `${request.body.messageId}:${request.body.event}`,
                sharedSecret: workspaceId,
              }),
              timestamp: Number.isNaN(timestampValue.getTime())
                ? new Date().toISOString()
                : timestampValue.toISOString(),
              userId: request.body.userId,
              properties,
            },
          ],
        },
      });
      return reply.status(200).send({ processed: 1 });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/mobile-push-legacy",
    {
      schema: {
        description:
          "Records mobile push receipts from Stage app releases that use the Engage payload contract.",
        tags: ["Webhooks"],
        querystring: Type.Object({
          workspaceId: WorkspaceId,
          event: Type.Union([
            Type.Literal("delivered"),
            Type.Literal("clicked"),
          ]),
        }),
        body: LegacyMobilePushReceipt,
      },
    },
    async (request, reply) => {
      const { workspaceId, event } = request.query;
      const separatorIndex = request.body.msg_id.lastIndexOf(".");
      const messageId = request.body.msg_id.slice(0, separatorIndex);
      const receiptToken = request.body.msg_id.slice(separatorIndex + 1);
      if (!messageId || !/^[a-f0-9]{40}$/.test(receiptToken)) {
        return reply.status(401).send({ message: "Invalid receipt token." });
      }

      const secret = await db().query.secret.findFirst({
        where: and(
          eq(schema.secret.workspaceId, workspaceId),
          eq(schema.secret.name, SecretNames.Fcm),
        ),
        with: {
          workspace: true,
        },
      });
      const key =
        secret?.value ??
        (secret?.configValue ? JSON.stringify(secret.configValue) : null);
      if (
        !key ||
        !secret?.workspace ||
        !canWorkspaceReceiveEvents({ workspace: secret.workspace })
      ) {
        return reply.status(401).send({ message: "Workspace not eligible." });
      }

      const expectedToken = generateDigest({
        rawBody: `${workspaceId}:${messageId}`,
        sharedSecret: key,
      });
      if (
        !validCeletelWebhookKey({
          expected: expectedToken,
          received: receiptToken,
        })
      ) {
        return reply.status(401).send({ message: "Invalid receipt token." });
      }

      const receiptEvents =
        event === "clicked"
          ? [
              InternalEventType.MobilePushClicked,
              InternalEventType.MobilePushDelivered,
            ]
          : [InternalEventType.MobilePushDelivered];
      await submitBatch({
        workspaceId,
        data: {
          context: {
            source: SourceType.Webhook,
            provider: "firebase",
          },
          batch: receiptEvents.map((receiptEvent) => ({
            type: EventType.Track,
            event: receiptEvent,
            messageId: generateDigest({
              rawBody: `${messageId}:${receiptEvent}`,
              sharedSecret: workspaceId,
            }),
            timestamp: new Date().toISOString(),
            userId: request.body.user_id ?? "",
            properties: {
              workspaceId,
              messageId,
              provider: "firebase",
              source: `dittofeed_legacy_push_${event}`,
              deeplink: request.body.deeplink,
              campaignId: `c_df_${workspaceId}`,
            },
          })),
        },
      });
      return reply.status(200).send({ processed: receiptEvents.length });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/celetel",
    {
      schema: {
        description: "Used to consume Celetel WhatsApp delivery callbacks.",
        tags: ["Webhooks"],
        headers: Type.Object({
          "x-celetel-webhook-key": Type.String(),
        }),
        querystring: Type.Object({
          workspaceId: WorkspaceId,
        }),
        body: CeletelDlr,
      },
    },
    async (request, reply) => {
      const { workspaceId } = request.query;
      const secret = await db().query.secret.findFirst({
        where: and(
          eq(schema.secret.workspaceId, workspaceId),
          eq(schema.secret.name, SecretNames.Webhook),
        ),
        with: {
          workspace: true,
        },
      });
      const webhookSecret = schemaValidateWithErr(
        secret?.configValue,
        CeletelWebhookSecret,
      );
      if (
        webhookSecret.isErr() ||
        !validCeletelWebhookKey({
          expected: webhookSecret.value.celetelWebhookKey,
          received: request.headers["x-celetel-webhook-key"],
        })
      ) {
        return reply.status(401).send({ message: "Invalid webhook key." });
      }
      if (
        !secret?.workspace ||
        !canWorkspaceReceiveEvents({ workspace: secret.workspace })
      ) {
        return reply.status(401).send({ message: "Workspace not eligible." });
      }

      const recognizedStatuses = request.body.statuses.flatMap((status) => {
        const event = celetelStatusEvent(String(status.status));
        const messageId = status.msgId.trim();
        return event && messageId ? [{ event, messageId, status }] : [];
      });
      const messageIds = [
        ...new Set(recognizedStatuses.map((s) => s.messageId)),
      ];
      if (messageIds.length === 0) {
        return reply.status(200).send({ processed: 0 });
      }

      const contexts = await findCeletelMessageContexts({
        workspaceId,
        messageIds,
      });
      const batch = recognizedStatuses.flatMap(
        ({ event, messageId, status }): BatchTrackData[] => {
          const context = contexts.get(messageId);
          if (!context) {
            logger().warn(
              { workspaceId, messageId },
              "Celetel callback did not match a Dittofeed webhook delivery.",
            );
            return [];
          }
          const timestampSeconds = Number(status.timestamp);
          const timestamp = Number.isFinite(timestampSeconds)
            ? new Date(timestampSeconds * 1000).toISOString()
            : new Date().toISOString();
          const sentProperties = jsonParseSafe(context.properties).unwrapOr({});
          const properties = {
            ...(typeof sentProperties === "object" && sentProperties !== null
              ? sentProperties
              : {}),
            workspaceId,
            messageId,
            templateId: context.template_id || undefined,
            broadcastId: context.broadcast_id || undefined,
            journeyId: context.journey_id || undefined,
            provider: "celetel",
            providerStatus: String(status.status).toLowerCase(),
            errorCode: status.error?.code,
            errorReason: status.error?.title,
            url: status.url,
            shortUrl: status.shortUrl,
            userAgent: status.userAgent,
          };
          const base = {
            type: EventType.Track,
            event,
            messageId: generateDigest({
              rawBody: `${messageId}:${String(status.status).toLowerCase()}`,
              sharedSecret: workspaceId,
            }),
            timestamp,
            properties,
          } as const;
          if (context.user_id) {
            return [{ ...base, userId: context.user_id }];
          }
          if (context.anonymous_id) {
            return [{ ...base, anonymousId: context.anonymous_id }];
          }
          return [];
        },
      );
      if (batch.length > 0) {
        await submitBatch({
          workspaceId,
          data: {
            context: {
              source: SourceType.Webhook,
              provider: "celetel",
            },
            batch,
          },
        });
      }
      return reply.status(200).send({ processed: batch.length });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/sendgrid",
    {
      schema: {
        description: "Used to consume sendgrid webhook payloads.",
        tags: ["Webhooks"],
        headers: Type.Object({
          "x-twilio-email-event-webhook-signature": Type.String(),
          "x-twilio-email-event-webhook-timestamp": Type.String(),
        }),
        body: Type.Array(SendgridEvent),
      },
    },
    async (request, reply) => {
      logger().debug({ body: request.body }, "Received sendgrid events.");
      const result = await handleSendgridEvents({
        sendgridEvents: request.body,
        webhookSignature:
          request.headers["x-twilio-email-event-webhook-signature"],
        webhookTimestamp:
          request.headers["x-twilio-email-event-webhook-timestamp"],
        rawBody: request.rawBody,
      });
      if (result.isErr()) {
        logger().info(
          {
            err: result.error,
          },
          "Error handling sendgrid webhook.",
        );
        return reply.status(400).send({
          message: result.error.message,
        });
      }
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/amazon-ses",
    {
      schema: {
        description: "Used to consume amazonses notification events.",
        tags: ["Webhooks"],
        body: AmazonSNSEvent,
      },
      // Force JSON parsing the request body as SNS send requests with text/plain content-type.
      onRequest: (req, _, done) => {
        // eslint-disable-next-line no-param-reassign
        req.headers["content-type"] = "application/json";
        done();
      },
    },
    async (request, reply) => {
      return withSpan({ name: "amazon-ses-webhook" }, async (span) => {
        logger().debug({ body: request.body }, "Received AmazonSES event.");

        const { body } = request;
        // Validate the signature
        const valid = await validSNSSignature(body);

        if (valid.isErr()) {
          logger().error(
            "Invalid signature for AmazonSES webhook.",
            valid.error,
          );
          return reply.status(401).send({ message: "Invalid signature" });
        }

        span.setAttribute("type", body.Type);
        switch (body.Type) {
          // Amazon will send a confirmation Type event we must use to enable (subscribe to) the webhook.
          // UnsubscribeConfirmation type events occur when our application requests disabling
          // the webhook. Since we never do this, we respond by re-confirming the subscription.
          case AmazonSNSEventTypes.SubscriptionConfirmation:
          case AmazonSNSEventTypes.UnsubscribeConfirmation:
            /* eslint-disable-next-line no-case-declarations */
            const confirmed = await confirmSubscription(body);
            if (confirmed.isErr()) {
              logger().error("Unable to confirm AmazonSNS subscription.", {
                error: confirmed.error,
              });
              return reply.status(401).send({});
            }
            logger().debug("AmazonSES Subscription confirmed");
            break;
          case AmazonSNSEventTypes.Notification: {
            const result = await handleSesNotification(body);
            if (result.isErr()) {
              logger().error("Error handling AmazonSES notification.", {
                error: result.error,
              });
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: result.error.message,
              });
              return reply.status(500).send();
            }
            break;
          }
        }

        return reply.status(200).send();
      });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/resend",
    {
      schema: {
        description: "Used to consume resend webhook payloads.",
        tags: ["Webhooks"],
        headers: Type.Object({
          "svix-id": Type.String(),
          "svix-timestamp": Type.String(),
          "svix-signature": Type.String(),
        }),
        body: ResendEvent,
      },
    },
    async (request, reply) => {
      logger().debug({ body: request.body }, "Received resend events.");

      const { workspaceId } = request.body.data.tags;
      if (!workspaceId) {
        logger().info(
          {
            tags: request.body.data.tags,
          },
          "Missing workspaceId on resend tags",
        );
        return reply.status(200).send();
      }

      if (!workspaceId) {
        logger().error("Missing workspaceId on resend events.");
        return reply.status(400).send({
          error: "Missing workspaceId custom arg.",
        });
      }

      const secret = await db().query.secret.findFirst({
        where: and(
          eq(schema.secret.workspaceId, workspaceId),
          eq(schema.secret.name, SecretNames.Resend),
        ),
        with: {
          workspace: true,
        },
      });

      const webhookKey = schemaValidateWithErr(
        secret?.configValue,
        ResendSecret,
      )
        .map((val) => val.webhookKey)
        .unwrapOr(null);

      if (!webhookKey) {
        logger().error(
          {
            workspaceId,
          },
          "Missing resend webhook secret.",
        );
        return reply.status(400).send({
          error: "Missing secret.",
        });
      }

      if (!request.rawBody || typeof request.rawBody !== "string") {
        logger().error({ workspaceId }, "Missing rawBody on resend webhook.");
        return reply.status(500).send();
      }

      const wh = new Webhook(webhookKey);
      const verified = wh.verify(request.rawBody, request.headers);

      if (!verified) {
        logger().error(
          {
            workspaceId,
          },
          "Invalid signature for resend webhook.",
        );
        return reply.status(401).send({
          message: "Invalid signature.",
        });
      }

      if (
        !secret?.workspace ||
        !canWorkspaceReceiveEvents({ workspace: secret.workspace })
      ) {
        return reply.status(401).send({
          message: "Workspace not eligible.",
        });
      }

      await submitResendEvents({
        workspaceId,
        events: [request.body],
      });
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/postmark",
    {
      schema: {
        description: "Used to consume postmark webhook payloads.",
        tags: ["Webhooks"],
        headers: Type.Object({
          "x-postmark-secret": Type.String(),
        }),
        body: PostMarkEvent,
      },
    },
    async (request, reply) => {
      logger().debug({ body: request.body }, "Received postmark events.");
      const { workspaceId } = request.body.Metadata;

      if (!workspaceId || typeof workspaceId !== "string") {
        logger().error("Missing workspaceId in Metadata.");
        return reply.status(400).send({
          error: "Missing workspaceId in Metadata.",
        });
      }

      const secret = await db().query.secret.findFirst({
        where: and(
          eq(schema.secret.workspaceId, workspaceId),
          eq(schema.secret.name, SecretNames.Postmark),
        ),
        with: {
          workspace: true,
        },
      });

      const secretHeader = request.headers["x-postmark-secret"];

      const webhookKey = schemaValidateWithErr(
        secret?.configValue,
        PostMarkSecret,
      )
        .map((val) => val.webhookKey)
        .unwrapOr(null);

      if (!webhookKey) {
        logger().error(
          {
            workspaceId,
          },
          "Missing postmark webhook secret.",
        );
        return reply.status(400).send({
          error: "Missing secret.",
        });
      }

      if (webhookKey !== secretHeader) {
        logger().error("Invalid signature for PostMark webhook.");
        return reply.status(401).send({
          message: "Invalid signature.",
        });
      }

      if (
        !secret?.workspace ||
        !canWorkspaceReceiveEvents({ workspace: secret.workspace })
      ) {
        return reply.status(401).send({
          message: "Workspace not eligible.",
        });
      }

      await submitPostmarkEvents({
        workspaceId,
        events: [request.body],
      });
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/mailchimp",
    {
      schema: {
        description: "Used to consume Mailchimp (Mandrill) webhook payloads.",
        tags: ["Webhooks"],
        body: Type.Object(
          {
            mandrill_events: Type.String(),
          },
          {
            additionalProperties: true,
          },
        ),
        headers: Type.Object({
          "x-mandrill-signature": Type.String(),
        }),
      },
    },
    async (request, reply) => {
      const eventsResult = jsonParseSafe(request.body.mandrill_events);
      if (eventsResult.isErr()) {
        logger().error(
          {
            err: eventsResult.error,
          },
          "Failed to parse Mailchimp webhook payload",
        );
        return reply.status(400).send({
          error: "Invalid JSON in mandrill_events",
        });
      }

      const events = eventsResult.value;
      if (!Array.isArray(events)) {
        logger().error(
          {
            events,
          },
          "Invalid Mailchimp webhook payload",
        );
        return reply.status(400).send({
          error: "Invalid Mailchimp webhook payload",
        });
      }
      const parsedEvents: MailChimpEvent[] = [];
      for (const event of events) {
        const parsedEvent = schemaValidateWithErr(event, MailChimpEvent);
        if (parsedEvent.isErr()) {
          logger().error(
            {
              err: parsedEvent.error,
            },
            "Failed to parse Mailchimp webhook payload",
          );
          continue;
        }
        parsedEvents.push(parsedEvent.value);
      }

      if (parsedEvents.length === 0) {
        logger().debug(
          {
            rawBody: request.rawBody,
          },
          "No events in Mailchimp webhook",
        );
        return reply.status(200).send();
      }

      let workspaceId: string | null = null;
      for (const event of parsedEvents) {
        if (event.msg.metadata.workspaceId) {
          workspaceId = event.msg.metadata.workspaceId;
          break;
        }
      }

      if (!workspaceId || typeof workspaceId !== "string") {
        logger().error(
          {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            workspaceId,
            parsedEvents,
          },
          "Missing workspaceId in Mailchimp webhook metadata",
        );
        return reply.status(400).send({
          error: "Missing workspaceId in metadata.",
        });
      }

      const secret = await db().query.secret.findFirst({
        where: and(
          eq(schema.secret.workspaceId, workspaceId),
          eq(schema.secret.name, SecretNames.MailChimp),
        ),
        with: {
          workspace: true,
        },
      });

      const webhookKey = schemaValidateWithErr(
        secret?.configValue,
        MailChimpSecret,
      )
        .map((val) => val.webhookKey)
        .unwrapOr(null);

      if (!webhookKey) {
        logger().error(
          {
            workspaceId,
          },
          "Missing mandrill webhook secret.",
        );
        return reply.status(400).send({
          error: "Missing secret.",
        });
      }

      const signature = request.headers["x-mandrill-signature"];
      const url = `${backendConfig().dashboardUrl}${request.url}`;
      const params = request.body;

      const signedData =
        url +
        R.sortBy(R.entries(params), ([key]) => key)
          .map(([key, value]) => `${key}${value}`)
          .join("");

      const expectedSignature = createHmac("sha1", webhookKey)
        .update(signedData)
        .digest("base64");

      if (signature !== expectedSignature) {
        logger().info(
          {
            workspaceId,
            signature,
            expectedSignature,
            url,
            signedData,
            rawBody: request.rawBody,
          },
          "Invalid signature for Mailchimp webhook.",
        );
        return reply.status(401).send({
          message: "Invalid signature.",
        });
      }

      if (
        !secret?.workspace ||
        !canWorkspaceReceiveEvents({ workspace: secret.workspace })
      ) {
        return reply.status(401).send({
          message: "Workspace not eligible.",
        });
      }

      await submitMailChimpEvents({
        events: parsedEvents,
      });

      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/twilio",
    {
      schema: {
        description: "Used to consume Twilio webhook payloads.",
        tags: ["Webhooks"],
        headers: Type.Object({
          "x-twilio-signature": Type.String(),
        }),
        body: TwilioEventSms,
        querystring: TwilioWebhookRequest,
      },
    },
    async (request, reply) => {
      const { workspaceId, userId, subscriptionGroupId, ...tags } =
        request.query;

      const twilioSecretModel = await db().query.secret.findFirst({
        where: and(
          eq(schema.secret.workspaceId, workspaceId),
          eq(schema.secret.name, SecretNames.Twilio),
        ),
        with: {
          workspace: true,
        },
      });

      const twilioSecretResult = schemaValidateWithErr(
        twilioSecretModel?.configValue,
        TwilioSecret,
      );
      if (twilioSecretResult.isErr()) {
        return reply.status(503).send({
          message: TWILIO_CONFIG_ERR_MSG,
        });
      }
      const twilioSecret = twilioSecretResult.value;
      if (
        !twilioSecret.authToken ||
        !twilioSecret.accountSid ||
        !twilioSecret.messagingServiceSid
      ) {
        return reply.status(503).send({
          message: TWILIO_CONFIG_ERR_MSG,
        });
      }

      const verified = validateRequest(
        twilioSecret.authToken,
        request.headers["x-twilio-signature"],
        `${backendConfig().dashboardUrl}${request.url}`,
        request.body,
      );

      if (!verified) {
        logger().error(
          {
            workspaceId,
          },
          "Invalid signature for twilio webhook.",
        );
        return reply.status(401).send({
          message: "Invalid signature.",
        });
      }

      if (
        !twilioSecretModel?.workspace ||
        !canWorkspaceReceiveEvents({ workspace: twilioSecretModel.workspace })
      ) {
        return reply.status(401).send({
          message: "Workspace not eligible.",
        });
      }

      await submitTwilioEvents({
        ...tags,
        workspaceId,
        userId,
        TwilioEvent: request.body,
        subscriptionGroupId,
      });
      return reply.status(200).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/segment",
    {
      schema: {
        description:
          "Used to consume segment.io webhook payloads. Must be exposed publicly to the internet.",
        tags: ["Webhooks"],
        body: Type.Object(
          {
            messageId: Type.String(),
            timestamp: Type.String(),
          },
          { additionalProperties: true },
        ),
        headers: Type.Object({
          "x-signature": Type.String(),
          [WORKSPACE_ID_HEADER]: Type.Optional(WorkspaceId),
        }),
      },
    },
    async (request, reply) => {
      const workspaceIdResult = await getWorkspaceId(request);
      if (workspaceIdResult.isErr()) {
        return reply.status(400).send();
      }
      const workspaceId = workspaceIdResult.value;
      if (!workspaceId) {
        return reply.status(400).send({
          error: "Missing workspaceId. Try setting the df-workspace-id header.",
        });
      }
      const config = await db().query.segmentIoConfiguration.findFirst({
        where: eq(schema.segmentIoConfiguration.workspaceId, workspaceId),
        with: {
          workspace: true,
        },
      });

      if (!config) {
        return reply.status(503).send();
      }

      if (!request.rawBody || typeof request.rawBody !== "string") {
        // Should always be defined
        return reply.status(500).send();
      }

      const { sharedSecret } = config;
      const signature = request.headers["x-signature"];

      const digest = generateDigest({
        rawBody: request.rawBody,
        sharedSecret,
      });

      if (signature !== digest) {
        return reply.status(401).send();
      }

      if (!canWorkspaceReceiveEvents({ workspace: config.workspace })) {
        return reply.status(401).send({
          message: "Workspace not eligible.",
        });
      }

      await insertUserEvents({
        workspaceId,
        userEvents: [
          {
            messageId: request.body.messageId,
            messageRaw: request.rawBody,
          },
        ],
      });

      return reply.status(200).send();
    },
  );
}
