# Send guards

`sendMessage()` resolving means "written to the socket", not "accepted". WhatsApp refuses
sends **asynchronously** — measured at ~40 ms after the send (2026-07-22: 19:13:40.525
stored → 19:13:40.565 rejected). For a long time that refusal was logged and nothing more,
so `send_message` returned *"Message sent successfully"* for messages that never existed to
the recipient. An agent had no way to learn its send died, and concluded the MCP was broken.

Two guards now sit on both sending tools:

1. **Pre-send** (`src/recipient.ts`) — `onWhatsApp()` verifies the recipient. Not on
   WhatsApp → throws *before* sending, so no reach-out is spent. Groups / LIDs / newsletters
   skip the lookup. A lookup that itself fails logs a warning and falls through to the JID
   as given — a flaky lookup must never block a legitimate send.
   > **PN→LID upgrade is opportunistic.** When `onWhatsApp()` includes a `lid`, the send is
   > addressed to it. In practice it often doesn't — verified live 2026-07-22 against an
   > owned test contact, where the lookup returned `exists: true` with no `lid` and the send
   > went out PN-addressed and delivered fine. So treat the upgrade as a bonus, not a
   > guarantee. `makeLidResolver`/`getLIDForPN` (`baileys-client/src/lid.ts`) is the
   > unwired second seam if this ever needs to be reliable.
2. **Post-send** (`src/ack-bus.ts` + `src/send-guard.ts`) — the tool waits up to
   `SEND_ACK_WAIT_MS` for a rejection ack and **throws** if one arrives, with the code and
   an explicit `DO NOT RETRY`. The retry ban is load-bearing: throwing invites agents to try
   again, and each 463 retry is another reach-out.

**Both guards are needed — they catch different failures.** Verified live 2026-07-22 with two
mistyped variants of an owned test number: one is not on WhatsApp and was stopped by guard 1;
the other **is** a real number, passed guard 1, and was caught by guard 2's 463. With only the
pre-send check, that second send would have reported success again.

That second case is also why the 463 text names **two** causes: a wrong number, *and* a
genuine first contact with a real number that has no trusted-contact token yet. The latter
is not a bug to fix — WhatsApp gates first contact, and it can't be forced from this server.

> **Why `ack-bus.ts` keeps a ring buffer.** The message id only exists *after*
> `sendMessage()` resolves, so a waiter registers into a race it may already have lost.
> Every rejection is buffered first and `waitForAckError` checks the buffer *before*
> registering — same lost-wakeup shape as `gapCheck` in `monitoring.ts`. Listener-only
> delivery would work roughly half the time.

Both guards are env-switchable (`SEND_ACK_WAIT_MS=0`, `SEND_PRESEND_CHECK=false`) to
restore the old fire-and-forget behavior without a redeploy.

## Anti-ban guard chain

A third guard layer sits above those two: `applySendPolicy` (`src/send-policy.ts`) —
blocklist → cold-contact → pacing → typing, in that order, on both sending tools. It exists
because a linked number was restricted twice by agent-driven cold sends.

**Before touching any send path, read [`account-restrictions.md`](./account-restrictions.md)**
— why the guards exist, the guard chain, its env vars, and the per-instance policy
(`SEND_COLD_OVERRIDE=deny` on a number you cannot afford to lose; first-contact outreach
belongs on a separate instance). Those thresholds are risk-owner settings, not engineering
defaults.

## Error codes

| Symptom | Fix |
|---------|-----|
| `send_message` reports success but the message never arrives | **Should no longer happen** — the guards above make a refused send throw. If you see it: check `SEND_ACK_WAIT_MS` isn't `0`, then look for `send rejected by server` in `wa-logs.txt` (`src/ack-errors.ts`). A refusal landing *later* than the wait window would still slip through — raise `SEND_ACK_WAIT_MS` and file it, since the observed latency is ~40 ms. Code `463` = wrong JID or no trusted-contact token, `479` = stale device session. **Never re-send on a 463.** |
| `error 463` for one specific contact only | Expected, not an account ban — despite the server's "Your account has been restricted" detail text, which is misleading. WhatsApp gates 1:1 sends behind a tc token. **Two causes, in this order:** (1) **wrong recipient JID** — a number that isn't on WhatsApp can never mint a token, so it 463s forever while every real chat keeps working; **never hand-build a phone JID**, look it up (`search_contacts`, or `SELECT jid,name,phone_number FROM contacts`) and send to the `@lid`. (2) **genuine first contact** — a real number you've never exchanged messages with has no token yet; this is not fixable from here, the contact must message first or the chat be established from the phone. Confirm scope with `grep 'send rejected by server' /data/wa-logs.txt`: if every `chat_jid` is the same, it's that recipient, not you. An actual account restriction hits every chat, including your own self-chat. |
| `error 463` against a Brazilian mobile you typed by hand | Almost always the **extra-9 trap**. BR mobiles are normally `55 DD 9XXXX-XXXX` (13 digits), so agents "helpfully" insert a 9 into a 12-digit number — producing a *different* number. That number may not be on WhatsApp at all (refused before sending) or may belong to someone who has never talked to you (463), while the same account keeps delivering to the correct JID. Do not normalize BR numbers; resolve them from the contacts table. |
