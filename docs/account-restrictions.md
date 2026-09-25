# Anti-ban guards — policy reference

WhatsApp restricts accounts that make scripted first-contact sends. A number linked to this
MCP was **restricted twice in one week** by agent-driven cold sends. Two restrictions in a
week is the documented step before a permanent ban; a third strike likely loses the number
and its archive. These settings are **risk-owner decisions, not engineering defaults** —
don't loosen one to make a send go through.

| Step | What happened |
|---|---|
| 1 | Send to a hand-typed number not on WhatsApp → `401 conflict/device_removed` **3 s later**, auth destroyed, ~5-day restriction |
| 2 | A `463` hit **an established contact** → proof the block was account-level, not per-recipient |
| 3 | Cold send to a recipient already refused twice, from a fresh session → socket died, ~5-hour restriction |
| 4 | Same recipient attempted twice more; survived only because the socket was already dead |
| 5 | First restart → `Reason: loggedOut`, `auth_info` purged. Device removed server-side, so **auth backups are useless — re-scan is the only path**. `whatsapp.db` untouched. |

Not volume (the account sent at its usual daily rate, to *fewer* distinct recipients than
the month before, with a high reply rate). Not Baileys. **Behavior**: scripted first-contact
sends from test agents. Every `463` of the account's lifetime fell inside that one week.

**The mechanism:** the old guard threw `DO NOT RETRY` *within a session*. Nothing remembered a
refusal *across* sessions, so a fresh session days later re-attempted the same dead recipient.
`send-blocklist.ts` closes that.

> Never re-pair or re-scan **during** an active restriction countdown — re-linking under
> enforcement worsens the account's standing. Wait for the phone's banner to clear, restart once.

## Guard chain

`applySendPolicy` (`src/send-policy.ts`), on both sending tools, after `resolveTarget()` so
guards see the canonical post-LID JID. **Order is load-bearing:**

```
assertNotBlocked   →  assertNotColdContact  →  applySendPacing  →  simulateTyping
durable 463 memory    no inbound history       interval + caps     presence
```

- **`send-blocklist.ts`** — persists cold `463` refusals; later sends to that alias group are
  refused with the original date. Clearing an entry is a manual SQL delete, deliberately.
  Fails **open** on an unreadable DB. The cold-check on *persist* is what keeps a collateral
  463 on an established contact (step 2 above) out of the table — that's the regression test.
- **`cold-contact.ts`** — refuses recipients with zero inbound history, keyed on the alias
  group so a PN/LID mismatch can't bypass it. Fails **safe**: unknown history reads as cold.
- **`send-pacer.ts`** — per-minute ceiling *waits*, per-hour ceiling *throws*.
- **`send-typing.ts`** — typing indicator scaled to message length before a text send.

Underneath sit the two older guards (pre-send `onWhatsApp()` in `recipient.ts`, post-send
rejection wait in `ack-bus.ts`/`send-guard.ts`) — see CLAUDE.md "Send guards".

`allow_cold_contact: true` is **not** an agent's escape hatch: `SEND_COLD_OVERRIDE=deny` makes
it inert and the refusal says so.

## Env vars

A malformed value reads as the **documented default, never as "guard disabled"**
(`src/env-config.ts`). `SEND_RATE_LIMIT_PER_HOUR=banana` means 120, not unlimited.

| Variable | Default | Effect |
|---|---|---|
| `SEND_BLOCKLIST_ENABLED` | `true` | `false` re-opens the cross-session retry hole that caused strike 2 |
| `SEND_COLD_CONTACT_GUARD` | `true` | `false` disables first-contact refusal |
| `SEND_COLD_OVERRIDE` | `allow` | `deny` makes the `allow_cold_contact` param inert |
| `SEND_COLD_ALLOWED_JIDS` | _(empty)_ | Owned test numbers exempt from the cold guard |
| `SEND_RATE_LIMIT_ENABLED` | `true` | `false` removes all pacing |
| `SEND_RATE_LIMIT_MIN_INTERVAL_MS` | `3000` | Minimum gap between sends, account-wide |
| `SEND_RATE_LIMIT_JITTER_MS` | `2000` | Random extra delay so timing isn't machine-regular |
| `SEND_RATE_LIMIT_PER_MINUTE` | `10` | Exceeding **waits** |
| `SEND_RATE_LIMIT_PER_HOUR` | `120` | Exceeding **throws** |
| `SEND_SIMULATE_TYPING` | `true` | Typing indicator before a text send |
| `SEND_TYPING_MAX_MS` | `5000` | Cap on simulated typing time |
| `HEALTH_DISCONNECTED_GRACE_S` | `300` | Socket downtime before `/health` returns 503 |

Pacer values are conservative starting points, not measured thresholds — WhatsApp publishes no
limit for a linked device.

## Per-instance policy

Run one instance per number, and give each number one job:

| | high-value number | outreach number |
|---|---|---|
| Number | irreplaceable — years of history, real relationships | disposable prepaid chip |
| Serves | archive search, chat with **established** contacts, self-chat, validation *reads* | strangers, validation *sending* |
| `SEND_COLD_OVERRIDE` | **`deny`** | `allow` |
| `SEND_COLD_ALLOWED_JIDS` | only numbers you own | owned test numbers |
| If banned | catastrophic | buy another chip |

In the production compose these come from `deploy/.env`; `SEND_COLD_OVERRIDE` defaults to
`deny` there, so an instance only accepts cold contact when its operator opts in.

Don't let the outreach instance's convenience creep customer traffic onto it — every real
relationship stays on the high-value number.

## Rules for agents

1. **No first-contact sends from a high-value number.** Persona/outreach/validation sending →
   the outreach instance.
2. **Validation targets only numbers we own.** A real store or clinic is not a test fixture.
   For our own products, a signed webhook POST to the product's endpoint exercises intake with
   **zero** WhatsApp reach-out — prefer it.
3. **Never hand-build or normalize a JID.** Resolve via `search_contacts`. Do not insert a 9
   into a 12-digit BR mobile — that fabricates a different number and caused strike 1.
4. **Never re-send after a `463`** — not this session, not tomorrow, not from another project.
5. Reads are always safe. The risk is entirely on the send path.

## Standing checks

```bash
# 463s on a high-value instance should never grow — a new one is an incident
ssh <vps> 'docker exec whatsapp-mcp grep -c "send rejected by server" /data/wa-logs.txt'

# after any deploy: code shipping ≠ policy applying
ssh <vps> 'docker exec whatsapp-mcp printenv | grep -E "^SEND_|^EXPECTED_WA_NUMBER"'
```

`EXPECTED_WA_NUMBER` must be set on every instance **before first boot** — the QR page is
public, so until it's set the instance is pair-by-anyone.
