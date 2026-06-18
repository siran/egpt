# Gmail Limb

Status: first MVP on branch `gmail-limb`.

## Shape

Gmail is a transport limb, not a UI limb.

```text
Gmail API poller
  -> parsed message object
  -> deterministic importance rules
  -> quoted triage prompt to e
  -> optional Gmail draft
  -> WhatsApp/operator notification
```

The Gmail thread itself is the conversation unit:

```text
surface:  gmail
threadId: <gmail thread id>
path:     ~/.egpt/conversations/gmail/<slug>/transcript.md
```

It does not join the multi-member Room fanout model. A Gmail thread is already
the room-like boundary for email.

## Safety

- Raw email never enters `submit()`.
- Raw email never executes slash commands.
- The host builds a quoted prompt for e and marks the email body as untrusted
  content.
- The bridge can create Gmail drafts, but it never sends email.
- Draft creation is opt-in with `gmail.create_drafts: true`.

## Config

OAuth secrets should live in `config.local.json`, not shared config.

```json
{
  "gmail": {
    "enabled": true,
    "client_id": "...apps.googleusercontent.com",
    "client_secret": "...",
    "refresh_token": "...",
    "query": "in:inbox newer_than:7d",
    "poll_seconds": 60,
    "max_results": 10,
    "notify_chat_id": "optional-whatsapp-chat-id",
    "important_from": ["boss@example.com", "@important-domain.com"],
    "important_subject": ["urgent", "invoice", "contract"],
    "important_terms": ["deadline", "signature"],
    "ignore_from": ["newsletter@example.com"],
    "ignore_subject": ["unsubscribe"],
    "propose_response": true,
    "create_drafts": false
  }
}
```

Useful commands:

```text
/gmail
/gmail poll
```

## API Notes

This first cut uses polling/list sync rather than Gmail push notifications.
Google's Gmail sync guide describes full/partial sync and notes polling is still
recommended for installed or user-owned clients. Gmail push requires Cloud
Pub/Sub setup and watch renewal at least every seven days, so it is a later
operational step rather than the MVP.

Scopes:

```text
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.compose
```

`gmail.compose` is enough for draft creation and potential send rights; eGPT
uses it only for drafts in this MVP.
