import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import {
  getBroadcastMessageTemplateId,
  getBroadcastMessageTemplateName,
} from "isomorphic-lib/src/broadcasts";
import { defaultEmailDefinition } from "isomorphic-lib/src/email";
import { assertUnreachable } from "isomorphic-lib/src/typeAssertions";
import {
  ChannelType,
  CompletionStatus,
  EmailContentsType,
  InAppTemplateResource,
  LowCodeEmailDefaultType,
} from "isomorphic-lib/src/types";
import { useSnackbar } from "notistack";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppStorePick } from "../../lib/appStore";
import { useAuthHeaders, useBaseApiUrl } from "../../lib/authModeProvider";
import { getDefaultMessageTemplateDefinition } from "../../lib/defaultTemplateDefinition";
import { ResourceType } from "../../lib/types";
import { useBroadcastMutation } from "../../lib/useBroadcastMutation";
import { useBroadcastQuery } from "../../lib/useBroadcastQuery";
import { useMessageTemplateQuery } from "../../lib/useMessageTemplateQuery";
import { useMessageTemplateUpdateMutation } from "../../lib/useMessageTemplateUpdateMutation";
import EmailEditor from "../messages/emailEditor";
import SmsEditor from "../messages/smsEditor";
import WebhookEditor from "../messages/webhookEditor";
import ResourceSelect from "../resourceSelect";
import { MobilePushEditor } from "../templateEditor";
import { BroadcastState } from "./broadcastsShared";

function InAppEditor({
  templateId,
  disabled,
}: {
  templateId: string;
  disabled: boolean;
}) {
  const { data: messageTemplate } = useMessageTemplateQuery(templateId);
  const update = useMessageTemplateUpdateMutation();
  const definition = messageTemplate?.definition;
  const [draft, setDraft] = useState<InAppTemplateResource | null>(null);

  useEffect(() => {
    if (definition?.type === ChannelType.InApp) setDraft(definition);
  }, [definition]);

  if (!messageTemplate || !draft) return null;
  const primaryCta = draft.cta[0] ?? {
    id: "primary",
    label: "Open",
    deeplink: "stage://home",
    style: "primary" as const,
  };
  const updateCta = (values: Partial<typeof primaryCta>) =>
    setDraft({ ...draft, cta: [{ ...primaryCta, ...values }] });

  return (
    <Stack spacing={2} sx={{ maxWidth: 900 }}>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <TextField
          fullWidth
          label="Trigger event"
          value={draft.trigger}
          disabled={disabled}
          onChange={(event) =>
            setDraft({ ...draft, trigger: event.target.value })
          }
          helperText="app_foreground, screen_view, payment_failed..."
        />
        <TextField
          fullWidth
          label="Screen (optional)"
          value={draft.screen ?? ""}
          disabled={disabled}
          onChange={(event) =>
            setDraft({ ...draft, screen: event.target.value || undefined })
          }
        />
        <TextField
          select
          fullWidth
          label="Layout"
          value={draft.template}
          disabled={disabled}
          onChange={(event) => {
            const template = event.target.value;
            if (template === "modal" || template === "bottom_banner") {
              setDraft({ ...draft, template });
            }
          }}
        >
          <MenuItem value="modal">Modal</MenuItem>
          <MenuItem value="bottom_banner">Bottom banner</MenuItem>
        </TextField>
      </Stack>
      <TextField
        fullWidth
        label="Title"
        value={draft.title}
        disabled={disabled}
        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
      />
      <TextField
        fullWidth
        multiline
        minRows={3}
        label="Body"
        value={draft.body}
        disabled={disabled}
        onChange={(event) => setDraft({ ...draft, body: event.target.value })}
      />
      <TextField
        fullWidth
        label="Image URL (HTTPS)"
        value={draft.imageUrl ?? ""}
        disabled={disabled}
        onChange={(event) =>
          setDraft({ ...draft, imageUrl: event.target.value || undefined })
        }
      />
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <TextField
          fullWidth
          label="CTA label"
          value={primaryCta.label}
          disabled={disabled}
          onChange={(event) => updateCta({ label: event.target.value })}
        />
        <TextField
          fullWidth
          label="CTA deeplink"
          value={primaryCta.deeplink}
          disabled={disabled}
          onChange={(event) => updateCta({ deeplink: event.target.value })}
        />
      </Stack>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <TextField
          type="number"
          label="Priority"
          value={draft.displayPriority}
          disabled={disabled}
          onChange={(event) =>
            setDraft({ ...draft, displayPriority: Number(event.target.value) })
          }
        />
        <TextField
          type="number"
          label="Minimum gap (seconds)"
          value={draft.minGapBetweenShowsSec}
          disabled={disabled}
          onChange={(event) =>
            setDraft({
              ...draft,
              minGapBetweenShowsSec: Number(event.target.value),
            })
          }
        />
        <TextField
          type="number"
          label="Max / session"
          value={draft.maxPerSession}
          disabled={disabled}
          onChange={(event) =>
            setDraft({ ...draft, maxPerSession: Number(event.target.value) })
          }
        />
        <TextField
          type="number"
          label="Max / 24h"
          value={draft.maxPer24h}
          disabled={disabled}
          onChange={(event) =>
            setDraft({ ...draft, maxPer24h: Number(event.target.value) })
          }
        />
        <TextField
          type="number"
          label="Max / 7d"
          value={draft.maxPer7d}
          disabled={disabled}
          onChange={(event) =>
            setDraft({ ...draft, maxPer7d: Number(event.target.value) })
          }
        />
      </Stack>
      <FormControlLabel
        control={
          <Switch
            checked={draft.dismissible}
            disabled={disabled}
            onChange={(_, checked) =>
              setDraft({ ...draft, dismissible: checked })
            }
          />
        }
        label="Dismissible"
      />
      {!disabled && (
        <Button
          variant="contained"
          disabled={
            update.isPending || !draft.trigger || !draft.title || !draft.body
          }
          onClick={() =>
            update.mutate({
              id: messageTemplate.id,
              name: messageTemplate.name,
              definition: draft,
            })
          }
        >
          {update.isPending ? "Saving..." : "Save in-app message"}
        </Button>
      )}
    </Stack>
  );
}

