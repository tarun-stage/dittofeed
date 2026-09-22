import axios, { AxiosHeaders, AxiosResponse } from "axios";
import { randomUUID, webcrypto } from "crypto";
import { SecretNames } from "isomorphic-lib/src/constants";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  AppFileType,
  BadWorkspaceConfigurationType,
  Base64EncodedFile,
  ParsedWebhookBody,
  WebhookTemplateResource,
  WorkspaceTypeAppEnum,
} from "isomorphic-lib/src/types";
import { ok } from "neverthrow";

import config from "./config";
import { generateDigest } from "./crypto";
import { insert } from "./db";
import {
  messageTemplate as dbMessageTemplate,
  secret as dbSecret,
  subscriptionGroup as dbSubscriptionGroup,
  userProperty as dbUserProperty,
  workspace as dbWorkspace,
} from "./db/schema";
import { sendNotification as sendFcmNotification } from "./destinations/fcm";
import {
  batchMessageUsers,
  normalizeCeletelWhatsAppTemplates,
  sendEmail,
  sendMobilePush,
  sendSms,
  sendWebhook,
  upsertMessageTemplate,
} from "./messaging";
import { upsertEmailProvider } from "./messaging/email";
import { upsertSmsProvider } from "./messaging/sms";
import {
  upsertSubscriptionGroup,
  upsertSubscriptionSecret,
} from "./subscriptionGroups";
import {
  BatchMessageUsersResultTypeEnum,
  ChannelType,
  EmailContentsType,
  EmailProviderType,
  EmailTemplateResource,
  InternalEventType,
  MessageSkippedType,
  MessageTags,
  MessageTemplate,
  MobilePushProviderType,
  MobilePushTemplateResource,
  SmsProviderType,
  SmsTemplateResource,
  SubscriptionGroup,
  SubscriptionGroupType,
  UpsertMessageTemplateValidationErrorType,
  UserPropertyDefinitionType,
  Workspace,
} from "./types";
import { getStoredEmailForViewInBrowser } from "./viewInBrowser";

jest.mock("axios");
jest.mock("./destinations/fcm");

const mockAxios = axios as jest.Mocked<typeof axios>;
const mockSendFcmNotification = jest.mocked(sendFcmNotification);

async function setupEmailTemplate(workspace: Workspace) {
  const templatePromise = insert({
    table: dbMessageTemplate,
    values: {
      id: randomUUID(),
      workspaceId: workspace.id,
      name: `template-${randomUUID()}`,
      definition: {
        type: ChannelType.Email,
        from: "support@company.com",
        subject: "Hello",
        body: "{% unsubscribe_link here %}.",
      } satisfies EmailTemplateResource,
      updatedAt: new Date(),
      createdAt: new Date(),
    },
  }).then(unwrap);
  const subscriptionGroupPromise = upsertSubscriptionGroup({
    workspaceId: workspace.id,
    name: `group-${randomUUID()}`,
    type: SubscriptionGroupType.OptOut,
    channel: ChannelType.Email,
  }).then(unwrap);

  const [template, subscriptionGroup] = await Promise.all([
    templatePromise,
    subscriptionGroupPromise,
    upsertEmailProvider({
      workspaceId: workspace.id,
      config: { type: EmailProviderType.Test },
    }),
    upsertSubscriptionSecret({
      workspaceId: workspace.id,
    }),
  ]);
  return { template, subscriptionGroup };
}

describe("normalizeCeletelWhatsAppTemplates", () => {
  it("normalizes Celetel and Meta template-list response shapes", () => {
    expect(
      normalizeCeletelWhatsAppTemplates({
        data: {
          data: {
            0: {
              name: "welcome_hi",
              language: "hi",
              status: "APPROVED",
              category: "MARKETING",
              components: [
                {
                  type: "HEADER",
                  format: "IMAGE",
                  example: {
                    header_handle: ["https://cdn.example.com/header.jpg"],
                  },
                },
                { type: "BODY", text: "Namaste {{1}}" },
              ],
            },
          },
        },
      }),
    ).toEqual([
      {
        name: "welcome_hi",
        languageCode: "hi",
        status: "APPROVED",
        category: "MARKETING",
        components: [
          {
            type: "HEADER",
            format: "IMAGE",
            example: {
              header_handle: ["https://cdn.example.com/header.jpg"],
            },
          },
          { type: "BODY", text: "Namaste {{1}}" },
        ],
        bodyText: "Namaste {{1}}",
        headerFormat: "IMAGE",
        headerExampleUrl: "https://cdn.example.com/header.jpg",
      },
    ]);
  });
});

