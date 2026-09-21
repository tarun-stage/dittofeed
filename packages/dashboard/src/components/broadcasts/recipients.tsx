import {
  Alert,
  Box,
  Button,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import axios from "axios";
import {
  getBroadcastSegmentId,
  getBroadcastSegmentName,
} from "isomorphic-lib/src/broadcasts";
import { assertUnreachable } from "isomorphic-lib/src/typeAssertions";
import {
  CompletionStatus,
  SegmentDefinition,
  SegmentNode,
  SegmentNodeType,
  SegmentResource,
} from "isomorphic-lib/src/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import { useAppStorePick } from "../../lib/appStore";
import { useAuthHeaders, useBaseApiUrl } from "../../lib/authModeProvider";
import { ResourceType } from "../../lib/types";
import { useBroadcastMutation } from "../../lib/useBroadcastMutation";
import { useBroadcastQuery } from "../../lib/useBroadcastQuery";
import { useUpdateSegmentsMutation } from "../../lib/useUpdateSegmentsMutation";
import ResourceSelect from "../resourceSelect";
import SegmentEditor, { SegmentEditorProps } from "../segments/editor";
import { BroadcastState } from "./broadcastsShared";

function BroadcastSegmentEditor({
  broadcastId,
  disabled,
  onDefinitionChange,
}: {
  broadcastId: string;
  disabled?: boolean;
  onDefinitionChange?: () => void;
}) {
  const { workspace } = useAppStorePick(["workspace"]);
  const updateSegmentsMutation = useUpdateSegmentsMutation();
  const broadcastMutation = useBroadcastMutation(broadcastId);
  const { data: broadcast } = useBroadcastQuery(broadcastId);
  const segmentId = useMemo<string | undefined>(
    () => broadcast?.segmentId,
    [broadcast?.segmentId],
  );
  const isInternalSegment = useMemo(() => {
    if (workspace.type !== CompletionStatus.Successful) {
      return false;
    }
    const workspaceId = workspace.value.id;
    return segmentId === getBroadcastSegmentId({ broadcastId, workspaceId });
  }, [segmentId, broadcastId, workspace]);

  useEffect(() => {
    if (isInternalSegment || workspace.type !== CompletionStatus.Successful) {
      return;
    }
    const workspaceId = workspace.value.id;
    const newSegmentId = getBroadcastSegmentId({ broadcastId, workspaceId });
    const newSegmentName = getBroadcastSegmentName({
      broadcastId,
    });

    const entryNode: SegmentNode = {
      id: "1",
      type: SegmentNodeType.Everyone,
    };
    const definition: SegmentDefinition = {
      entryNode,
      nodes: [],
    };

    updateSegmentsMutation.mutate(
      {
        id: newSegmentId,
        name: newSegmentName,
        definition,
        resourceType: "Internal",
        status: "NotStarted",
        createOnly: true,
      },
      {
        onSuccess: () => {
          broadcastMutation.mutate({ segmentId: newSegmentId });
        },
      },
    );
  }, [workspace, segmentId, broadcastId]);

  const segmentsUpdateMutation = useUpdateSegmentsMutation();

  const persistSegmentChange = useDebouncedCallback((s: SegmentResource) => {
    segmentsUpdateMutation.mutate({
      id: s.id,
      definition: s.definition,
      name: s.name,
    });
  }, 1500);
  const updateSegmentCallback: SegmentEditorProps["onSegmentChange"] =
    useCallback(
      (s: SegmentResource) => {
        onDefinitionChange?.();
        persistSegmentChange(s);
      },
      [onDefinitionChange, persistSegmentChange],
    );

  if (segmentId === undefined || !isInternalSegment) {
    return null;
  }
  return (
    <SegmentEditor
      disabled={disabled}
      segmentId={segmentId}
      onSegmentChange={updateSegmentCallback}
      allowedNodeTypes={[
        SegmentNodeType.Performed,
        SegmentNodeType.Trait,
        SegmentNodeType.Everyone,
        SegmentNodeType.And,
        SegmentNodeType.Or,
      ]}
      inputWidth={320}
    />
  );
}

export default function Recipients({ state }: { state: BroadcastState }) {
  const { workspace } = useAppStorePick(["workspace"]);
  const broadcastQuery = useBroadcastQuery(state.id);
  const broadcastMutation = useBroadcastMutation(state.id);
  const authHeaders = useAuthHeaders();
  const baseApiUrl = useBaseApiUrl();
  const [warehousePreview, setWarehousePreview] = useState<{
    users: number;
    durationMs: number;
  } | null>(null);
  const [warehousePreviewError, setWarehousePreviewError] = useState<
    string | null
  >(null);
  const [warehousePreviewLoading, setWarehousePreviewLoading] = useState(false);
  const warehouseSourcePersistedForBroadcast = useRef<string | null>(null);
  const [selectExistingSegment, setSelectExistingSegment] = useState<
    "existing" | "new" | null
  >(null);

  useEffect(() => {
    const broadcast = broadcastQuery.data;
    if (
      !broadcast ||
      broadcast.status !== "Draft" ||
      broadcast.config.audienceSource === "StageWarehouse" ||
      warehouseSourcePersistedForBroadcast.current === broadcast.id
    ) {
      return;
    }
    warehouseSourcePersistedForBroadcast.current = broadcast.id;
    broadcastMutation.mutate(
      {
        config: {
          ...broadcast.config,
          audienceSource: "StageWarehouse",
          warehouseAudienceRunId: undefined,
        },
      },
      {
        onError: () => {
          warehouseSourcePersistedForBroadcast.current = null;
        },
      },
    );
  }, [broadcastMutation, broadcastQuery.data]);

  useEffect(() => {
    if (
      !broadcastQuery.data ||
      workspace.type !== CompletionStatus.Successful ||
      selectExistingSegment !== null
    ) {
      return;
    }
    if (
      broadcastQuery.data.segmentId &&
      broadcastQuery.data.segmentId ===
        getBroadcastSegmentId({
          broadcastId: state.id,
          workspaceId: workspace.value.id,
        })
    ) {
      setSelectExistingSegment("new");
    } else {
      // Default to 'existing' if there's a segmentId that isn't the internal one,
      // or if there's no segmentId at all (implying user might want to pick one)
      setSelectExistingSegment("existing");
    }
    // Only include external dependencies that determine the initial state
  }, [broadcastQuery.data, state.id, workspace]);

  const handleSegmentChange = useCallback(
    (resourceId: string | null) => {
      broadcastMutation.mutate({
        segmentId: resourceId,
      });
    },
    [broadcastMutation],
  );

  // Data is available now, assign to const for type narrowing
  const broadcast = broadcastQuery.data;
  const disabled = broadcast?.status !== "Draft";

  if (broadcastQuery.isLoading) {
    return null;
  }

  if (!broadcast || broadcast.version !== "V2") {
    return null;
  }

  const currentSegmentId = broadcast.segmentId ?? undefined;
  const previewWarehouseAudience = async () => {
    if (workspace.type !== CompletionStatus.Successful) return;
    setWarehousePreviewLoading(true);
    setWarehousePreview(null);
    setWarehousePreviewError(null);
    try {
      const response = await axios.post<{ users: number; durationMs: number }>(
        `${baseApiUrl}/broadcasts/warehouse-preview`,
        {
          workspaceId: workspace.value.id,
          broadcastId: state.id,
        },
        { headers: authHeaders },
      );
      setWarehousePreview(response.data);
    } catch (error) {
      setWarehousePreviewError(
        axios.isAxiosError<{ message?: string }>(error)
          ? error.response?.data.message ?? error.message
          : "Audience preview failed",
      );
    } finally {
      setWarehousePreviewLoading(false);
    }
  };

  let segmentSelect: React.ReactNode;
  switch (selectExistingSegment) {
    case "existing":
      segmentSelect = (
        <Box sx={{ maxWidth: 600 }}>
          <ResourceSelect
            resourceType={ResourceType.Segment}
            value={currentSegmentId ?? null}
            onChange={handleSegmentChange}
            disabled={disabled}
            label="Segment"
            currentPageLabel={broadcast.name || "Broadcast"}
          />
        </Box>
      );
      break;
    case "new":
      segmentSelect = (
        <BroadcastSegmentEditor
          broadcastId={state.id}
          disabled={disabled}
          onDefinitionChange={() => {
            setWarehousePreview(null);
            setWarehousePreviewError(null);
          }}
        />
      );
      break;
    case null:
      segmentSelect = null;
      break;
    default:
      assertUnreachable(selectExistingSegment);
  }
  return (
    <Stack spacing={2}>
      <Typography variant="caption" sx={{ mb: -1 }}>
        Audience Data Source
      </Typography>
      <Typography variant="h6">Stage Warehouse</Typography>
      <Stack spacing={1} sx={{ maxWidth: 760, alignItems: "flex-start" }}>
        <Typography variant="body2">
          Segment rules query Stage ClickHouse when the campaign starts. Only
          matching user IDs are kept temporarily in Dittofeed; current profile
          and device data is fetched in each send batch.
        </Typography>
        <Button
          variant="outlined"
          disabled={!currentSegmentId || warehousePreviewLoading}
          onClick={() => void previewWarehouseAudience()}
        >
          {warehousePreviewLoading
            ? "Querying Stage Warehouse…"
            : "Preview Warehouse Audience"}
        </Button>
        {warehousePreview ? (
          <Alert severity="success">
            {warehousePreview.users.toLocaleString()} matching users found in{" "}
            {(warehousePreview.durationMs / 1000).toFixed(2)} seconds.
          </Alert>
        ) : null}
        {warehousePreviewError ? (
          <Alert severity="error">{warehousePreviewError}</Alert>
        ) : null}
      </Stack>
      <Typography variant="caption" sx={{ mb: -1 }}>
        Audience Rules
      </Typography>
      <ToggleButtonGroup
        value={selectExistingSegment}
        exclusive
        disabled={disabled || selectExistingSegment === null}
        onChange={(_, newValue) => {
          if (newValue !== null) {
            setSelectExistingSegment(newValue);
            if (newValue === "existing") {
              broadcastMutation.mutate({ segmentId: null });
            }
          }
        }}
      >
        <ToggleButton value="existing">Existing Segment</ToggleButton>
        <ToggleButton value="new">New Segment</ToggleButton>
      </ToggleButtonGroup>
      {segmentSelect}
    </Stack>
  );
}
