import { defaultEmailDefinition } from "isomorphic-lib/src/email";
import { defaultSmsDefinition } from "isomorphic-lib/src/sms";
import { assertUnreachable } from "isomorphic-lib/src/typeAssertions";
import {
  ChannelType,
  EmailContentsType,
  LowCodeEmailDefaultType,
  MessageTemplateResourceDefinition,
} from "isomorphic-lib/src/types";
import { DEFAULT_WEBHOOK_DEFINITION } from "isomorphic-lib/src/webhook";

export const DEFAULT_EMAIL_CONTENTS_TYPE = EmailContentsType.LowCode;

export function getDefaultMessageTemplateDefinition(
  channelType: ChannelType,
  emailContentsType?: EmailContentsType,
  lowCodeEmailDefaultType?: LowCodeEmailDefaultType,
): MessageTemplateResourceDefinition {
  switch (channelType) {
    case ChannelType.Email:
      return defaultEmailDefinition({
        emailContentsType: emailContentsType ?? DEFAULT_EMAIL_CONTENTS_TYPE,
        lowCodeEmailDefaultType,
      });
    case ChannelType.Sms:
      return defaultSmsDefinition();
    case ChannelType.Webhook:
      return DEFAULT_WEBHOOK_DEFINITION;
    case ChannelType.MobilePush:
      return {
        type: ChannelType.MobilePush,
        title: "New notification",
        body: "Notification body",
        android: { notification: { channelId: "channel1" } },
      };
    case ChannelType.InApp:
      return {
        type: ChannelType.InApp,
        trigger: "app_foreground",
        template: "modal",
        title: "New message",
        body: "Message body",
        cta: [],
        dismissible: true,
        displayPriority: 50,
        minGapBetweenShowsSec: 3600,
        maxPerSession: 1,
        maxPer24h: 1,
        maxPer7d: 3,
      };
    default:
      assertUnreachable(channelType);
  }
}
