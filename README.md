# Scylla.ai ↔ DJI FlightHub 2 Middleware Bridge

Middleware bridge that translates Scylla.ai alert webhooks into DJI FlightHub 2 workflow triggers.

## Quick Deploy to Render.com (Free & Permanent)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com)

## Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/webhook/scylla` | Receives Scylla.ai alerts |
| GET | `/health` | Health check |
| GET | `/admin` | Admin config UI |
| POST | `/test/trigger` | Manual drone dispatch test |
| GET | `/logs` | Recent activity log |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SCYLLA_PUSH_TOKEN` | ✅ | Bearer token you set in Scylla HTTP Endpoint |
| `DJI_X_USER_TOKEN` | ✅ | Organization Key from FH2 → My Org → FlightHub Sync |
| `DJI_X_PROJECT_UUID` | ✅ | Your DJI project UUID |
| `DJI_WORKFLOW_UUID` | ✅ | Your DJI workflow UUID |
| `DJI_CREATOR_ID` | ✅ | Your DJI creator/user ID |
| `AUTO_TRIGGER_LEVEL` | ⚙️ | Min alert level to dispatch drone (1-5, default: 3) |

## License
MIT