interface WhatsAppTemplatePreview {
  templateName: string;
  languageCode: string;
  message: string;
}

interface RefreshCeletelTemplatesResponse {
  fetched: number;
  imported: number;
  updated: number;
  skipped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getWhatsAppTemplatePreview(
  body: string,
): WhatsAppTemplatePreview | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !isRecord(parsed.config)) return null;
    const { data } = parsed.config;
    if (!isRecord(data)) return null;
    const legacyTemplate = isRecord(data.template) ? data.template : null;
    const templateName = legacyTemplate?.namespace ?? data.templateName;
    const languageCode = legacyTemplate?.languageCode ?? data.languageCode;
    if (typeof templateName !== "string" || typeof languageCode !== "string") {
      return null;
    }

    const bodyComponent = Array.isArray(data.components)
      ? data.components.find(
          (component) =>
            isRecord(component) &&
            component.type === "body" &&
            isRecord(component.body),
        )
      : undefined;
    const message =
      isRecord(bodyComponent) &&
      isRecord(bodyComponent.body) &&
      typeof bodyComponent.body.text === "string"
        ? bodyComponent.body.text
        : "Template content is managed in Celetel.";

    return { templateName, languageCode, message };
  } catch {
    return null;
  }
}

function EmailControls({
  emailContentType,
  setEmailContentType,
  broadcastId,
  disabled,
  allowedEmailContentsTypes,
  lowCodeEmailDefaultType,
}: {
  broadcastId: string;
  emailContentType: EmailContentsType | null;
  setEmailContentType: (emailContentType: EmailContentsType | null) => void;
  disabled?: boolean;
  allowedEmailContentsTypes?: EmailContentsType[];
  lowCodeEmailDefaultType?: LowCodeEmailDefaultType;
}) {
  const { data: broadcast } = useBroadcastQuery(broadcastId);
  const updateMessageTemplateMutation = useMessageTemplateUpdateMutation();

  // If allowedEmailContentsTypes is undefined, empty, or has both types, show toggle
  const shouldShowToggle =
    !allowedEmailContentsTypes ||
    allowedEmailContentsTypes.length === 0 ||
    allowedEmailContentsTypes.length === 2;

  if (!shouldShowToggle) {
    return null;
  }

  return (
    <ToggleButtonGroup
      value={emailContentType}
      exclusive
      disabled={disabled}
      onChange={(_, newValue) => {
        setEmailContentType(newValue);
        if (broadcast?.messageTemplateId) {
          updateMessageTemplateMutation.mutate({
            id: broadcast.messageTemplateId,
            name: broadcast.name,
            definition: defaultEmailDefinition({
              emailContentsType: newValue,
              lowCodeEmailDefaultType,
            }),
          });
        }
      }}
    >
      <ToggleButton value={EmailContentsType.LowCode}>Low Code</ToggleButton>
      <ToggleButton value={EmailContentsType.Code}>Code</ToggleButton>
    </ToggleButtonGroup>
  );
}

