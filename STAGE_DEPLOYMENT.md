# STAGE Dittofeed test deployment

Dittofeed runs on `10.50.0.117` and owns its database, Docker network, provider calls, event processing, and message delivery. The current public route is temporary: requests to `engage.stage.in/dittofeed/...` and Celetel callbacks to `engage.stage.in/api/whatsapp/dlr` still reach `10.50.0.245:18080`, where the `stage-dittofeed-cutover-proxy` container relays them to the Dittofeed ingress on `10.50.0.117:18080`.

Zero-dependency cutover requires a dedicated public Dittofeed hostname that routes directly to `10.50.0.117:18080`. After that hostname exists, update the Flutter `dittofeed_base_url` build define and the Celetel delivery-callback URL, verify both routes, and remove `stage-dittofeed-cutover-proxy` from `10.50.0.245`.

## Service boundaries

```text
STAGE test client
       |
       v
Dittofeed Lite :3100
  |       |
  |       +-----------> dedicated ClickHouse volume (test events and computed properties)
  +-------------------> dedicated PostgreSQL container and volume: dittofeed_stage_test
                         Temporal databases: temporal_dittofeed_stage_test*

Temporal task queue --> dedicated Dittofeed worker container
```

All services use only `stage-dittofeed-network`. PostgreSQL, ClickHouse, Temporal, provider credentials, and delivery state live in Dittofeed-owned containers or volumes. Kafka is intentionally disabled for the test deployment; clients send Segment-compatible `identify` and `track` calls to Dittofeed's public API.

The Lite image remains the application distribution, but the running Lite container has `ENABLE_WORKER=false` and serves only the dashboard and API. `stage-dittofeed-worker` uses the same image and runs the worker entry point independently, so campaign execution cannot consume the API container's reserved CPU and memory.

Push is sent directly through Firebase Cloud Messaging. WhatsApp is sent directly to Celetel through a webhook template with the provider key stored in Dittofeed's webhook secret. Neither send route calls a Stage Engage application endpoint; only the temporary public ingress path described above remains shared.

New Flutter events and FCM tokens are sent directly to Dittofeed. A Dittofeed-owned selective stream also discovers event names referenced by running segments, user properties, and journeys, polls only those app/web/backend warehouse tables, enriches matching user profiles, and submits them through Dittofeed's public batch API. Its cursor is durable, and a newly selected event starts with a one-hour lookback for delayed warehouse arrivals rather than a historical replay.

The selective stream intentionally does not copy every analytics event. The source produces millions of rows per hour, so an all-events feed would exhaust this stage host. Complete analytics remain in the warehouse; Dittofeed stores the events needed for its active targeting definitions and its own delivery analytics.

## Deploy

Copy this repository to `/home/ubuntu/dittofeed-stage` on `10.50.0.117`, then run:

```bash
cd /home/ubuntu/dittofeed-stage
./scripts/stage-deploy.sh
```

The script generates `.env.stage` once with mode `0600`. On a fresh database it enables bootstrap for the first healthy start, then recreates Lite with bootstrap disabled. Later runs stay in steady-state mode. The prebuilt `stage-dittofeed-lite:v0.24.0-alpha.17-stage-ui11` image must be loaded before running the script.

Open `http://10.50.0.117:3100`. The single-tenant login password is stored in `/home/ubuntu/dittofeed-stage/.env.stage`.

## Verification

```bash
curl --fail http://10.50.0.117:3100/api
docker compose --env-file .env.stage -f docker-compose.stage-test.yaml ps
docker inspect stage-dittofeed-lite --format '{{json .NetworkSettings.Networks}}'
docker inspect stage-dittofeed-temporal --format '{{json .NetworkSettings.Networks}}'
docker exec stage-dittofeed-clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --query "show tables from dittofeed_stage_test"'
docker exec stage-dittofeed-temporal tctl --address stage-dittofeed-temporal:7233 --namespace stage-dittofeed-test namespace describe
docker inspect stage-dittofeed-selective-stream --format '{{json .State.Health}}'
docker logs --tail 50 stage-dittofeed-selective-stream
```

Use only designated test users and recipients during this phase. Email and SMS are not configured. Firebase and Celetel credentials must remain in Dittofeed's secret records and must never be committed.

## Current smoke test

The deployed stack must be verified with one designated test user, one `identify` event, and one `STAGE_DITTOFEED_SMOKE_TEST` track event. Both public API calls must return `204`, and both message IDs must appear in `dittofeed_stage_test.user_events_v2`.
