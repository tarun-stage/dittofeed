import { CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { ChannelType, DeliveriesAllowedColumn } from "isomorphic-lib/src/types";
import { useMemo } from "react";

import { useAnalysisSummaryQuery } from "../../lib/useAnalysisSummaryQuery";
import { useBroadcastQuery } from "../../lib/useBroadcastQuery";
import {
  DEFAULT_DELIVERIES_TABLE_V2_PROPS,
  DeliveriesTableV2,
} from "../deliveriesTableV2";
import { BroadcastState } from "./broadcastsShared";

export default function Deliveries({ state }: { state: BroadcastState }) {
  const { data: broadcast } = useBroadcastQuery(state.id);
  const reportWindow = useMemo(
    () => ({
      startDate: new Date(broadcast?.createdAt ?? 0).toISOString(),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }),
    [broadcast?.createdAt],
  );
  const summaryQuery = useAnalysisSummaryQuery(
    {
      ...reportWindow,
      filters: {
        broadcastIds: [state.id],
        channel: broadcast?.config.message.type ?? ChannelType.MobilePush,
      },
    },
    {
      enabled: broadcast != null,
      refetchInterval: 5000,
    },
  );
  const summary = summaryQuery.data?.summary;
  const isInApp = broadcast?.config.message.type === ChannelType.InApp;
  const awaitingReceipt = Math.max(
    (summary?.sent ?? 0) - (summary?.deliveries ?? 0),
    0,
  );
  const deliveryRate = summary?.sent
    ? `${((summary.deliveries / summary.sent) * 100).toFixed(1)}%`
    : "0%";
  const tableProps = useMemo(() => {
    const { columnAllowList: previousColumnAllowList, ...rest } =
      DEFAULT_DELIVERIES_TABLE_V2_PROPS;
    return {
      ...rest,
      columnAllowList: previousColumnAllowList
        ?.filter((column) => column !== "origin")
        .flatMap<DeliveriesAllowedColumn>((column) =>
          column === "to" ? [column, "snippet"] : [column],
        ),
    };
  }, []);
  return (
    <Stack spacing={2} sx={{ width: "100%", height: "100%" }}>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        {[
          {
            label: isInApp ? "Impressions" : "Sent to FCM",
            value: summary?.sent ?? 0,
          },
          {
            label: isInApp ? "Shown" : "Delivered to device",
            value: summary?.deliveries ?? 0,
          },
          {
            label: isInApp ? "Not applicable" : "Awaiting receipt",
            value: isInApp ? "—" : awaitingReceipt,
          },
          { label: "Clicked", value: summary?.clicks ?? 0 },
          { label: "Delivery rate", value: deliveryRate },
        ].map((metric) => (
          <Paper
            key={metric.label}
            variant="outlined"
            sx={{ minWidth: 180, padding: 2, flex: "1 1 180px" }}
          >
            <Typography variant="body2" color="text.secondary">
              {metric.label}
            </Typography>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="h5" fontWeight={600}>
                {typeof metric.value === "number"
                  ? metric.value.toLocaleString()
                  : metric.value}
              </Typography>
              {summaryQuery.isFetching ? <CircularProgress size={16} /> : null}
            </Stack>
          </Paper>
        ))}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {isInApp
          ? "An impression is counted when the app confirms the in-app message was shown."
          : "Delivered is confirmed only after the app sends a push delivery receipt. Sent means Firebase accepted the notification request."}
      </Typography>
      <DeliveriesTableV2
        {...tableProps}
        broadcastId={state.id}
        autoReloadByDefault
        reloadPeriodMs={5000}
      />
    </Stack>
  );
}
