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

## OAuth Setup

Do not put a Gmail password in eGPT. Gmail access is OAuth-only. The selected
Google account is bound to the refresh token; the bridge calls Gmail as
`users/me`.

The helper script opens Google consent in a browser, catches the localhost
callback, exchanges the authorization code, verifies the Gmail profile, backs up
the old local config, and writes the `gmail` block to
`~/.egpt/config.local.json`:

```powershell
npm run setup:gmail
```

Non-interactive form:

```powershell
npm run setup:gmail -- --client-id "..." --client-secret "..."
```

Useful flags:

```text
--login-hint you@example.com   preselect an account in Google consent
--compose                      request draft permissions and set create_drafts=true
--no-compose                   readonly triage only
--notify-all                   notify every matching message for smoke testing
--no-browser                   print the consent URL instead of opening it
```

Where to get the client ID and secret:

1. Open Google Cloud Console: https://console.cloud.google.com/
2. Create or select a project.
3. Go to APIs & Services -> Library, search for "Gmail API", and enable it.
4. Go to APIs & Services -> OAuth consent screen. For a personal test app,
   External + Testing is fine, but add your Gmail account as a test user.
5. Go to APIs & Services -> Credentials -> Create credentials -> OAuth client ID.
6. Choose "Desktop app". Copy the Client ID and Client secret.
7. Run `npm run setup:gmail`, paste those values, and approve the browser
   consent screen.

Notes:

- If the OAuth consent screen is External + Testing, Google refresh tokens for
  Gmail scopes expire after seven days. For longer-lived personal use, move the
  OAuth app to production when ready.
- If you first authorize readonly and later enable `--compose`, run the setup
  again so the refresh token contains the compose scope.
- The script never sends mail. `--compose` only lets eGPT create Gmail drafts.

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