function ExistingTemplatePreview({ broadcastId }: { broadcastId: string }) {
  const { data: broadcast } = useBroadcastQuery(broadcastId);
  const messageTemplateId = useMemo<string | undefined>(
    () => broadcast?.messageTemplateId,
    [broadcast?.messageTemplateId],
  );
  const { data: messageTemplate } = useMessageTemplateQuery(messageTemplateId);
  if (!messageTemplate || !messageTemplateId) {
    return null;
  }
  switch (messageTemplate.definition?.type) {
    case ChannelType.Email:
      return (
        <EmailEditor
          templateId={messageTemplateId}
          disabled
          hidePublisher
          hideTitle
          hideUserPropertiesPanel
          hideEditor
        />
      );
    case ChannelType.Sms:
      return (
        <SmsEditor
          templateId={messageTemplateId}
          disabled
          hidePublisher
          hideTitle
          hideUserPropertiesPanel
          hideEditor
        />
      );
    case ChannelType.Webhook: {
      const whatsAppPreview = getWhatsAppTemplatePreview(
        messageTemplate.definition.body,
      );
      if (whatsAppPreview) {
        return (
          <Stack
            spacing={2}
            sx={{
              maxWidth: 900,
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              p: 2,
            }}
          >
            <Box>
              <Typography variant="subtitle1">WhatsApp message</Typography>
              <Typography variant="body2" color="text.secondary">
                Approved Celetel template selected for this campaign.
              </Typography>
            </Box>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
              <TextField
                fullWidth
                label="Template"
                value={whatsAppPreview.templateName}
                InputProps={{ readOnly: true }}
              />
              <TextField
                fullWidth
                label="Language"
                value={whatsAppPreview.languageCode}
                InputProps={{ readOnly: true }}
              />
              <TextField
                fullWidth
                label="Recipient property"
                value={messageTemplate.definition.identifierKey}
                InputProps={{ readOnly: true }}
              />
            </Stack>
            <TextField
              fullWidth
              multiline
              minRows={3}
              label="Message preview"
              value={whatsAppPreview.message}
              InputProps={{ readOnly: true }}
            />
          </Stack>
        );
      }
      return (
        <WebhookEditor
          templateId={messageTemplateId}
          disabled
          hidePublisher
          hideTitle
          hideUserPropertiesPanel
          hideEditor
        />
      );
    }
    case ChannelType.MobilePush:
      return (
        <MobilePushEditor
          templateId={messageTemplateId}
          disabled
          hidePublisher
          hideTitle
          hideUserPropertiesPanel
          hideEditor
        />
      );
    case ChannelType.InApp:
      return <InAppEditor templateId={messageTemplateId} disabled />;
    default:
      return null;
  }
}