describe("messaging", () => {
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = unwrap(
      await insert({
        table: dbWorkspace,
        values: {
          id: randomUUID(),
          name: `workspace-${randomUUID()}`,
          updatedAt: new Date(),
          createdAt: new Date(),
        },
      }),
    );
  });

  describe("sendEmail", () => {
    describe("when sent from a child workspace", () => {
      let childWorkspace: Workspace;
      let parentWorkspace: Workspace;
      let template: MessageTemplate;
      let subscriptionGroup: SubscriptionGroup;

      beforeEach(async () => {
        const parentWorkspaceId = randomUUID();
        [parentWorkspace, childWorkspace] = await Promise.all([
          insert({
            table: dbWorkspace,
            values: {
              id: parentWorkspaceId,
              name: `parent-workspace-${randomUUID()}`,
              type: WorkspaceTypeAppEnum.Parent,
              updatedAt: new Date(),
              createdAt: new Date(),
            },
          }).then(unwrap),
          insert({
            table: dbWorkspace,
            values: {
              id: randomUUID(),
              parentWorkspaceId,
              name: `child-workspace-${randomUUID()}`,
              type: WorkspaceTypeAppEnum.Child,
              updatedAt: new Date(),
              createdAt: new Date(),
            },
          }).then(unwrap),
        ]);
        [template, subscriptionGroup] = await Promise.all([
          insert({
            table: dbMessageTemplate,
            values: {
              id: randomUUID(),
              workspaceId: childWorkspace.id,
              name: `template-${randomUUID()}`,
              updatedAt: new Date(),
              createdAt: new Date(),
              definition: {
                type: ChannelType.Email,
                from: "support@company.com",
                subject: "Hello",
                body: "{% unsubscribe_link here %}.",
              } satisfies EmailTemplateResource,
            },
          }).then(unwrap),
          insert({
            table: dbSubscriptionGroup,
            values: {
              id: randomUUID(),
              workspaceId: childWorkspace.id,
              name: `group-${randomUUID()}`,
              type: "OptOut",
              channel: ChannelType.Email,
              updatedAt: new Date(),
              createdAt: new Date(),
            },
          }).then(unwrap),
          upsertSubscriptionSecret({
            workspaceId: childWorkspace.id,
          }),
          upsertEmailProvider({
            workspaceId: parentWorkspace.id,
            config: { type: EmailProviderType.Test },
          }),
        ]);
      });

      it("should use the parent workspace's email provider", async () => {
        const userId = 1234;
        const email = "test@email.com";

        const payload = await sendEmail({
          workspaceId: childWorkspace.id,
          templateId: template.id,
          messageTags: {
            workspaceId: childWorkspace.id,
            templateId: template.id,
            runId: "run-id-1",
            nodeId: "node-id-1",
            messageId: "message-id-1",
          } satisfies MessageTags,
          userPropertyAssignments: {
            id: userId,
            email,
          },
          userId: String(userId),
          useDraft: false,
          subscriptionGroupDetails: {
            id: subscriptionGroup.id,
            name: subscriptionGroup.name,
            type: SubscriptionGroupType.OptOut,
            action: null,
          },
          providerOverride: EmailProviderType.Test,
        });
        const unwrapped = unwrap(payload);
        expect(unwrapped.type).toBe(InternalEventType.MessageSent);
      });
    });

    describe("when an email to a user with a numeric id includes an unsusbcribe link tag", () => {
      let template: MessageTemplate;
      let subscriptionGroup: SubscriptionGroup;
      beforeEach(async () => {
        ({ template, subscriptionGroup } = await setupEmailTemplate(workspace));
      });
      it("should render the tag", async () => {
        const userId = 1234;
        const email = "test@email.com";

        const payload = await sendEmail({
          workspaceId: workspace.id,
          templateId: template.id,
          messageTags: {
            workspaceId: workspace.id,
            templateId: template.id,
            runId: "run-id-1",
            nodeId: "node-id-1",
            messageId: "message-id-1",
          } satisfies MessageTags,
          userPropertyAssignments: {
            id: userId,
            email,
          },
          userId: String(userId),
          useDraft: false,
          subscriptionGroupDetails: {
            id: subscriptionGroup.id,
            name: subscriptionGroup.name,
            type: SubscriptionGroupType.OptOut,
            action: null,
          },
          providerOverride: EmailProviderType.Test,
        });
        const unwrapped = unwrap(payload);
        if (unwrapped.type === InternalEventType.MessageSkipped) {
          throw new Error("Message should not be skipped");
        }
        expect(unwrapped.type).toBe(InternalEventType.MessageSent);
        expect(unwrapped.variant.to).toBe(email);

        if (unwrapped.variant.type !== ChannelType.Email) {
          throw new Error("Message should be of type Email");
        }
        expect(unwrapped.variant.subject).toBe("Hello");
        expect(unwrapped.variant.from).toBe("support@company.com");
        expect(unwrapped.variant.body).toMatch(/href="([^"]+)"/);
      });
    });

    describe("when template has custom identifierKey", () => {
      let template: MessageTemplate;
      let subscriptionGroup: SubscriptionGroup;

      beforeEach(async () => {
        template = await insert({
          table: dbMessageTemplate,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: `template-${randomUUID()}`,
            definition: {
              type: ChannelType.Email,
              from: "support@company.com",
              subject: "Hello Manager",
              body: "{% unsubscribe_link here %}.",
              identifierKey: "managerEmail",
            } satisfies EmailTemplateResource,
            updatedAt: new Date(),
            createdAt: new Date(),
          },
        }).then(unwrap);

        subscriptionGroup = await upsertSubscriptionGroup({
          workspaceId: workspace.id,
          name: `group-${randomUUID()}`,
          type: SubscriptionGroupType.OptOut,
          channel: ChannelType.Email,
        }).then(unwrap);

        await Promise.all([
          upsertEmailProvider({
            workspaceId: workspace.id,
            config: { type: EmailProviderType.Test },
          }),
          upsertSubscriptionSecret({
            workspaceId: workspace.id,
          }),
        ]);
      });

      it("should send to the custom identifier key address", async () => {
        const payload = await sendEmail({
          workspaceId: workspace.id,
          templateId: template.id,
          messageTags: {
            workspaceId: workspace.id,
            templateId: template.id,
            runId: "run-id-1",
            nodeId: "node-id-1",
            messageId: "message-id-1",
          } satisfies MessageTags,
          userPropertyAssignments: {
            id: "user-123",
            email: "user@example.com",
            managerEmail: "manager@company.com",
          },
          userId: "user-123",
          useDraft: false,
          subscriptionGroupDetails: {
            id: subscriptionGroup.id,
            name: subscriptionGroup.name,
            type: SubscriptionGroupType.OptOut,
            action: null,
          },
          providerOverride: EmailProviderType.Test,
        });

        const result = unwrap(payload);
        expect(result.type).toBe(InternalEventType.MessageSent);
        if (result.type === InternalEventType.MessageSent) {
          expect(result.variant.to).toBe("manager@company.com");
        }
      });

      it("should skip message when custom identifierKey property is missing", async () => {
        const payload = await sendEmail({
          workspaceId: workspace.id,
          templateId: template.id,
          messageTags: {
            workspaceId: workspace.id,
            templateId: template.id,
            runId: "run-id-1",
            nodeId: "node-id-1",
            messageId: "message-id-1",
          } satisfies MessageTags,
          userPropertyAssignments: {
            id: "user-123",
            email: "user@example.com",
            // managerEmail is intentionally missing
          },
          userId: "user-123",
          useDraft: false,
          subscriptionGroupDetails: {
            id: subscriptionGroup.id,
            name: subscriptionGroup.name,
            type: SubscriptionGroupType.OptOut,
            action: null,
          },
          providerOverride: EmailProviderType.Test,
        });

        expect(payload.isErr()).toBe(true);
        if (payload.isErr()) {
          expect(payload.error.type).toBe(InternalEventType.MessageSkipped);
          if (payload.error.type === InternalEventType.MessageSkipped) {
            expect(payload.error.variant.type).toBe(
              MessageSkippedType.MissingIdentifier,
            );
          }
        }
      });

      it("should generate unsubscribe link with custom identifierKey", async () => {
        const payload = await sendEmail({
          workspaceId: workspace.id,
          templateId: template.id,
          messageTags: {
            workspaceId: workspace.id,
            templateId: template.id,
            runId: "run-id-1",
            nodeId: "node-id-1",
            messageId: "message-id-1",
          } satisfies MessageTags,
          userPropertyAssignments: {
            id: "user-123",
            email: "user@example.com",
            managerEmail: "manager@company.com",
          },
          userId: "user-123",
          useDraft: false,
          subscriptionGroupDetails: {
            id: subscriptionGroup.id,
            name: subscriptionGroup.name,
            type: SubscriptionGroupType.OptOut,
            action: null,
          },
          providerOverride: EmailProviderType.Test,
        });

        const result = unwrap(payload);
        if (
          result.type !== InternalEventType.MessageSent ||
          result.variant.type !== ChannelType.Email
        ) {
          throw new Error("Expected email message sent");
        }

        // Extract unsubscribe URL from body
        const unsubscribeMatch = result.variant.body.match(/href="([^"]+)"/);
        expect(unsubscribeMatch).toBeDefined();
        expect(unsubscribeMatch?.[1]).toBeDefined();

        const bodyUnsubscribeUrl = new URL(unsubscribeMatch![1]!);
        expect(bodyUnsubscribeUrl.searchParams.get("ik")).toEqual(
          "managerEmail",
        );
        expect(bodyUnsubscribeUrl.searchParams.get("i")).toEqual(
          "manager@company.com",
        );

        // Verify List-Unsubscribe header also uses custom identifierKey
        const listUnsubscribeHeader =
          result.variant.headers?.["List-Unsubscribe"];
        expect(listUnsubscribeHeader).toBeDefined();
        // Extract URL from header format: <url>
        const headerUrlMatch = listUnsubscribeHeader?.match(/<([^>]+)>/);
        expect(headerUrlMatch?.[1]).toBeDefined();
        const headerUnsubscribeUrl = new URL(headerUrlMatch![1]!);
        expect(headerUnsubscribeUrl.searchParams.get("ik")).toEqual(
          "managerEmail",
        );
        expect(headerUnsubscribeUrl.searchParams.get("i")).toEqual(
          "manager@company.com",
        );
      });
    });

    describe("when template does not have custom identifierKey", () => {
      let defaultTemplate: MessageTemplate;
      let subscriptionGroup: SubscriptionGroup;

      beforeEach(async () => {
        defaultTemplate = await insert({
          table: dbMessageTemplate,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: `template-${randomUUID()}`,
            definition: {
              type: ChannelType.Email,
              from: "support@company.com",
              subject: "Hello User",
              body: "<html><body>Test body.</body></html>",
              // no identifierKey - should fall back to "email"
            } satisfies EmailTemplateResource,
            updatedAt: new Date(),
            createdAt: new Date(),
          },
        }).then(unwrap);

        subscriptionGroup = await upsertSubscriptionGroup({
          workspaceId: workspace.id,
          name: `group-${randomUUID()}`,
          type: SubscriptionGroupType.OptOut,
          channel: ChannelType.Email,
        }).then(unwrap);

        await Promise.all([
          upsertEmailProvider({
            workspaceId: workspace.id,
            config: { type: EmailProviderType.Test },
          }),
          upsertSubscriptionSecret({
            workspaceId: workspace.id,
          }),
        ]);
      });

      it("should fall back to default email identifier", async () => {
        const payload = await sendEmail({
          workspaceId: workspace.id,
          templateId: defaultTemplate.id,
          messageTags: {
            workspaceId: workspace.id,
            templateId: defaultTemplate.id,
            runId: "run-id-1",
            nodeId: "node-id-1",
            messageId: "message-id-1",
          } satisfies MessageTags,
          userPropertyAssignments: {
            id: "user-123",
            email: "user@example.com",
            managerEmail: "manager@company.com",
          },
          userId: "user-123",
          useDraft: false,
          subscriptionGroupDetails: {
            id: subscriptionGroup.id,
            name: subscriptionGroup.name,
            type: SubscriptionGroupType.OptOut,
            action: null,
          },
          providerOverride: EmailProviderType.Test,
        });

        const result = unwrap(payload);
        expect(result.type).toBe(InternalEventType.MessageSent);
        if (result.type === InternalEventType.MessageSent) {
          expect(result.variant.to).toBe("user@example.com"); // Falls back to email
        }
      });
    });
  });

  describe("sendSms", () => {
    it("sends a DLT-compliant request through Celetel", async () => {
      const [template, subscriptionGroup] = await Promise.all([
        insert({
          table: dbMessageTemplate,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: `template-${randomUUID()}`,
            updatedAt: new Date(),
            createdAt: new Date(),
            definition: {
              type: ChannelType.Sms,
              body: "Hello from STAGE",
              dltContentTemplateId: "dlt-template-1",
            } satisfies SmsTemplateResource,
          },
        }).then(unwrap),
        upsertSubscriptionGroup({
          workspaceId: workspace.id,
          name: `group-${randomUUID()}`,
          type: SubscriptionGroupType.OptOut,
          channel: ChannelType.Sms,
        }).then(unwrap),
        upsertSubscriptionSecret({ workspaceId: workspace.id }),
        upsertSmsProvider({
          workspaceId: workspace.id,
          setDefault: true,
          config: {
            type: SmsProviderType.Celetel,
            endpoint: "https://sms.example.com/send",
            username: "stage-user",
            password: "stage-password",
            senderId: "STAGEN",
            dltPrincipalEntityId: "dlt-pe-1",
          },
        }),
      ]);
      const response: AxiosResponse = {
        data: { status: "success" },
        status: 200,
        statusText: "OK",
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
      mockAxios.get.mockResolvedValueOnce(response);

      const result = await sendSms({
        workspaceId: workspace.id,
        templateId: template.id,
        messageTags: {
          workspaceId: workspace.id,
          templateId: template.id,
          runId: "run-id-1",
          nodeId: "node-id-1",
          messageId: "message-id-1",
        } satisfies MessageTags,
        userPropertyAssignments: {
          id: "user-1",
          phone: "+91 84272-69387",
        },
        userId: "user-1",
        useDraft: false,
        subscriptionGroupDetails: {
          id: subscriptionGroup.id,
          name: subscriptionGroup.name,
          type: SubscriptionGroupType.OptOut,
          action: null,
        },
        providerOverride: SmsProviderType.Celetel,
      });

      expect(result.isOk()).toBe(true);
      expect(mockAxios.get).toHaveBeenCalledWith(
        "https://sms.example.com/send",
        expect.objectContaining({
          params: expect.objectContaining({
            username: "stage-user",
            password: "stage-password",
            to: "918427269387",
            from: "STAGEN",
            text: "Hello from STAGE",
            dltPrincipalEntityId: "dlt-pe-1",
            dltContentId: "dlt-template-1",
          }),
        }),
      );
    });

    describe("when sent from a child workspace", () => {
      let childWorkspace: Workspace;
      let parentWorkspace: Workspace;
      let template: MessageTemplate;
      let subscriptionGroup: SubscriptionGroup;

      beforeEach(async () => {
        const parentWorkspaceId = randomUUID();
        [parentWorkspace, childWorkspace] = await Promise.all([
          insert({
            table: dbWorkspace,
            values: {
              id: parentWorkspaceId,
              name: `parent-workspace-${randomUUID()}`,
              type: WorkspaceTypeAppEnum.Parent,
              updatedAt: new Date(),
              createdAt: new Date(),
            },
          }).then(unwrap),
          insert({
            table: dbWorkspace,
            values: {
              id: randomUUID(),
              parentWorkspaceId,
              name: `child-workspace-${randomUUID()}`,
              type: WorkspaceTypeAppEnum.Child,
              updatedAt: new Date(),
              createdAt: new Date(),
            },
          }).then(unwrap),
        ]);
        [template, subscriptionGroup] = await Promise.all([
          insert({
            table: dbMessageTemplate,
            values: {
              id: randomUUID(),
              workspaceId: childWorkspace.id,
              name: `template-${randomUUID()}`,
              updatedAt: new Date(),
              createdAt: new Date(),
              definition: {
                type: ChannelType.Sms,
                body: "Test SMS body",
              } satisfies SmsTemplateResource,
            },
          }).then(unwrap),
          insert({
            table: dbSubscriptionGroup,
            values: {
              id: randomUUID(),
              workspaceId: childWorkspace.id,
              name: `group-${randomUUID()}`,
              type: "OptOut",
              channel: ChannelType.Sms,
              updatedAt: new Date(),
              createdAt: new Date(),
            },
          }).then(unwrap),
          upsertSubscriptionSecret({
            workspaceId: childWorkspace.id,
          }),
          upsertSmsProvider({
            workspaceId: parentWorkspace.id,
            config: { type: SmsProviderType.Test },
          }),
        ]);
      });

      it("should use the parent workspace's SMS provider", async () => {
        const userId = "1234";
        const phone = "+1234567890";

        const payload = await sendSms({
          workspaceId: childWorkspace.id,
          templateId: template.id,
          messageTags: {
            workspaceId: childWorkspace.id,
            templateId: template.id,
            runId: "run-id-1",
            nodeId: "node-id-1",
            messageId: "message-id-1",
          } satisfies MessageTags,
          userPropertyAssignments: {
            id: userId,
            phone,
          },
          userId,
          useDraft: false,
          subscriptionGroupDetails: {
            id: subscriptionGroup.id,
            name: subscriptionGroup.name,
            type: SubscriptionGroupType.OptOut,
            action: null,
          },
          providerOverride: SmsProviderType.Test,
        });
        const unwrapped = unwrap(payload);
        expect(unwrapped.type).toBe(InternalEventType.MessageSent);
      });
    });
  });

  describe("sendMobilePush", () => {
    let templateId: string;

    beforeEach(async () => {
      mockSendFcmNotification.mockReset();
      const template = unwrap(
        await upsertMessageTemplate({
          name: randomUUID(),
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.MobilePush,
            title: "Hello {{ user.firstName }}",
            body: "Your episode is ready.",
            imageUrl: "https://example.com/image.jpg",
            android: { notification: { channelId: "channel1" } },
          } satisfies MobilePushTemplateResource,
        }),
      );
      templateId = template.id;
    });

    it("records a Test provider send without Firebase credentials", async () => {
      const result = await sendMobilePush({
        workspaceId: workspace.id,
        templateId,
        userPropertyAssignments: {
          id: "user-1",
          firstName: "Asha",
          deviceToken: "test-device-token",
        },
        userId: "user-1",
        useDraft: false,
        providerOverride: MobilePushProviderType.Test,
      });

      expect(result.isOk()).toBe(true);
      if (result.isErr()) return;
      if (result.value.type !== InternalEventType.MessageSent) return;
      expect(result.value.variant).toMatchObject({
        type: ChannelType.MobilePush,
        to: "test-device-token",
        title: "Hello Asha",
        body: "Your episode is ready.",
        provider: { type: MobilePushProviderType.Test },
      });
      expect(mockSendFcmNotification).not.toHaveBeenCalled();
    });

    it("sends a rendered Firebase notification to the user's device token", async () => {
      const originalEventsUrl = process.env.DITTOFEED_MOBILE_EVENTS_URL;
      process.env.DITTOFEED_MOBILE_EVENTS_URL =
        "https://engage.stage.in/api/dittofeed/mobile-push";
      const fcmKey = JSON.stringify({
        project_id: "stage-test",
        client_email: "firebase@example.com",
        private_key: "private-key",
      });
      unwrap(
        await insert({
          table: dbSecret,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: SecretNames.Fcm,
            value: fcmKey,
          },
        }),
      );
      mockSendFcmNotification.mockResolvedValue(ok("fcm-message-id"));

      const result = await sendMobilePush({
        workspaceId: workspace.id,
        templateId,
        userPropertyAssignments: {
          id: "user-1",
          firstName: "Asha",
          deviceToken: "real-device-token",
        },
        userId: "user-1",
        useDraft: false,
        providerOverride: MobilePushProviderType.Firebase,
        messageTags: {
          messageId: "message-1",
          journeyId: "journey-1",
        },
      });
      if (originalEventsUrl === undefined) {
        delete process.env.DITTOFEED_MOBILE_EVENTS_URL;
      } else {
        process.env.DITTOFEED_MOBILE_EVENTS_URL = originalEventsUrl;
      }

      expect(result.isOk()).toBe(true);
      expect(mockSendFcmNotification).toHaveBeenCalledWith({
        key: fcmKey,
        routingKeys: [],
        token: "real-device-token",
        android: { priority: "high" },
        apns: {
          headers: { "apns-priority": "10" },
          payload: {
            aps: {
              alert: {
                title: "Hello Asha",
                body: "Your episode is ready.",
              },
              sound: "default",
              mutableContent: true,
              category: "stage_engage_default",
            },
          },
          fcmOptions: { imageUrl: "https://example.com/image.jpg" },
        },
        data: {
          wzrk_pn: "true",
          wzrk_cid: "channel1",
          wzrk_id: `message-1.${generateDigest({
            rawBody: `${workspace.id}:message-1`,
            sharedSecret: fcmKey,
          })}`,
          campaign_id: `c_df_${workspace.id}`,
          source: "dittofeed",
          notification_type: "standard",
          title: "Hello Asha",
          message: "Your episode is ready.",
          nt: "Hello Asha",
          nm: "Your episode is ready.",
          dittofeedMessageId: "message-1",
          dittofeedUserId: "user-1",
          dittofeedReceiptToken: generateDigest({
            rawBody: `${workspace.id}:message-1:user-1`,
            sharedSecret: fcmKey,
          }),
          dittofeedJourneyId: "journey-1",
          dittofeedEventsUrl: `https://engage.stage.in/api/dittofeed/mobile-push?workspaceId=${workspace.id}`,
          thumbnail: "https://example.com/image.jpg",
          wzrk_bp: "https://example.com/image.jpg",
        },
      });
      if (result.isErr()) return;
      if (result.value.type !== InternalEventType.MessageSent) return;
      expect(result.value.variant).toMatchObject({
        type: ChannelType.MobilePush,
        to: "real-device-token",
        provider: {
          type: MobilePushProviderType.Firebase,
          messageId: "fcm-message-id",
        },
      });
    });
  });

  describe("sendWebhook", () => {
    it("sends a Celetel template through the Stage Engage UMS transport", async () => {
      unwrap(
        await insert({
          table: dbSecret,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: SecretNames.Webhook,
            configValue: {
              type: ChannelType.Webhook,
              celetelEndpoint:
                "https://one.celetel.com/api/ums/v1/ums-req/messages/whatsapp/clevertap",
              celetelApiKey: "engage-api-key",
              celetelWabaNumber: "+91 93113 78175",
            },
          },
        }),
      );
      const template = unwrap(
        await upsertMessageTemplate({
          name: randomUUID(),
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.Webhook,
            identifierKey: "phone",
            body: JSON.stringify({
              config: {
                url: "celetel://campaign",
                method: "POST",
                responseType: "json",
                data: {
                  to: "{{ user.phone }}",
                  templateName: "whatsapp_test",
                  languageCode: "hi",
                  components: [{ type: "body", body: { text: "hello" } }],
                },
              },
              secret: { data: {} },
            } satisfies ParsedWebhookBody),
          } satisfies WebhookTemplateResource,
        }),
      );
      mockAxios.request.mockResolvedValueOnce({
        data: { success: true },
        status: 200,
        statusText: "OK",
        headers: {},
        config: {},
      });

      const result = await sendWebhook({
        workspaceId: workspace.id,
        templateId: template.id,
        userPropertyAssignments: {
          id: "user-1",
          phone: "+91 98765 43210",
        },
        messageTags: { messageId: "message-1" },
        useDraft: false,
        userId: "user-1",
      });

      expect(result.isOk()).toBe(true);
      expect(mockAxios.request.mock.calls).toHaveLength(1);
      expect(mockAxios.request.mock.calls[0]?.[0]).toEqual({
        url: "https://one.celetel.com/api/ums/v1/ums-req/messages/whatsapp/clevertap",
        method: "POST",
        data: {
          payloadVersion: 0.1,
          to: "919876543210",
          wabaNumber: "919311378175",
          isTemplate: true,
          msgId: "message-1",
          template: {
            namespace: "whatsapp_test",
            languageCode: "hi",
          },
          components: [{ type: "body", body: { text: "hello" } }],
        },
        timeout: 30000,
        headers: {
          "X-api-key": "engage-api-key",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });
      expect(JSON.stringify(result)).not.toContain("engage-api-key");
    });

    it("sends a Celetel campaign without exposing provider credentials", async () => {
      unwrap(
        await insert({
          table: dbSecret,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: SecretNames.Webhook,
            configValue: {
              type: ChannelType.Webhook,
              celetelEmail: "celetel@example.com",
              celetelPassword: "secret-password",
              celetelWabaId: "waba-1",
            },
          },
        }),
      );
      const template = unwrap(
        await upsertMessageTemplate({
          name: randomUUID(),
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.Webhook,
            identifierKey: "phone",
            body: JSON.stringify({
              config: {
                url: "celetel://campaign",
                method: "POST",
                responseType: "json",
                data: {
                  to: "{{ user.phone }}",
                  templateName: "whatsapp_test",
                  languageCode: "hi",
                  components: [{ type: "body", body: { text: "hello" } }],
                },
              },
              secret: {
                data: {
                  email: "{{ secrets.celetelEmail }}",
                  password: "{{ secrets.celetelPassword }}",
                  wabaId: "{{ secrets.celetelWabaId }}",
                },
              },
            } satisfies ParsedWebhookBody),
          } satisfies WebhookTemplateResource,
        }),
      );
      const keyPair = await webcrypto.subtle.generateKey(
        {
          name: "RSA-OAEP",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["encrypt", "decrypt"],
      );
      const publicKey = await webcrypto.subtle.exportKey(
        "jwk",
        keyPair.publicKey,
      );
      mockAxios.get.mockResolvedValueOnce({ data: { keys: [publicKey] } });
      mockAxios.post.mockResolvedValueOnce({
        data: { accessToken: "celetel-portal-token" },
      });
      mockAxios.request.mockResolvedValueOnce({
        data: { success: true },
        status: 200,
        statusText: "OK",
        headers: {},
        config: {},
      });

      const result = await sendWebhook({
        workspaceId: workspace.id,
        templateId: template.id,
        userPropertyAssignments: {
          id: "user-1",
          phone: "+91 98765 43210",
        },
        messageTags: { messageId: "message-1" },
        useDraft: false,
        userId: "user-1",
      });

      expect(result.isOk()).toBe(true);
      expect(mockAxios.get.mock.calls[0]).toEqual([
        "https://one.celetel.com/api/user-mgmt/v1/.well-known/jwks",
        expect.any(Object),
      ]);
      expect(mockAxios.post.mock.calls[0]).toEqual([
        "https://one.celetel.com/api/user-mgmt/v1/auth/login",
        expect.any(Object),
        expect.any(Object),
      ]);
      expect(mockAxios.request.mock.calls).toHaveLength(1);
      expect(mockAxios.request.mock.calls[0]?.[0]).toMatchObject({
        url: "https://one.celetel.com/api/waba/campaign/create-campaign",
        headers: {
          Authorization: "Bearer celetel-portal-token",
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
      });
      const campaignRequest = mockAxios.request.mock.calls[0]?.[0];
      expect(typeof campaignRequest?.data).toBe("string");
      if (typeof campaignRequest?.data === "string") {
        expect(campaignRequest.data).toContain("919876543210");
        expect(campaignRequest.data).toContain(
          encodeURIComponent('"components":[]'),
        );
      }
      if (result.isErr()) return;
      if (result.value.type !== InternalEventType.MessageSent) return;
      expect(JSON.stringify(result.value)).not.toContain("secret-password");
      expect(JSON.stringify(result.value)).not.toContain(
        "celetel-portal-token",
      );
    });

    describe("when your webhook includes screts", () => {
      let templateId: string;
      beforeEach(async () => {
        const mockResponse = {
          data: { message: "Data from base axios call" },
          status: 200,
          statusText: "OK",
          headers: {},
          config: {},
        };

        mockAxios.request.mockResolvedValue(mockResponse);

        unwrap(
          await insert({
            table: dbSecret,
            values: {
              id: randomUUID(),
              workspaceId: workspace.id,
              name: SecretNames.Webhook,
              configValue: {
                type: ChannelType.Webhook,
                ApiKey: "1234",
              },
            },
          }),
        );
      });

      describe("when the template is successfully sent", () => {
        beforeEach(async () => {
          const template = unwrap(
            await upsertMessageTemplate({
              name: randomUUID(),
              workspaceId: workspace.id,
              definition: {
                type: ChannelType.Webhook,
                identifierKey: "id",
                body: JSON.stringify({
                  config: {
                    url: "https://dittofeed-test.com",
                    method: "POST",
                    responseType: "json",
                    data: {
                      message: "{{ user.firstName }}",
                    },
                  },
                  secret: {
                    headers: {
                      Authorization: "{{ secrets.ApiKey }}",
                    },
                  },
                } satisfies ParsedWebhookBody),
              } satisfies WebhookTemplateResource,
            }),
          );
          templateId = template.id;
        });
        it("the returned message sent event should replace secrets with placeholder text", async () => {
          const userId = randomUUID();
          const result = await sendWebhook({
            workspaceId: workspace.id,
            templateId,
            userPropertyAssignments: {
              id: randomUUID(),
              firstName: "John",
            },
            messageTags: {
              workspaceId: workspace.id,
              templateId,
              runId: randomUUID(),
              nodeId: randomUUID(),
              messageId: randomUUID(),
              userId,
            } satisfies MessageTags,
            useDraft: false,
            userId,
          });
          if (result.isErr()) {
            throw new Error(JSON.stringify(result.error));
          }
          const { value } = result;
          if (value.type !== InternalEventType.MessageSent) {
            throw new Error(`Expected message sent event, got ${value.type}`);
          }
          if (value.variant.type !== ChannelType.Webhook) {
            throw new Error(
              `Expected webhook event, got ${value.variant.type}`,
            );
          }
          expect(value.variant.request.headers?.Authorization).toBeUndefined();
        });
        describe("with a rendering error", () => {
          beforeEach(async () => {
            const template = unwrap(
              await upsertMessageTemplate({
                name: randomUUID(),
                workspaceId: workspace.id,
                definition: {
                  type: ChannelType.Webhook,
                  identifierKey: "id",
                  body: JSON.stringify({
                    myInvalidKey: "{{ secrets.ApiKey }}",
                  }),
                } satisfies WebhookTemplateResource,
              }),
            );
            templateId = template.id;
          });
          it("should not expose secret in event", async () => {
            const userId = randomUUID();
            const result = await sendWebhook({
              workspaceId: workspace.id,
              templateId,
              userPropertyAssignments: {
                id: randomUUID(),
              },
              messageTags: {
                workspaceId: workspace.id,
                templateId,
                runId: randomUUID(),
                nodeId: randomUUID(),
                messageId: randomUUID(),
                userId,
              } satisfies MessageTags,
              useDraft: false,
              userId,
            });
            if (result.isOk()) {
              throw new Error("Expected error, got ok");
            }
            const { error } = result;
            if (error.type !== InternalEventType.BadWorkspaceConfiguration) {
              throw new Error(
                `Expected message template render error event, got ${error.type}`,
              );
            }
            if (
              error.variant.type !==
              BadWorkspaceConfigurationType.MessageTemplateRenderError
            ) {
              throw new Error(
                `Expected message template render error event, got ${error.variant.type}`,
              );
            }
            expect(error.variant.error).not.toContain("1234");
          });
        });
      });
    });
  });

  describe("upsertMessageTemplate", () => {
    describe("when a message template is created in a second workspace with a re-used id", () => {
      let secondWorkspace: Workspace;
      beforeEach(async () => {
        secondWorkspace = await insert({
          table: dbWorkspace,
          values: {
            id: randomUUID(),
            name: randomUUID(),
            updatedAt: new Date(),
            createdAt: new Date(),
          },
        }).then(unwrap);
      });
      it("returns a unique constraint violation error", async () => {
        const id = randomUUID();
        const result = await upsertMessageTemplate({
          id,
          name: randomUUID(),
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.Email,
            from: "support@company.com",
            subject: "Hello",
            body: "{% unsubscribe_link here %}.",
          } satisfies EmailTemplateResource,
        });
        expect(result.isOk()).toBe(true);
        const secondResult = await upsertMessageTemplate({
          id,
          name: randomUUID(),
          workspaceId: secondWorkspace.id,
          definition: {
            type: ChannelType.Email,
            from: "support@company.com",
            subject: "Hello",
            body: "{% unsubscribe_link here %}.",
          } satisfies EmailTemplateResource,
        });
        const errorType = secondResult.isErr() && secondResult.error.type;
        expect(
          errorType,
          "second upsert should fail with unique constraint violation",
        ).toEqual(
          UpsertMessageTemplateValidationErrorType.UniqueConstraintViolation,
        );
      });
    });

    describe("when template type changes from low code to code", () => {
      it("should clear the draft when emailContentsType changes", async () => {
        const templateName = randomUUID();

        // Create a low code email template
        const initialResult = await upsertMessageTemplate({
          name: templateName,
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.Email,
            from: "support@company.com",
            subject: "Hello",
            emailContentsType: EmailContentsType.LowCode,
            body: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Hello World",
                    },
                  ],
                },
              ],
            },
          },
        });
        expect(initialResult.isOk()).toBe(true);
        if (!initialResult.isOk()) return;

        // Add a draft to the template
        const draftResult = await upsertMessageTemplate({
          name: templateName,
          workspaceId: workspace.id,
          draft: {
            type: ChannelType.Email,
            from: "draft@company.com",
            subject: "Draft Subject",
            emailContentsType: EmailContentsType.LowCode,
            body: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Draft Content",
                    },
                  ],
                },
              ],
            },
          },
        });
        expect(draftResult.isOk()).toBe(true);
        if (!draftResult.isOk()) return;

        // Verify draft exists
        expect(draftResult.value.draft).toBeDefined();

        // Change the template type to Code, which should clear the draft
        const typeChangeResult = await upsertMessageTemplate({
          name: templateName,
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.Email,
            from: "support@company.com",
            subject: "Hello Code",
            body: "<html><body>Hello World</body></html>",
          },
        });
        expect(typeChangeResult.isOk()).toBe(true);
        if (!typeChangeResult.isOk()) return;

        // Verify draft is cleared
        expect(typeChangeResult.value.draft).toBeUndefined();
        if (typeChangeResult.value.definition?.type === ChannelType.Email) {
          expect(typeChangeResult.value.definition.from).toBe(
            "support@company.com",
          );
          expect(typeChangeResult.value.definition.subject).toBe("Hello Code");
        }
      });
    });

    describe("when template has identifierKey referencing non-existent user property", () => {
      it("should return an InvalidIdentifierKey error", async () => {
        const result = await upsertMessageTemplate({
          name: randomUUID(),
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.Email,
            from: "support@company.com",
            subject: "Hello",
            body: "Test body",
            identifierKey: "nonExistentProperty",
          } satisfies EmailTemplateResource,
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toEqual(
            UpsertMessageTemplateValidationErrorType.InvalidIdentifierKey,
          );
        }
      });

      it("should succeed when identifierKey references a valid user property", async () => {
        // First create a user property
        await insert({
          table: dbUserProperty,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: "managerEmail",
            definition: {
              type: UserPropertyDefinitionType.Trait,
              path: "managerEmail",
            },
            updatedAt: new Date(),
            createdAt: new Date(),
          },
        });

        const result = await upsertMessageTemplate({
          name: randomUUID(),
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.Email,
            from: "support@company.com",
            subject: "Hello",
            body: "Test body",
            identifierKey: "managerEmail",
          } satisfies EmailTemplateResource,
        });
        expect(result.isOk()).toBe(true);
      });

      it("should succeed when identifierKey is not specified (uses default)", async () => {
        const result = await upsertMessageTemplate({
          name: randomUUID(),
          workspaceId: workspace.id,
          definition: {
            type: ChannelType.Email,
            from: "support@company.com",
            subject: "Hello",
            body: "Test body",
          } satisfies EmailTemplateResource,
        });
        expect(result.isOk()).toBe(true);
      });
    });
  });

  describe("batchMessageUsers", () => {
    describe("when sending email messages to multiple users", () => {
      let template: MessageTemplate;
      let subscriptionGroup: SubscriptionGroup;

      beforeEach(async () => {
        ({ template, subscriptionGroup } = await setupEmailTemplate(workspace));

        // Set up email provider for the workspace
        await upsertEmailProvider({
          workspaceId: workspace.id,
          config: { type: EmailProviderType.Test },
          setDefault: true,
        });
      });

      it("should send messages to all users and return success results", async () => {
        const users = [
          {
            id: "user1",
            properties: {
              email: "user1@test.com",
              firstName: "User1",
            },
          },
          {
            id: "user2",
            properties: {
              email: "user2@test.com",
              firstName: "User2",
            },
          },
        ];

        const result = await batchMessageUsers({
          workspaceId: workspace.id,
          templateId: template.id,
          subscriptionGroupId: subscriptionGroup.id,
          channel: ChannelType.Email,
          users,
        });

        expect(result.results).toHaveLength(2);
        expect(result.results[0]?.type).toBe(
          BatchMessageUsersResultTypeEnum.Success,
        );
        expect(result.results[0]?.userId).toBe("user1");
        expect(result.results[1]?.type).toBe(
          BatchMessageUsersResultTypeEnum.Success,
        );
        expect(result.results[1]?.userId).toBe("user2");
      });

      it("should handle users with missing email identifiers", async () => {
        const users = [
          {
            id: "user1",
            properties: {
              firstName: "User1",
              // Missing email
            },
          },
        ];

        const result = await batchMessageUsers({
          workspaceId: workspace.id,
          templateId: template.id,
          subscriptionGroupId: subscriptionGroup.id,
          channel: ChannelType.Email,
          users,
        });

        expect(result.results).toHaveLength(1);
        expect(result.results[0]?.type).toBe(
          BatchMessageUsersResultTypeEnum.RetryableError,
        );
        expect(result.results[0]?.userId).toBe("user1");
      });

      it("should handle subscription group assignments when batching users", async () => {
        // This test verifies that the batched subscription group functionality is called
        // Even though we get "No segment found" errors in logs, the function should handle
        // this gracefully and not crash
        const users = [
          {
            id: "user1",
            properties: {
              email: "user1@test.com",
              firstName: "User1",
            },
          },
          {
            id: "user2",
            properties: {
              email: "user2@test.com",
              firstName: "User2",
            },
          },
        ];

        const result = await batchMessageUsers({
          workspaceId: workspace.id,
          templateId: template.id,
          subscriptionGroupId: subscriptionGroup.id,
          channel: ChannelType.Email,
          users,
        });

        // The key test here is that batchMessageUsers completes successfully
        // with a subscription group, proving our batched getSubscriptionGroupWithAssignments
        // is working correctly (even when segments aren't set up)
        expect(result.results).toHaveLength(2);
        expect(result.results[0]?.type).toBe(
          BatchMessageUsersResultTypeEnum.Success,
        );
        expect(result.results[1]?.type).toBe(
          BatchMessageUsersResultTypeEnum.Success,
        );
      });
    });
  });
  describe("when sending email with base64 encoded attachments", () => {
    let template: MessageTemplate;

    beforeEach(async () => {
      // First create the email provider
      await upsertEmailProvider({
        workspaceId: workspace.id,
        config: { type: EmailProviderType.Test },
        setDefault: true,
      });

      // Then create the template
      template = await insert({
        table: dbMessageTemplate,
        values: {
          id: randomUUID(),
          workspaceId: workspace.id,
          name: `template-${randomUUID()}`,
          updatedAt: new Date(),
          createdAt: new Date(),
          definition: {
            type: ChannelType.Email,
            from: "support@company.com",
            subject: "Hello with attachment",
            body: "<mjml><mj-body><mj-section><mj-column><mj-text>Please find the attached file.</mj-text></mj-column></mj-section></mj-body></mjml>",
            attachmentUserProperties: ["myFile"],
          } satisfies EmailTemplateResource,
        },
      }).then(unwrap);
    });

    it("should handle base64 encoded file attachments", async () => {
      const userId = 1234;
      const email = "test@email.com";

      // Sample base64 encoded file (a simple text file)
      const base64FileData = "SGVsbG8gV29ybGQ="; // "Hello World" in base64
      const attachmentFile: Base64EncodedFile = {
        type: AppFileType.Base64Encoded,
        name: "test.txt",
        mimeType: "text/plain",
        data: base64FileData,
      };

      const result = await sendEmail({
        workspaceId: workspace.id,
        templateId: template.id,
        messageTags: {
          workspaceId: workspace.id,
          templateId: template.id,
          runId: "run-id-1",
          messageId: randomUUID(),
        },
        userPropertyAssignments: {
          email,
          myFile: attachmentFile,
        },
        userId: userId.toString(),
        useDraft: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.type).toBe(InternalEventType.MessageSent);
        if (result.value.type === InternalEventType.MessageSent) {
          expect(result.value.variant.type).toBe(ChannelType.Email);
          if (result.value.variant.type === ChannelType.Email) {
            expect(result.value.variant.attachments).toHaveLength(1);
            expect(result.value.variant.attachments?.[0]).toEqual({
              name: "test.txt",
              mimeType: "text/plain",
            });
          }
        }
      }
    });
  });

  describe("view-in-browser storage", () => {
    it("stores email body when blob storage is enabled", async () => {
      // Skip if blob storage is not enabled
      if (!config().enableBlobStorage) {
        return;
      }

      const template = unwrap(
        await insert({
          table: dbMessageTemplate,
          values: {
            id: randomUUID(),
            workspaceId: workspace.id,
            name: `template-${randomUUID()}`,
            definition: {
              type: ChannelType.Email,
              from: "support@company.com",
              subject: "Hello",
              body: "<p>View in browser: {% view_in_browser_url %}</p>",
            } satisfies EmailTemplateResource,
            updatedAt: new Date(),
            createdAt: new Date(),
          },
        }),
      );

      // Create ViewInBrowser secret
      await insert({
        table: dbSecret,
        values: {
          workspaceId: workspace.id,
          name: SecretNames.ViewInBrowser,
          value: "test-view-in-browser-secret",
        },
        doNothingOnConflict: true,
      });

      await upsertEmailProvider({
        workspaceId: workspace.id,
        config: { type: EmailProviderType.Test },
      });

      const messageId = randomUUID();
      const email = "test@email.com";
      const userId = randomUUID();

      const result = await sendEmail({
        workspaceId: workspace.id,
        templateId: template.id,
        messageTags: {
          workspaceId: workspace.id,
          templateId: template.id,
          runId: randomUUID(),
          nodeId: randomUUID(),
          messageId,
        },
        userPropertyAssignments: {
          id: userId,
          email,
        },
        userId,
        useDraft: false,
        providerOverride: EmailProviderType.Test,
      });

      expect(result.isOk()).toBe(true);

      // Verify email was stored in blob storage
      const storedEmail = await getStoredEmailForViewInBrowser({
        workspaceId: workspace.id,
        messageId,
      });

      expect(storedEmail.isOk()).toBe(true);
      if (storedEmail.isOk()) {
        expect(storedEmail.value).toContain("View in browser:");
        expect(storedEmail.value).toContain("/api/public/view-in-browser");
      }
    });
  });
});
