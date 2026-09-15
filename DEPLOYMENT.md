# Production deployment

- URL: https://ipalpha-kids-camping.kevyn.com.br
- Namespace: `ipalpha-kids`; node: `kevyn-local-server`.
- Manifests: `~/WebstormProjects/k8s/ipalpha/kids/acampa-2025/`.
- Release from the parent `camping/` directory with `./publish -d`, then `./publish`.
  The tool commits/pushes both changed application repositories and the Kubernetes
  manifests; CI builds the versioned images and applies the manifests. Always
  verify the running image versions and rollout, not just the Git push.

## Environment inventory

All values below are backend runtime variables. Never put credentials into
committed YAML or frontend `VITE_*` variables.

| Variable | Production value / source |
|---|---|
| `NODE_ENV` | `production` (Bun/runtime) |
| `PORT` | `3000` |
| `CORS_ORIGIN` | `https://ipalpha-kids-camping.kevyn.com.br` |
| `MONGODB_URI` | `mongodb://$(MONGO_USERNAME):$(MONGO_PASSWORD)@acampa-2025-mongo:27017/camping?authSource=admin` |
| `MONGODB_DB` | `camping` |
| `MONGO_USERNAME`, `MONGO_PASSWORD` | Deployment-only expansion variables from Secret `mongo-credentials`, keys `username`, `password`; credentials must be URI-safe |
| `FILES_DIR` | `/app/data/files`, mounted from `acampa-2025-pictures-pvc` |
| `JWT_SECRET` | Secret `acampa-2025-secrets`, key `jwt-secret`; required, strong, never the development default |
| `SESSION_HOURS` | `96` |
| `OTP_EXPIRE_MINUTES` | `5` |
| `OTP_MAX_ATTEMPTS` | `3` |
| `ACCOUNT_FREEZE_MINUTES` | `30` |
| `RESEND_COOLDOWN_SECONDS` | `60` |
| `COMTELE_API_KEY` | Secret `acampa-2025-secrets`, key `comtele-api-key`; required in production. Empty enables console-only mock OTP |
| `COMTELE_PREFIX` | `AcampaKids` |
| `APP_URL` | `https://ipalpha-kids-camping.kevyn.com.br` (SMS links) |
| `NOTIFY_COALESCE_SECONDS` | `20` |
| `AI_BASE_URL` | `https://ai-models.kevyn.com.br/v1` |
| `AI_API_KEY` | Secret `acampa-2025-secrets`, key `ai-api-key`; optional, empty disables AI |
| `AI_TRANSCRIBE_URL` | `https://whisper.kevyn.com.br/v1`; empty hides voice input |
| `AI_TRANSCRIBE_MODEL` | `whisper-large-v3-turbo` |
| `AI_TRANSCRIBE_KEY` | Optional Secret key `ai-transcribe-key`; leave absent if the speech endpoint needs no authentication |
| `FACE_SERVICE_URL` | `http://acampa-2025-face:8000` (cluster-internal only). Empty disables the parents' photo search |
| `FACE_MATCH_THRESHOLD` | `0.22`; low so parents find their kid (a few other children in the results is ok) |
| `FACE_MIN_DETECTION_SCORE` | `0.4` |

MongoDB uses `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD`
from `mongo-credentials`, and `MONGO_INITDB_DATABASE=camping`. These initialize
an empty database only; changing the Secret does not rotate an existing DB user.

The frontend needs **no production environment variables**: `/api`, uploaded
images, and WebSocket traffic use the browser origin, routed by Traefik.
`VITE_API_URL` is an optional **build-time** override, not an nginx runtime
variable. `DEV_LAN` is development-only. Docker excludes local `.env` files.

## Face service (parents' photo search)

- Manifest: `face-service.yaml` (Deployment + ClusterIP Service + `acampa-2025-face-models-pvc`).
- Repo: `ipalpha-acampa-kids-2025-face-service` (sibling folder `../face-service`),
  image `registry.kevyn.com.br/ip-alpha/kids/acampa-2025-face`, published by the
  parent folder's `./publish` like the backend and the frontend.
- Requests one time-sliced GPU (`nvidia.com/gpu: 1`, `runtimeClassName: nvidia`).
  It also runs on CPU: drop the GPU limit and the runtime class, expect seconds
  per photo instead of fractions.
- First start downloads the InsightFace `buffalo_l` pack into the PVC; the
  startup probe allows up to ten minutes for it.
- Never expose it through the ingress. It is the only component that sees a
  parent's reference photo, and it stores nothing.
- Rolling the backend re-runs the face backfill for photos without
  `facesIndexedAt`; indexing failures are simply retried on the next boot.

## Persistent data and upgrades

- MongoDB: `/mnt/k8s-data/ipalpha/kids/acampa-2025/mongo`.
- Pictures (editor images, album originals, thumbnails):
  `/mnt/k8s-data/ipalpha/kids/acampa-2025/pictures` → `/app/data/files`.
- Both PVs use local storage, node affinity, and `Retain`. The pictures claim
  explicitly binds its PV. The declared 20Gi capacity is not a filesystem quota:
  monitor free space on the server and keep off-host backups.
- The backend currently runs as root, matching the root-owned pictures directory.
  If switching to a non-root container, migrate directory ownership first.
- Keep one backend replica with `Recreate`: realtime sockets and notification
  timers are process-local. A rollout causes a brief API interruption; clients
  reconnect. MongoDB also uses `Recreate` to avoid two writers on its data files.
- Startup creates indexes and performs one-off migrations (including transports,
  teams, parent-edit stamps, and admin roster entries). Back up MongoDB before
  publishing. A code rollback does **not** undo these data migrations.
- Legacy images in MongoDB migrate lazily when read; no manual copy is needed.
  Do not upload local development `data/` to production: file metadata must match
  the target database. Runtime pictures, `.env`, and scratch files are excluded
  from Git/build contexts.
- Check Settings → notification toggles and SMS redirect before real use. Do not
  send OTPs or enable broadcasts just to smoke-test a deployment.

## Verification

```bash
kubectl apply --dry-run=server -f ~/WebstormProjects/k8s/ipalpha/kids/acampa-2025/
kubectl -n ipalpha-kids get pvc
kubectl -n ipalpha-kids rollout status deploy/acampa-2025-backend
kubectl -n ipalpha-kids rollout status deploy/acampa-2025-frontend
kubectl -n ipalpha-kids exec deploy/acampa-2025-backend -- \
  bun -e 'console.log(await (await fetch("http://localhost:3000/health")).json())'
curl -I https://ipalpha-kids-camping.kevyn.com.br
```

`/health` is an internal liveness endpoint, not routed through the public
frontend ingress. It confirms startup, not ongoing DB availability. Verify an
API request and stored-image retrieval separately, plus that a filesystem write
inside `/app/data/files` appears in the server's pictures directory.