function BroadcastMessageTemplateEditor({
  broadcastId,
  disabled,
  hideTemplateUserPropertiesPanel,
  allowedEmailContentsTypes,
  lowCodeEmailDefaultType,
}: {
  broadcastId: string;
  disabled: boolean;
  hideTemplateUserPropertiesPanel?: boolean;
  allowedEmailContentsTypes?: EmailContentsType[];
  lowCodeEmailDefaultType?: LowCodeEmailDefaultType;
}) {
  const { workspace } = useAppStorePick(["workspace"]);
  const broadcastMutation = useBroadcastMutation(broadcastId);
  const { data: broadcast } = useBroadcastQuery(broadcastId);
  const messageTemplateId = useMemo<string | undefined>(
    () => broadcast?.messageTemplateId,
    [broadcast?.messageTemplateId],
  );
  const { data: messageTemplate } = useMessageTemplateQuery(messageTemplateId);

  const updateMessageTemplateMutation = useMessageTemplateUpdateMutation();

  const isInternalTemplate = useMemo(() => {
    if (workspace.type !== CompletionStatus.Successful) {
      return false;
    }
    const workspaceId = workspace.value.id;
    return (
      messageTemplateId ===
      getBroadcastMessageTemplateId({ broadcastId, workspaceId })
    );
  }, [messageTemplateId, broadcastId, workspace]);

  const messageType = broadcast?.config.message.type;
  useEffect(() => {
    if (
      isInternalTemplate ||
      workspace.type !== CompletionStatus.Successful ||
      !messageType
    ) {
      return;
    }
    const workspaceId = workspace.value.id;
    const newMessageTemplateId = getBroadcastMessageTemplateId({
      broadcastId,
      workspaceId,
    });
    const newMessageTemplateName = getBroadcastMessageTemplateName({
      broadcastId,
    });

    // Determine the appropriate email contents type based on configuration
    let emailContentsType: EmailContentsType | undefined;
    if (messageType === ChannelType.Email && allowedEmailContentsTypes) {
      if (allowedEmailContentsTypes.length === 1) {
        [emailContentsType] = allowedEmailContentsTypes;
      }
    }

    const definition = getDefaultMessageTemplateDefinition(
      messageType,
      emailContentsType,
      lowCodeEmailDefaultType,
    );

    updateMessageTemplateMutation.mutate(
      {
        id: newMessageTemplateId,
        name: newMessageTemplateName,
        definition,
        resourceType: "Internal",
      },
      {
        onSuccess: () => {
          broadcastMutation.mutate({ messageTemplateId: newMessageTemplateId });
        },
      },
    );
  }, [workspace, isInternalTemplate, messageType, allowedEmailContentsTypes]);

  if (!messageTemplate || !messageTemplateId || !isInternalTemplate) {
    return null;
  }
  let editor: React.ReactNode;
  switch (messageTemplate.definition?.type) {
    case ChannelType.Email:
      editor = (
        <EmailEditor
          templateId={messageTemplateId}
          disabled={disabled}
          hidePublisher
          hideTitle
          hideUserPropertiesPanel={hideTemplateUserPropertiesPanel}
        />
      );
      break;
    case ChannelType.Sms:
      editor = (
        <SmsEditor
          templateId={messageTemplateId}
          disabled={disabled}
          hidePublisher
          hideTitle
          hideUserPropertiesPanel={hideTemplateUserPropertiesPanel}
        />
      );
      break;
    case ChannelType.Webhook:
      editor = (
        <WebhookEditor
          templateId={messageTemplateId}
          disabled={disabled}
          hidePublisher
          hideTitle
          hideUserPropertiesPanel={hideTemplateUserPropertiesPanel}
        />
      );
      break;
    case ChannelType.MobilePush:
      editor = (
        <MobilePushEditor
          templateId={messageTemplateId}
          disabled={disabled}
          hidePublisher
          hideTitle
          hideUserPropertiesPanel={hideTemplateUserPropertiesPanel}
        />
      );
      break;
    case ChannelType.InApp:
      editor = (
        <InAppEditor templateId={messageTemplateId} disabled={disabled} />
      );
      break;
    default:
      return null;
  }
  return editor;
}

