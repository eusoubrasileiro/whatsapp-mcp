# whatsapp-mcp stack — ops runbook

One VPS behind Traefik, **one public hostname**, any number of WhatsApp numbers. Each number is
its own container with its own pairing, database, token and media store; a small hub container
shows them all on one page. With `PUBLIC_DOMAIN=wa.example.com` (substitute your own hostname) and a
number labelled `<label>`, the stack publishes:

- `https://wa.example.com/` — the **hub page**, behind a PIN: one card per number with its
  connection state, the QR code to pair it, its MCP address and the "unlink" action
  (`whatsapp-mcp-hub:39002`). Every path that is not one of the routes below also lands here
  and gets the PIN form.
- `https://wa.example.com/<label>/mcp` — Bearer-auth MCP endpoint of that number
  (`whatsapp-mcp-<label>:39001`).
- `https://wa.example.com/<label>/upload` — Bearer-auth host-disk upload endpoint
  (`whatsapp-mcp-<label>:39003`). Agents POST raw bytes here, get back `{url}`, then pass it to
  `send_file`. Same `MCP_AUTH_TOKEN` as that number's `/mcp`. See
  [`docs/tools.md`](../docs/tools.md#sending-host-disk-files-the-upload-endpoint).
- `wss://wa.example.com/<label>/stream` — `follow_chat` WebSocket presence stream
  (`whatsapp-mcp-<label>:39004`). Scoped short-lived token gate enforced inside the app; the
  token rides the query string (`?token=…`). See
  [`docs/agent-presence-stream-recipe.md`](../docs/agent-presence-stream-recipe.md).
- `https://wa.example.com/<label>/media/t/<key>` — public media URLs served by that number's
  own RustFS container (path-rewrite via Traefik to
  `whatsapp-mcp-<label>-minio:9000/amiticia-media/t/<key>`). A key of one number is not found
  under another number's label.

A number's own status port (`:39002`: `/health`, `/live`, `/qr.png`) is **not** routed
publicly. The hub reads it over the Docker network; you read it with `docker exec`.

Audience: whoever operates the stack — which network, which certresolver, which token. Start here.

## The files

| File | What it runs | Env file | Command |
|---|---|---|---|
| `docker-compose.yaml` | the shared stack: the hub (`whatsapp-mcp-hub`) and nothing else | `.env` (template `.env.example`) | `docker compose up -d` |
| `docker-compose.instance.yaml` | one WhatsApp number (`whatsapp-mcp-<label>`) and its media store (`whatsapp-mcp-<label>-minio`), once per number | `.env.<label>` (template `instance.env.example`) | `docker compose --env-file .env.<label> up -d` |

Each number is its own compose project (`whatsapp-mcp-<label>`), so starting, stopping or
recreating one never touches another. A number's store belongs to its project: it has its own
data directory and its own credentials, written only in that number's env file, and the shared
stack holds no store credential at all. Every `docker compose` command for a number carries
`--env-file .env.<label>`; the `COMPOSE_FILE` line inside that file picks the right compose file.
Every variable is described in [`docs/configuration.md`](../docs/configuration.md).

## Prerequisites

- Docker 28+ on the VPS (`ssh <vps>` below)
- Traefik v3 running, certresolver named **`myresolver`** (ACME TLS-ALPN, Let's Encrypt), attached to `network_public` — or edit the compose labels to match yours
- If `image:` points at a private registry, the VPS's docker is logged in to it
- DNS: **one** record (your `PUBLIC_DOMAIN`) pointing at the VPS
  - If the zone is on Cloudflare, keep the record **DNS only (grey cloud)** — Traefik uses the TLS-ALPN challenge, which the CF proxy would break.

## First-time deploy

```bash
ssh <vps>

# 1. clone both repos side by side
cd /opt
git clone https://github.com/eusoubrasileiro/whatsapp-mcp.git
git clone https://github.com/eusoubrasileiro/baileys-client.git

# 2. build image (baileys-client is linked via BuildKit --build-context)
#    The hub and every number run this one image.
cd /opt
DOCKER_BUILDKIT=1 docker build \
  --build-context baileys=/opt/baileys-client \
  -t ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /opt/whatsapp-mcp

# 3. shared stack: create .env
cd /opt/whatsapp-mcp/deploy
cp .env.example .env
chmod 600 .env
vi .env
# fill:
#   PUBLIC_DOMAIN=wa.example.com                # your hostname — compose refuses to start without it
#   HUB_PIN=<the PIN that opens the hub page>   # at least 4 characters; never commit it
#   HUB_COOKIE_KEY=<openssl rand -hex 32>
#   HUB_INSTANCE_SECRET=<openssl rand -hex 32>  # optional; without it the hub offers no unlink
#   HUB_INSTANCES=<label>                       # every number's label, comma-separated
#   HUB_LANG=en                                 # or pt-BR
#   NTFY_TOPIC_URL=https://ntfy.sh/<long-random-topic>

# 4. prepare the bind mount and start the shared stack (the hub; it holds no store)
mkdir -p /storage/whatsapp-mcp-hub
docker compose up -d
until [ "$(docker inspect -f '{{.State.Health.Status}}' whatsapp-mcp-hub 2>/dev/null)" = "healthy" ]; do sleep 2; done

# 5. the hub answers, and asks for the PIN
curl -sS -o /dev/null -w '%{http_code}\n' https://wa.example.com/
# expect 401 (the PIN form)
```

Then add the first number.

## Add a number

```bash
ssh <vps>
cd /opt/whatsapp-mcp/deploy

# 1. one env file per number
cp instance.env.example .env.<label>
chmod 600 .env.<label>
vi .env.<label>
# fill:
#   INSTANCE=<label>                       # lowercase letters, digits, hyphens
#   INSTANCE_DESCRIPTION=<one line>        # shown on the hub card and to agents
#   PUBLIC_DOMAIN=wa.example.com           # same as .env
#   MCP_AUTH_TOKEN=<openssl rand -hex 32>  # one per number, never shared between numbers
#   EXPECTED_WA_NUMBER=<the number as WhatsApp writes it, digits only — see the note below>
#   MINIO_ROOT_USER=<openssl rand -hex 16>      # this number's own store pair: a new pair
#   MINIO_ROOT_PASSWORD=<openssl rand -hex 16>  # per number, never another number's
#   HUB_INSTANCE_SECRET                    # same value as .env (or empty in both)
#   NTFY_TOPIC_URL, OPENROUTER_API_KEY
#   SEND_COLD_OVERRIDE / SEND_COLD_ALLOWED_JIDS  # per-number send policy — see docs/account-restrictions.md

# 2. look before you start: containers, data directories and media prefix of this number
docker compose --env-file .env.<label> config | grep -E 'container_name|source: |TENANT_ID'
# expect whatsapp-mcp-<label>, whatsapp-mcp-<label>-minio, /storage/whatsapp-mcp-<label>,
#        /storage/whatsapp-mcp-<label>/minio, <label>

# 3. the store's directory. The store runs as uid 10001; a directory that Docker creates by
#    itself belongs to root, and the store could not write to it.
install -d -m 750 -o 10001 -g 10001 /storage/whatsapp-mcp-<label>/minio

# 4. start it: the store first, then the number once its store is healthy
docker compose --env-file .env.<label> up -d
until [ "$(docker inspect -f '{{.State.Health.Status}}' whatsapp-mcp-<label> 2>/dev/null)" = "healthy" ]; do sleep 2; done

# 5. list it on the hub, if it is not there yet: add the label to HUB_INSTANCES in .env, then
docker compose up -d hub

# 6. its MCP endpoint is routed and refuses a wrong token
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://wa.example.com/<label>/mcp \
  -H 'Authorization: Bearer WRONG' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c","version":"0"}}}'
# expect 401

# 7. pair: open https://wa.example.com/ , enter the PIN, and scan the QR code on the card
#    <label> with that number's phone (WhatsApp > Linked Devices > Link a device).
#    The card names the number and its last 4 digits, and the code refreshes by itself.
```

Set `EXPECTED_WA_NUMBER` **before** pairing: it is what logs out and purges a pairing made by
any other phone. The hub card's "Connect a client" block gives the address and a ready client
entry for that number; the token is never shown there — it is in `.env.<label>`.

**Write `EXPECTED_WA_NUMBER` in the form WhatsApp itself uses for that account, which is not
always the form you dial.** The check is a prefix match on the paired account's own id. A
Brazilian mobile number, for one, can be registered without the extra 9 (12 digits); the
13-digit form typed by hand would then make the server log out and purge a correct pairing. Read
the form from a database that already knows the number (`jid_aliases.pn_jid` in another paired
number's archive). If you cannot, use a shorter prefix such as the country and area code: it is
still accepted, and the only loss is that the hub cannot show the last 4 digits before pairing.

A label that ends in `-minio` is best avoided: `whatsapp-mcp-<label>-minio` is the name of a
number's store.

## Pair again, or unlink a number

- **Pair again** (the phone unlinked the device, or WhatsApp logged it out): the card shows a
  new QR code by itself. Open the hub, scan it with that number's phone.
- **Unlink** (move the number to another phone, or take it off this server): the card's unlink
  link opens a confirmation page that asks for the PIN again and for the label typed out. It
  logs the number out of WhatsApp and clears its pairing — the same action as the `logout`
  tool. It exists only when `HUB_INSTANCE_SECRET` is set (at least 32 characters) to the same
  value in `.env` and in that number's file.

**Never unlink or pair a number while WhatsApp shows a restriction countdown on that phone.**
See [`docs/account-restrictions.md`](../docs/account-restrictions.md).

## Update / redeploy (after code change upstream)

```bash
ssh <vps>
cd /opt/whatsapp-mcp && git pull
cd /opt/baileys-client && git pull   # only if baileys-client changed
DOCKER_BUILDKIT=1 docker build \
  --build-context baileys=/opt/baileys-client \
  -t ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /opt/whatsapp-mcp
cd /opt/whatsapp-mcp/deploy
docker compose up -d --force-recreate hub                    # the hub
# once per number; --no-deps leaves that number's store running
docker compose --env-file .env.<label> up -d --force-recreate --no-deps whatsapp-mcp-instance
docker logs -f whatsapp-mcp-<label>   # watch it recover
```

Each number's auth state (`/data/auth_info/`) and SQLite DB (`/data/data/whatsapp.db`) are
preserved across recreates via its host bind mount (`/storage/whatsapp-mcp-<label>:/data`), and
its media objects via the store's (`/storage/whatsapp-mcp-<label>/minio`). You do NOT re-scan
the QR on updates.

The server and the hub run as the user `wamcp` (uid/gid 10010), not root. On every start the
container first hands its `/data` to that user, leaving `minio/` (the store's, uid 10001)
untouched, so a directory written by an older root build needs no manual step: the first start
changes the owner of its files, later starts change nothing. On the host those files belong to
uid 10010, which has no login. Run maintenance commands that write under `/data` as that user,
`docker exec --user wamcp whatsapp-mcp-<label> …`; a file root creates there is handed over
only at the next start.

Do not `docker compose pull` a number's project as part of an update: that would also fetch a
newer build of the store image, and the next recreate would start it on the existing objects.
Update the store on purpose, one number at a time, after reading its release notes.

## Migrating from the single-instance layout

Before this layout, one container named `whatsapp-mcp` served one number on two hostnames
(`MCP_DOMAIN`, `QR_DOMAIN`) with its data in `/storage/whatsapp-mcp`. That number keeps its
pairing, its database and its media **in place**: it becomes a number with a label whose env
file points at the old directory and keeps the old media prefix.

**The one rule that protects the pairing: the old container and the new container of that
number must never run at the same time** — both would open the same WhatsApp session. The same
holds for the media: the old store container (`whatsapp-mcp-minio`) and the number's new store
use the same directory and must never run at the same time.

```bash
ssh <vps>
cd /opt/whatsapp-mcp/deploy

# A. Prepare — the old container keeps running
cp -p .env .env.single-instance                 # the way back
docker tag ghcr.io/amiticia-autosys/whatsapp-mcp:latest ghcr.io/amiticia-autosys/whatsapp-mcp:rollback
git -C /opt/whatsapp-mcp rev-parse HEAD         # note it: the commit to roll back to
git -C /opt/whatsapp-mcp pull                   # from here `docker compose` no longer knows
                                                # the old service: use plain `docker` for it
# build the image as in "Update / redeploy", then write the env files:
#   .env          — shared stack: the hub's settings only, no store credential
#   .env.<label>  — the existing number: today's MCP_AUTH_TOKEN and EXPECTED_WA_NUMBER, every
#                   SEND_* / AUDIO_* / VISION_* / WATCHDOG_* line today's .env sets,
#                   MINIO_ROOT_USER / MINIO_ROOT_PASSWORD with TODAY'S values, plus
#                     INSTANCE_DATA_DIR=/storage/whatsapp-mcp
#                     TENANT_ID=default
docker compose config -q
docker compose --env-file .env.<label> config | grep -E 'container_name|source: |TENANT_ID'
# MUST show /storage/whatsapp-mcp, /storage/whatsapp-mcp/minio and default. Anything else:
# stop — starting it would create an empty number that asks for a QR code.

# B. Cut over — about two minutes of downtime
docker stop whatsapp-mcp whatsapp-mcp-minio
tar czf /storage/whatsapp-mcp/backups/pre-onehost.tgz -C /storage/whatsapp-mcp auth_info data
(cd /storage/whatsapp-mcp && find auth_info data -type f \( -path 'auth_info/*' -o -name 'whatsapp.db*' \) -print0 \
  | sort -z | xargs -0 sha256sum) > /root/pre-onehost.sha256
docker rm whatsapp-mcp whatsapp-mcp-minio whatsapp-mcp-minio-init
docker compose up -d                            # the hub
(cd /storage/whatsapp-mcp && sha256sum -c /root/pre-onehost.sha256)   # every line OK, or roll back
docker compose --env-file .env.<label> up -d    # its store on the same directory, then the number
docker exec whatsapp-mcp-<label> wget -q -O- http://127.0.0.1:39002/health
# status becomes "connected" (it reads "syncing" for the first minute) and no QR is pending
```

Then check from outside: `https://wa.example.com/` asks for the PIN and the card reads
connected; `https://wa.example.com/<label>/mcp` answers the usual probe with today's token and
401 without one. Clients change only their URL.

Afterwards, the same day:

- the backup cron names a container that no longer exists — see [Backups](#backups-hourly-snapshot--daily-rotation);
- an external monitor on `/health` or `/live` now gets the hub's PIN form. Point it at
  `https://wa.example.com/<label>/upload` — see [Monitoring](#monitoring). Connection loss is
  still pushed by ntfy, with `[<label>]` in the title;
- media links that were handed out as `https://<old MCP host>/media/…` no longer resolve; the
  objects are still there, under `https://wa.example.com/<label>/media/…`.

**Rollback**, any time after `docker stop whatsapp-mcp`: `docker rm -f` the new containers
(`whatsapp-mcp-<label>`, `whatsapp-mcp-<label>-minio`, `whatsapp-mcp-hub`), `git checkout` the
commit you noted,
`cp -p .env.single-instance .env`, `docker tag …:rollback …:latest`, `docker compose up -d`. The
old container comes back on the same directory. Restore `pre-onehost.tgz` only if the
fingerprint check failed, and with every container stopped.

## Migrating from one shared store to one store per number

For a host deployed while every number shared one store: a `minio` service in the shared
stack (container `whatsapp-mcp-minio`, data in `/storage/whatsapp-mcp/minio`) with one pair of
credentials in every env file. Afterwards each number has its own store, directory and pair.

- The number whose env file says `INSTANCE_DATA_DIR=/storage/whatsapp-mcp` **keeps its objects
  where they are**: its new store starts on the old directory. Nothing of it is copied.
- Every other number gets a new, empty store, and its objects (under `t/<label>/` in the old
  store) are copied into it with the copy tool that ships in the image.

Two rules protect the data. **Two stores never run on the same directory**: stop
`whatsapp-mcp-minio` before the number that keeps the old directory is started from the new
file. **Do not pull the store image** during the move: the new stores must run the build the old
one runs.

```bash
ssh <vps>
cd /opt/whatsapp-mcp/deploy

# A. Prepare — nothing stops
cp -p .env .env.pre-store                                      # the way back,
cp -p .env.<label> .env.<label>.pre-store                      # once per number
docker tag ghcr.io/amiticia-autosys/whatsapp-mcp:latest ghcr.io/amiticia-autosys/whatsapp-mcp:rollback
git -C /opt/whatsapp-mcp rev-parse HEAD                        # note it
git -C /opt/whatsapp-mcp pull     # from here the shared stack's file no longer knows `minio`:
                                  # no `docker compose up` or `down` for it before step D
# build the image as in "Update / redeploy" (it carries the copy tool), then prove the tool
# is in it. It gets no network and no setting, so it can reach nothing:
docker run --rm --network none ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  node --experimental-strip-types src/store-copy-cli.ts verify; echo "exit $?"
# expect exactly:  error: STORE_COPY_SRC_ENDPOINT is required   and   exit 2
# env files:
#   .env.<label>  — a NEW MINIO_ROOT_USER / MINIO_ROOT_PASSWORD pair in every number's file
#   .env          — delete both MINIO_ROOT_* lines
# Nothing else may change, least of all EXPECTED_WA_NUMBER. This prints nothing when that holds:
diff <(grep -v '^MINIO_ROOT_' .env.<label>) <(grep -v '^MINIO_ROOT_' .env.<label>.pre-store)   # per number
docker compose --env-file .env.<label> config | grep -E 'container_name|source: |TENANT_ID'   # per number

# B. Every number that gets a new store — about a minute offline each
install -d -m 750 /storage/whatsapp-mcp-<label>/minio
chown --reference=/storage/whatsapp-mcp/minio /storage/whatsapp-mcp-<label>/minio
docker compose --env-file .env.<label> up -d --wait minio      # its store only; the number stays online,
                                                               # but its media links answer 403 from here
                                                               # until the last line of this step
docker stop whatsapp-mcp-<label>                               # offline from here
# /root/store-copy.env (chmod 600): source = the old store with the old pair, destination =
# the new store with the number's new pair, prefix = the number's own
#   STORE_COPY_SRC_ENDPOINT=whatsapp-mcp-minio
#   STORE_COPY_SRC_ACCESS_KEY / STORE_COPY_SRC_SECRET_KEY   (from .env.pre-store)
#   STORE_COPY_DST_ENDPOINT=whatsapp-mcp-<label>-minio
#   STORE_COPY_DST_ACCESS_KEY / STORE_COPY_DST_SECRET_KEY   (from .env.<label>)
#   STORE_COPY_PREFIX=t/<label>/
run() { docker run --rm --network network_public --env-file /root/store-copy.env \
  ghcr.io/amiticia-autosys/whatsapp-mcp:latest node --experimental-strip-types src/store-copy-cli.ts "$@"; }
run copy       # source N, copied N, unchanged 0, failed 0
run verify     # source N, destination N, identical N, missing 0, different 0, extra 0
               # anything else: `docker start whatsapp-mcp-<label>` (back on the old store) and stop
docker compose --env-file .env.<label> up -d                   # the number, on its own store

# C. The number that keeps the old directory — one to two minutes offline
docker stop whatsapp-mcp-<label>
docker stop whatsapp-mcp-minio                                 # the old shared store
docker compose --env-file .env.<label> up -d                   # its store on the old directory, then the number

# D. The shared stack, now the hub alone
docker compose up -d --remove-orphans     # removes the stopped whatsapp-mcp-minio, and recreates the
                                          # hub on the new image: the PIN page is away for a few seconds
shred -u /root/store-copy.env
```

`copy` never writes to or deletes from the source and can be repeated; `verify` compares every
object's bytes, size and content type and prints counts only (a key can contain a phone
number; `--show-keys` prints the failing ones).

**Rehearse on the host first.** Before step B, do it to a label no number uses: copy one env
file to `.env.<throwaway>`, set `INSTANCE` and a new pair in it, create its directory, start
**only its store** (`up -d --wait minio`, never without the service name, or compose starts a
third app), fetch `https://wa.example.com/<throwaway>/media/t/x` (403 `AccessDenied` is the
new store answering on its own route; 404 `NoSuchKey` is the old shared store, so the route is
not in place), and run `copy` and `verify` into that store with `time` in front. That proves
the store, the route and the tool on that host and prints how long the copy takes, with no
number stopped. The source is only read, and the copies are not public: a store whose app never
started has no bucket policy. Then `docker compose --env-file .env.<throwaway> down` and
remove its env file and directory.

No number needs a new QR scan: no step touches an `auth_info` directory, and the `diff` in
step A shows that nothing but the store pair changed in a number's settings. Check each number
as after any redeploy, then fetch one of its old media links, and the same path under another
number's label — the first answers 200, the second 404.

**Until the old copies are removed** they also remain in the store on the old directory,
readable at `/<label of that number>/media/t/<other label>/<key>` by whoever holds the full key.
Remove them when the move has settled, with the source pointed at that store and its new pair:
`run verify`, then `run remove-source --confirm t/<label>/`. It removes nothing unless every
object is found identical in the destination.

**Rollback**: stop the numbers; copy back whatever a moved number wrote since (`run copy` with
source and destination exchanged, into the store running on the old directory); `docker rm -f`
every number and its store; restore the `.pre-store` env files; `git checkout` the commit you
noted; `docker tag …:rollback …:latest`; `docker compose up -d`, then each number.

## Rotate a token, the PIN, or a store's pair

```bash
ssh <vps>
cd /opt/whatsapp-mcp/deploy

# one number's MCP token
NEW=$(openssl rand -hex 32)
sed -i "s/^MCP_AUTH_TOKEN=.*/MCP_AUTH_TOKEN=$NEW/" .env.<label>
docker compose --env-file .env.<label> up -d --force-recreate
echo "new token: $NEW"
# then update every MCP client entry for that number (~/.claude.json, Claude Desktop, Cursor).
# Until updated, those clients hit HTTP 401. Other numbers are not affected.

# the hub PIN: edit HUB_PIN in .env, then
docker compose up -d hub

# one number's store pair: write a new MINIO_ROOT_USER and MINIO_ROOT_PASSWORD in .env.<label>, then
docker compose --env-file .env.<label> up -d     # recreates that store and that number
# The store takes the pair from its environment at every start, so the objects already there
# stay readable; the old pair stops working. No client changes anything.
```

A new PIN does **not** end the sessions that are already signed in (a session lasts 30 days and
is signed with `HUB_COOKIE_KEY`, not with the PIN). If the PIN may have leaked, change
`HUB_PIN` **and** `HUB_COOKIE_KEY` together: that signs every browser out.

## Logs

```bash
ssh <vps>

# FastMCP stdout of one number (sparse — mostly startup messages)
docker logs -f whatsapp-mcp-<label>

# MCP server pino logs (tool invocations, auth, session)
docker exec whatsapp-mcp-<label> tail -f /data/mcp-logs.txt

# Baileys + ntfy + connection-notifier pino logs (QR, pairing, disconnect, push attempts)
docker exec whatsapp-mcp-<label> tail -f /data/wa-logs.txt

# Find something specific
docker exec whatsapp-mcp-<label> grep -iE 'ntfy|error|loggedOut' /data/wa-logs.txt | tail -20

# The hub: sign-ins, locks, unlinks (never a PIN, a token or a full number)
docker logs -f whatsapp-mcp-hub
```

## Monitoring

Connection loss is pushed by ntfy, with `[<label>]` in the title. For an external monitor
that reads only the status code:

| Request | Answer | Means |
|---|---|---|
| `GET https://wa.example.com/` | 401 | the hub is up (the PIN form) |
| `GET https://wa.example.com/<label>/upload` | 405 | that number's container is up and routed |
| `GET https://wa.example.com/<label>/upload` | 401 | that number is **down**: its routes are gone and the hub answered with the PIN form |

`/<label>/mcp` cannot tell the two apart: without a token it answers 401 when the number is
up, and the hub answers 401 when it is down. A probe script kept on the host takes the label
as its argument, since every number has its own address and token.

## Media plane (one RustFS per number)

Media downloaded by the `download_media` tool, and files sent to `/upload`, are stored in the
number's own store: the `minio` service (runs RustFS) of its compose project, container
`whatsapp-mcp-<label>-minio`, with its own credentials (`MINIO_ROOT_USER` /
`MINIO_ROOT_PASSWORD` in `.env.<label>`, in no other file). The bucket is `amiticia-media` in
every store and the keys start with `t/<label>/` (`TENANT_ID`). The app creates the bucket at
start and sets a policy that allows reading one object by its key and nothing else. Public
URLs look like:

```
https://wa.example.com/<label>/media/t/<label>/<sanitizedJid>/<msgId>.<ext>
```

Each store carries its own Traefik router: `/<label>/media/<key>` is rewritten to
`whatsapp-mcp-<label>-minio:9000/amiticia-media/<key>` via a `replacepathregex` middleware, and
only paths that name an object key (`/<label>/media/t/…`) are routed. So a key of one number
is not found under another number's label, and a request for the bucket itself (a listing)
never reaches a store and gets the hub's PIN form. There is **no** extra DNS record, **no**
subdomain, **no** managed cloud bucket.

Storage is bind-mounted at `<data>/minio` — `/storage/whatsapp-mcp-<label>/minio`, or under the
directory `INSTANCE_DATA_DIR` names — so an offsite backup of a number's data tree covers its
media. The directory must belong to uid 10001, the user the store runs as.

**Memory.** Each store has a ceiling of 150 MiB of RAM (`STORE_MEM_LIMIT` in `.env.<label>`
changes it). The ceiling is a limit, not a cost: an idle store uses a fraction of it, whatever
the limit and however many objects it holds — read it with
`docker stats --no-stream whatsapp-mcp-<label>-minio`. One file at a time fits under the
ceiling, even of the largest size the app stores. Several of the largest at once fit only
because the store may spill into the host's swap (the file sets no swap limit on purpose; the
routing spec of `pnpm test:e2e` re-checks four at once on every run); on a host with no free
swap the kernel stops the store instead. Docker starts it again within seconds and the
WhatsApp connection is not involved, but the calls in flight fail.
`docker inspect --format '{{.State.OOMKilled}} {{.RestartCount}}' whatsapp-mcp-<label>-minio`
should read `false 0`; if it does not, raise `STORE_MEM_LIMIT` for that number (for example
`200m`), recreate its store and read the two values again.

Sanity-check after deploy:

```bash
ssh <vps>
cd /opt/whatsapp-mcp/deploy
docker compose --env-file .env.<label> ps
# expect: whatsapp-mcp-<label> Up (healthy), whatsapp-mcp-<label>-minio Up (healthy)

# Traefik route to this number's store
curl -sS -o /dev/null -w "%{http_code}\n" https://wa.example.com/<label>/media/t/probe-does-not-exist
# expect 404 (Not Found from RustFS) — proves routing is wired

# no listing
curl -sS -o /dev/null -w "%{http_code}\n" "https://wa.example.com/<label>/media/?list-type=2"
# expect 401 (the hub's PIN form), never a list of keys

# the ceiling
docker inspect --format '{{.HostConfig.Memory}}' whatsapp-mcp-<label>-minio
# expect 157286400 (150 MiB)
```

After a backfill (`scripts/backfill-media.sh`, only for deployments older than the media plane), pick any row with `media_object_key IS NOT NULL` and `curl -I` its public URL — should return `HTTP/2 200`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `https://wa.example.com/` returns TLS error | CF proxy on (orange cloud) blocks Let's Encrypt TLS-ALPN | Flip CF record to DNS-only (grey); wait a few minutes for Traefik to retry |
| `https://wa.example.com/<label>/mcp` shows the PIN form (401 HTML) instead of the MCP endpoint | That number's container is down or unhealthy, so its routes are gone and the hub catches the path | `docker ps --filter name=whatsapp-mcp-<label>`; `docker logs whatsapp-mcp-<label>`; verify labels match Traefik entrypoints (`websecure`) and certresolver (`myresolver`) |
| The hub card reads "down" | The hub cannot reach `whatsapp-mcp-<label>:39002` | The container is stopped, or the label in `HUB_INSTANCES` is not the number's `INSTANCE` |
| The hub card reads "mismatch" | The container answering at that address reports a different label | Fix `HUB_INSTANCES` (or its `label=http://host:port` address) |
| The hub container keeps restarting | A required `HUB_*` value is missing or unusable, or `pin-attempts.json` is damaged | `docker logs whatsapp-mcp-hub` names the variable (never its value). For a damaged file: read it, then move it away from `/storage/whatsapp-mcp-hub` — that resets the wrong-PIN counters |
| The PIN form says to wait | Too many wrong PINs: 5 from one address locks it for 15 minutes, 20 from anywhere locks the form for 60 minutes (one ntfy push) | Wait. The lock survives a restart on purpose |
| `/<label>/media/t/<key>` returns 404 but the key exists | The key is under another prefix (a migrated number keeps `t/default/`), or it belongs to another number: each label reaches only its own store | `docker compose --env-file .env.<label> config \| grep TENANT_ID`; try the link under the label that produced it |
| `/<label>/media/t/<key>` returns 403 / `AccessDenied` | Bucket policy not applied | The app's `ensureBucketReady()` runs at boot and sets the policy; check `docker logs whatsapp-mcp-<label>` for `setBucketPolicy` errors |
| `/<label>/media/t/<key>` shows the PIN form (401) | That number's store container is down, so its media route is gone and the hub catches the path | `docker ps --filter name=whatsapp-mcp-<label>-minio`; `docker logs whatsapp-mcp-<label>-minio` |
| A number's store keeps restarting, or the number never starts ("dependency failed to start") | The store cannot write to its directory (created by Docker, owned by root), or it was stopped for using more memory than its ceiling | `chown -R 10001:10001 <data>/minio`; `docker inspect --format '{{.State.OOMKilled}}' whatsapp-mcp-<label>-minio`, and raise `STORE_MEM_LIMIT` if it reads `true` |
| HTTP 401 with the correct Bearer | `.env.<label>` drifted from clients, or the client is using another number's token | Rotate + resync that number's clients |
| ntfy push never arrives | Topic unsubscribed, `NTFY_TOPIC_URL` empty, or non-ASCII in title | Check the env file, subscribe topic in ntfy app, `grep ntfy /data/wa-logs.txt` |
| Unexpected auto-logout + purge + push | `EXPECTED_WA_NUMBER` mismatch — the QR code on that card was scanned by another phone, or the value is not in the form WhatsApp uses for that number (see [Add a number](#add-a-number)) | Verify the expected number, re-scan from the phone the card names |
| Sync seems stuck / no messages | `wa-logs.txt` usually shows what step it's on (`history sync complete` is the success line) | If stuck, restart that number's container. Creds preserved. |

## Backups (hourly snapshot + daily rotation)

`backup.sh` ships inside the image at `/app/whatsapp-mcp/scripts/backup.sh`. It uses `sqlite3 .backup` so the DB stays consistent even while the container writes (a plain `cp whatsapp.db` would capture a WAL-inconsistent file). Wire the host cron, **one line per number**:

```bash
ssh <vps>
crontab -e
# add, for every number:
0 * * * * docker exec whatsapp-mcp-<label> /app/whatsapp-mcp/scripts/backup.sh >> /var/log/whatsapp-mcp-backup.log 2>&1
```

A line that names a container which no longer exists fails silently every hour — after adding,
renaming or migrating a number, read the crontab again.

Output lands in that number's data directory on the host (`<data>` is
`/storage/whatsapp-mcp-<label>`, or the directory `INSTANCE_DATA_DIR` names):

```
<data>/backups/hourly/whatsapp.db           # overwritten each hour, 48h retention
<data>/backups/daily/whatsapp-YYYY-MM-DD.db # once per day, 14d retention
<data>/backups/daily/auth_info-YYYY-MM-DD.tar.gz
```

The hub has nothing worth backing up: `/storage/whatsapp-mcp-hub` holds only the wrong-PIN
counters.

## Restoring a DB — overwrite vs merge

Two different operations:

- **`restore.sh`** — replace the target DB with the source. Good for disaster recovery or restoring from a known-good backup.
- **`merge-db.sh`** — fold the source's chats/messages/contacts into the target, keeping everything that's already there. Good for importing long-lived history (e.g. a local bridge DB) into a VPS that's already running.

Both work on **one number** and require that number's container to be stopped (WAL lock). The whatsapp-mcp image already ships `sqlite3` + both scripts at `/app/whatsapp-mcp/scripts/`, so we don't need a separate alpine container. Below, `<data>` is that number's data directory.

### Overwrite with restore.sh

```bash
ssh <vps>
cd /opt/whatsapp-mcp/deploy
docker compose --env-file .env.<label> stop
docker run --rm \
  -v <data>:/data \
  -v /tmp:/src \
  -v /opt/whatsapp-mcp/scripts:/scripts \
  --entrypoint sh \
  ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /scripts/restore.sh /src/source.db
# (add /src/auth_info.tar.gz as a 2nd arg to also restore auth — only if
#  you really want to displace the currently-paired linked device)
docker compose --env-file .env.<label> start
```

### Merge (additive, preserves current data + imports missing rows)

```bash
# 1. on the source machine (e.g. laptop with a long-running local bridge)
sqlite3 /path/to/source/data/whatsapp.db ".backup /tmp/old-wa.db"
tar czf /tmp/old-wa-media.tar.gz -C /path/to/source/data media
scp /tmp/old-wa.db /tmp/old-wa-media.tar.gz <vps>:/tmp/

# 2. on the VPS
ssh <vps>
# extract media first (-k keeps existing files on name collision):
tar xzkf /tmp/old-wa-media.tar.gz -C <data>/data/
cd /opt/whatsapp-mcp/deploy
docker compose --env-file .env.<label> stop
docker run --rm \
  -v <data>:/data \
  -v /tmp:/src \
  -v /opt/whatsapp-mcp/scripts:/scripts \
  --entrypoint sh \
  ghcr.io/amiticia-autosys/whatsapp-mcp:latest \
  /scripts/merge-db.sh /src/old-wa.db
docker compose --env-file .env.<label> start
# cleanup:
rm -f /tmp/old-wa.db /tmp/old-wa-media.tar.gz
```

**Always restore DB only (not auth_info)** unless you really want to swap linked devices. Chats/messages reference contacts by JID (account-scoped), so an older DB is valid under the currently-paired device. **Never merge one number's database into another's**: they are different accounts.

## Rollback after a bad restore/merge

The hourly cron wrote `<data>/backups/hourly/whatsapp.db` just before you touched anything. Step back to it:

```bash
docker compose --env-file .env.<label> stop
cp <data>/backups/hourly/whatsapp.db <data>/data/whatsapp.db
rm -f <data>/data/whatsapp.db-wal <data>/data/whatsapp.db-shm
docker compose --env-file .env.<label> start
```

Daily snapshots under `<data>/backups/daily/` give you 14 days of granularity.

## Cron alternatives (prefer these to root crontab)

Today the hourly snapshot runs from root's crontab. Not ideal — dedicated ops tooling is better:

### systemd timer (recommended upgrade path)

Run as a dedicated `whatsapp-mcp` system user with minimal privileges. A template unit pair at `/etc/systemd/system/`, one instance per number:

```
# whatsapp-mcp-backup@.service
[Unit]
Description=whatsapp-mcp hourly DB snapshot (%i)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
# docker socket access requires group membership; adjust to your ops user
User=root
ExecStart=/usr/bin/docker exec whatsapp-mcp-%i /app/whatsapp-mcp/scripts/backup.sh

# whatsapp-mcp-backup@.timer
[Unit]
Description=Run whatsapp-mcp backup hourly (%i)

[Timer]
OnCalendar=hourly
Persistent=true
# lets it catch up if the host was offline at :00

[Install]
WantedBy=timers.target
```

Enable, per number: `systemctl daemon-reload && systemctl enable --now whatsapp-mcp-backup@<label>.timer`. Logs land in the journal (`journalctl -u whatsapp-mcp-backup@<label>`), freshness is visible via `systemctl list-timers`, and failures trigger the unit's `OnFailure=` handler if wired (e.g. ntfy).

### docker-compose cron sidecar (ofelia)

If you want everything self-contained in the stack, add an `ofelia` sidecar that reads labels from each number's container. No host privilege escalation. Tradeoff: one extra container running 24/7 just to fire one job per number.

### Keep root cron (current state)

Works. Root's socket access is already required to `docker exec`, so the blast radius is the same as running compose commands. Downside is visibility — failures go to `/var/log/whatsapp-mcp-backup.log` on disk and don't page anyone. If the container is down when cron fires, the docker exec just errors silently.

## Offsite backups (manual)

Each number's backup directory is at `<data>/backups/` on the host. Point an offsite backup tool at them — Borg shown here. **No cron is wired for it in this stack today** — run it from wherever holds the backup repo (laptop, second disk, remote). Something like:

```bash
# example only — adapt to your Borg repo layout; repeat the two paths for every number
borg create \
  --compression lz4 \
  /path/to/borg-repo::whatsapp-mcp-{now} \
  /storage/whatsapp-mcp-<label>/backups /storage/whatsapp-mcp-<label>/auth_info
```

## Related

- Image source: `github.com/eusoubrasileiro/whatsapp-mcp` (branch `main`)
- Shared client lib: `github.com/eusoubrasileiro/baileys-client` (branch `main`)
- User docs: [`README.md`](../README.md) and [`docs/`](../docs/)
