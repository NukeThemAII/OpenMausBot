# HighLevel CRM (native integration)

One card, **HighLevel**, in Connected apps, on desktop and on a Cloud home alike. It also covers Growably and every
other HighLevel-based white-label CRM: the sign-in uses HighLevel's white-label page, so those users never see the
HighLevel brand. Composio is not involved; the server (`server/highlevel/*`) talks to
`https://services.leadconnectorhq.com` itself.

## How it works

```
OMB server (desktop or Cloud home)         accounts.openmausbot.com (relay)              HighLevel
  POST /api/highlevel/sign-in ───────────▶ POST /v1/highlevel/start → state + auth URL
  app opens the auth URL in the browser ─────────────────────────────────────────────▶ sign in, pick a location
                                            ◀── GET /v1/highlevel/callback?code&state ── redirect
                                            exchanges the code (client secret lives there only)
  polls POST /v1/highlevel/claim every 2 s ◀── tokens, once (404 before, 410 after)
  stores the tokens, encrypted, in DATA_DIR
  calls services.leadconnectorhq.com with the access token (Version: 2021-07-28; conversations 2021-04-15)
  on 401 or near expiry: POST /v1/highlevel/refresh {refreshToken} → new pair, stored (the refresh token rotates)
```

- **Connect** starts a flow and returns `{flowId, authorizationUrl, expiresAt}`; the app opens the link and polls the
  flow. The server polls the relay for up to 10 minutes; the flow lives in memory only.
- **Private Integration token** (for agencies that hide the Marketplace): `POST /api/highlevel/token {token, locationId}`.
  The token is checked with `GET /locations/{locationId}` before it is saved. It never refreshes; a 401 signs it out.
- **Storage:** `DATA_DIR/highlevel.json.enc`, AES-256-GCM under `DATA_DIR/highlevel-key` (0600), the same scheme as
  saved logins. No keychain in the path, so a Cloud home works the same way. Stored: kind (`oauth` | `token`), access
  token, refresh token, expiry, locationId, companyId, userId, location name, scopes, state (`signed-in` |
  `needs-sign-in`) and the plain-sentence problem when a new sign-in is needed. No route ever returns a token.
- **Reconnect:** when the relay rejects a refresh (`401 highlevel_refresh_rejected`: revoked, app uninstalled) the
  store is marked `needs-sign-in`, the card shows "Signed out. Reconnect to keep using it.", and every tool call
  answers the plain signed-out note until the person reconnects.
- **Disconnect** (`DELETE /api/highlevel`) removes the tokens. HighLevel's own uninstall is a link in the UI.

## Owner routes (`server/routes/highlevel.ts`, admin or owner session only)

| Route | Answer |
|---|---|
| `GET /api/highlevel` | `{ state: unavailable \| signed-out \| connecting \| connected \| needs-sign-in, kind?, location?: {id, name}, connectedAt?, flow?: {flowId, authorizationUrl, expiresAt}, problem? }` |
| `POST /api/highlevel/sign-in` | `{ flowId, authorizationUrl, expiresAt }` |
| `GET /api/highlevel/sign-in/:flowId` | `{ phase: waiting \| connected \| failed \| expired, message? }`; 404 `{error}` for an unknown flow |
| `DELETE /api/highlevel/sign-in/:flowId` | cancels |
| `POST /api/highlevel/token` | body `{ token, locationId }` → the status; errors are `{ error: "<one plain sentence>" }` |
| `DELETE /api/highlevel` | disconnects → the status |

`GET /api/connectors/tools` also carries a `highlevel` entry with the twenty tool names, so the per-bot tool grants
picker can list them. Cloud health merges `{ highlevel: { connected } }` into its connectors report.

## Environment

| Variable | Meaning |
|---|---|
| `OMB_HIGHLEVEL_RELAY_URL` | The relay. Default `https://accounts.openmausbot.com`. `off` disables the integration (`state: "unavailable"`); a Private Integration token still works. Loopback `http://` is accepted for tests. |
| `OMB_HIGHLEVEL_API_URL` | Tests only: a fake HighLevel in place of `https://services.leadconnectorhq.com`. |

## Tools (bots)

Mounted as the MCP server `highlevel` through the harness proxy (`/api/internal/highlevel/mcp`, token env
`OMB_MCP_TOKEN_HIGHLEVEL`), so drivers see `mcp__highlevel__HIGHLEVEL_GET_CONTACT` and the like. Every call carries the
turn's capability; the server re-reads the live bot on every call for the verdict.