export default function Content({ state }: { state: BroadcastState }) {
  const { workspace } = useAppStorePick(["workspace"]);
  const queryClient = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const baseApiUrl = useBaseApiUrl();
  const authHeaders = useAuthHeaders();
  const { data: broadcast } = useBroadcastQuery(state.id);
  const broadcastMutation = useBroadcastMutation(state.id);
  const [selectExistingTemplate, setSelectExistingTemplate] = useState<
    "existing" | "new" | null
  >(null);
  const [emailContentType, setEmailContentType] =
    useState<EmailContentsType | null>(null);
  const disabled = broadcast?.status !== "Draft";
  const { data: messageTemplate } = useMessageTemplateQuery(
    broadcast?.messageTemplateId,
  );
  const refreshCeletelTemplates = useMutation({
    mutationFn: async () => {
      if (workspace.type !== CompletionStatus.Successful) {
        throw new Error("Workspace is unavailable");
      }
      return axios.post<RefreshCeletelTemplatesResponse>(
        `${baseApiUrl}/content/templates/celetel/refresh`,
        { workspaceId: workspace.value.id },
        { headers: authHeaders },
      );
    },
    onSuccess: async ({ data }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["resources"] }),
        queryClient.invalidateQueries({ queryKey: ["messageTemplates"] }),
      ]);
      enqueueSnackbar(
        `Celetel refreshed: ${data.imported} added, ${data.updated} updated`,
        { variant: "success" },
      );
    },
    onError: (error) => {
      const message = axios.isAxiosError<{ message?: string }>(error)
        ? error.response?.data.message
        : undefined;
      enqueueSnackbar(message ?? "Celetel templates could not be refreshed", {
        variant: "error",
      });
    },
  });

  useEffect(() => {
    if (
      emailContentType !== null ||
      selectExistingTemplate !== "new" ||
      messageTemplate?.definition?.type !== "Email" ||
      workspace.type !== CompletionStatus.Successful ||
      messageTemplate.id !==
        getBroadcastMessageTemplateId({
          broadcastId: state.id,
          workspaceId: workspace.value.id,
        })
    ) {
      return;
    }

    const contentType =
      messageTemplate.definition.emailContentsType === EmailContentsType.LowCode
        ? messageTemplate.definition.emailContentsType
        : EmailContentsType.Code;
    setEmailContentType(contentType);
  }, [
    emailContentType,
    broadcast,
    messageTemplate,
    selectExistingTemplate,
    workspace,
    state.id,
  ]);

  useEffect(() => {
    if (
      !broadcast ||
      workspace.type !== CompletionStatus.Successful ||
      selectExistingTemplate !== null
    ) {
      return;
    }
    if (
      broadcast.messageTemplateId &&
      broadcast.messageTemplateId ===
        getBroadcastMessageTemplateId({
          broadcastId: state.id,
          workspaceId: workspace.value.id,
        })
    ) {
      setSelectExistingTemplate("new");
      return;
    }
    setSelectExistingTemplate("existing");
  }, [broadcast, state.id, workspace, selectExistingTemplate]);

  const handleMessageTemplateChange = useCallback(
    (resourceId: string | null) => {
      broadcastMutation.mutate({ messageTemplateId: resourceId });
    },
    [broadcastMutation],
  );

  let templateSelect: React.ReactNode;
  switch (selectExistingTemplate) {
    case "existing":
      templateSelect = (
        <Stack spacing={1} sx={{ flex: 1 }}>
          <Box sx={{ maxWidth: 600 }}>
            <ResourceSelect
              resourceType={ResourceType.MessageTemplate}
              value={broadcast?.messageTemplateId ?? null}
              onChange={handleMessageTemplateChange}
              channel={broadcast?.config.message.type}
              disabled={disabled}
              label="Template"
              currentPageLabel={broadcast?.name || "Broadcast"}
            />
          </Box>
          <ExistingTemplatePreview broadcastId={state.id} />
        </Stack>
      );
      break;
    case "new":
      templateSelect = (
        <BroadcastMessageTemplateEditor
          broadcastId={state.id}
          disabled={disabled}
          hideTemplateUserPropertiesPanel={
            state.configuration?.hideTemplateUserPropertiesPanel
          }
          allowedEmailContentsTypes={
            state.configuration?.allowedEmailContentsTypes
          }
          lowCodeEmailDefaultType={state.configuration?.lowCodeEmailDefaultType}
        />
      );
      break;
    case null:
      templateSelect = null;
      break;
    default:
      assertUnreachable(selectExistingTemplate);
  }
  if (!broadcast) {
    return null;
  }
  const isWhatsApp = broadcast.config.message.type === ChannelType.Webhook;
  let controls: React.ReactNode;
  if (selectExistingTemplate === "new" && broadcast.messageTemplateId) {
    switch (broadcast.config.message.type) {
      case ChannelType.Email:
        controls = (
          <EmailControls
            broadcastId={broadcast.id}
            disabled={disabled}
            emailContentType={emailContentType}
            setEmailContentType={setEmailContentType}
            allowedEmailContentsTypes={
              state.configuration?.allowedEmailContentsTypes
            }
            lowCodeEmailDefaultType={
              state.configuration?.lowCodeEmailDefaultType
            }
          />
        );
        break;
      default:
        controls = null;
    }
  }
  return (
    <Stack
      spacing={2}
      sx={{ height: "100%", width: "100%", flex: 1, minHeight: 0 }}
    >
      <Stack direction="row" spacing={2}>
        {isWhatsApp ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle1">
              Approved WhatsApp Template
            </Typography>
            <Button
              size="small"
              variant="outlined"
              startIcon={
                refreshCeletelTemplates.isPending ? (
                  <CircularProgress size={16} />
                ) : (
                  <RefreshIcon />
                )
              }
              disabled={disabled || refreshCeletelTemplates.isPending}
              onClick={() => refreshCeletelTemplates.mutate()}
            >
              Refresh from Celetel
            </Button>
          </Stack>
        ) : (
          <ToggleButtonGroup
            value={selectExistingTemplate}
            exclusive
            disabled={disabled || selectExistingTemplate === null}
            onChange={(_, newValue) => {
              if (newValue !== null) {
                setSelectExistingTemplate(newValue);
              }
              if (newValue === "existing") {
                broadcastMutation.mutate({ messageTemplateId: null });
              }
            }}
          >
            <ToggleButton value="existing">Existing Template</ToggleButton>
            <ToggleButton value="new">New Template</ToggleButton>
          </ToggleButtonGroup>
        )}
        {controls}
      </Stack>
      {templateSelect}
    </Stack>
  );
}