| Tool | Does | Read/write |
|---|---|---|
| `HIGHLEVEL_SEARCH_CONTACTS` | free text + exact tag/email/phone filters, page | read |
| `HIGHLEVEL_GET_CONTACT` | one contact, custom fields by name | read |
| `HIGHLEVEL_CREATE_CONTACT` / `HIGHLEVEL_UPDATE_CONTACT` | name, email, phone, company, tags, source, address, custom fields by name | write |
| `HIGHLEVEL_ADD_TAGS` / `HIGHLEVEL_REMOVE_TAGS` | tags on a contact | write |
| `HIGHLEVEL_LIST_NOTES` / `HIGHLEVEL_ADD_NOTE` | notes on a contact | read / write |
| `HIGHLEVEL_LIST_TASKS` / `HIGHLEVEL_ADD_TASK` | tasks on a contact (title, due date, description, assignee) | read / write |
| `HIGHLEVEL_LIST_PIPELINES` | pipelines with stages | read |
| `HIGHLEVEL_SEARCH_OPPORTUNITIES` / `HIGHLEVEL_GET_OPPORTUNITY` | by pipeline, stage, contact, status, text; one by id | read |
| `HIGHLEVEL_CREATE_OPPORTUNITY` / `HIGHLEVEL_UPDATE_OPPORTUNITY` | pipeline, stage, contact, name, value, status (open/won/lost/abandoned) | write |
| `HIGHLEVEL_SEARCH_CONVERSATIONS` / `HIGHLEVEL_READ_CONVERSATION` | conversation summaries; the messages of one | read |
| `HIGHLEVEL_LIST_CALENDARS` / `HIGHLEVEL_LIST_EVENTS` | calendars; events in a date range | read |
| `HIGHLEVEL_GET_LOCATION` | name, timezone, contact details, custom field definitions | read |

Outputs are trimmed objects (ids, names, email, phone, tags, dates, custom fields by name), never raw API dumps.
Errors are one plain sentence: "HighLevel refused this (403): the connection lacks the contacts.write permission.",
"HighLevel has no contact with that id (404).", "HighLevel is rate-limiting; try again in a few seconds."

**Never:** no tool sends SMS, email or WhatsApp, starts a campaign or workflow, books or changes appointments, deletes a
record (except removing tags) or touches payments. The guard is in the client (`assertAllowedPath` and
`FORBIDDEN_PATHS` in `server/highlevel/client.ts`), so no later tool can grow a path to those endpoints; a test asserts
the client has no such method. The system prompt tells the bot the same.

## Per-bot scope

The same rules as other connected apps, with slug `highlevel`:

- `bot.composio === false` → no HighLevel tools.
- `connectorScopes.apps.highlevel`: `read` allows SEARCH/GET/LIST/READ only; `write` allows everything; a scopes record
  without `highlevel` mounts nothing.
- `connectorTools.highlevel.tools`: `"*"` or a list of tool names. Bot settings show four groups (`shared/highlevel.ts`
  `HIGHLEVEL_TOOL_GROUPS`): *Contacts and notes* (default for a new bot), *Pipelines and deals*, *Conversations (read)*,
  *Calendars (read)*; a group is the grant naming its tools. `HIGHLEVEL_GET_LOCATION` is in every group.
- `tools/list` shows only what the bot may run; a refused call answers the connector scope text ("HighLevel is
  read-only for <bot>, and Add note would write to it…") and writes a decision row (`source: connector-scope`).
- CRM record changes are not messages: no outbound card, no daily allowance; the write scope is the control.

## Writes in the activity

Every successful write appends an activity row to the thread: `tool.name` `mcp__highlevel__HIGHLEVEL_<ACTION>`, and
`tool.summary` with the record id and the field names changed (`contact abc123: email, tags`), never the values.

## Limits

- HighLevel: 100 requests / 10 s and 200,000 / day per app per location. The client keeps under **90 / 10 s** per
  location, waits per `Retry-After` / `X-RateLimit-Interval-Milliseconds` (at most 10 s) and retries once on 429,
  retries once on 5xx, refreshes once on 401 (and ahead of expiry) and retries the call.
- Access tokens last a day; refresh tokens a year and rotate on every use. The rotated pair is stored before the retry.
- Results: at most 50 per page; text fields are cut at 4,000 characters; responses over 4 MB are refused.
- Custom field definitions are cached for 10 minutes per location.

## Not in v1

Sending messages (SMS, email, WhatsApp), campaigns, workflows, payments, booking or changing appointments, deleting
records, webhooks from HighLevel (contact changed → bot), agency-level (Company) tokens, bulk installs, several
locations at once (one connection per installation).

## Tests

- `server/highlevel/client.test.ts`: request shapes, trimming, Version header, refresh-once with rotation persisted,
  429 backoff, 5xx retry, the budget, plain errors, the store's encryption and the no-messaging guard.
- `server/highlevel/rpc.test.ts`: per-bot scoping (read-only refusal text, grants, tools/list filtering), the write
  record and the host's activity row.
- `server/highlevel/sign-in.test.ts`: the relay contract, the sign-in flow, the token path and the owner routes.
- `server/highlevel.e2e.test.ts`: a real server, fake relay and fake HighLevel, Connect → tools → refresh →
  revocation → Disconnect → Private Integration token.
