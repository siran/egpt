# Configuring Independent Principal Nodes

Each principal node runs its **own Beeper account** and monitors its **own WhatsApp independently**.

**Previous setup**: One shared Beeper account → only one node could monitor
**New setup**: Separate Beeper accounts → each node monitors independently

---

## The 3 Essential Config Items

For a node to function as an independent principal, configure these 3 items:

1. **`beeper_token`** — API token for this node's Beeper account (in `config.local.json`)
2. **`whatsapp.chat_id`** — This node's self-DM room id (auto-captured or in `config.yaml`)
3. **`whatsapp.allowed_users`** — Users allowed to command this node (in `config.yaml`)

**Auto-configuration**: The first message in Self (or `/wa-pending` review) auto-configures `chat_id` and `allowed_users`—just capture them from the Beeper log.

---

## Config Files

egpt reads:

1. **`~/.egpt/config.yaml`** — structure, siblings, services (version-controlled)
2. **`~/.egpt/config.local.json`** — secrets + overrides (gitignored)

Config.local.json shallow-merges into config.yaml.

---

## Principal Node 1 (REVE / kg)

**`config.yaml` — shared structure:**
```yaml
user_name: An

whatsapp:
  enabled: true
  transport: beeper
  # Self-DM: the node's own chat in Beeper (see "Finding your chat_id" below)
  chat_id: "!yz3kJjWXsQJofK9naaVb:beeper.local"
  # Users allowed to issue commands/mentions
  allowed_users:
    - "16468217865"           # Phone number
    - "34836563681438"        # Contact
    - "@anrodriguez:beeper.com"  # Beeper account (YOUR account)
  auto_e_chats: []  # Empty—doesn't auto-dispatch to chats
  
default_brain:
  type: ccode
  session_id: 39d558bc-...

siblings:
  e: { ... }       # Public persona
  l:               # Local llama
    url: http://192.168.1.102:8080  # Points to DOLLY's server
  wren: { ... }    # Engineer
  # ... other beings ...

mesh:
  nodes:
    do:            # Reference remote DOLLY node
      beings: [don]
      routes:
        - limb: beeper
          room_id: "!t6et3mN89hsPKfVmjMBG:beeper.local"
```

**`config.local.json` — local secrets (gitignored):**
```json
{
  "beeper_token": "syt_<principal-account-token>",
  "transcription_endpoint": "http://192.168.1.102:23390",
  "transcription_token": "<shared-secret>"
}
```

---

## Principal Node 2 (DOLLY / do)

**`config.yaml` — DOLLY's own structure (also a principal, not subordinate):**
```yaml
# Services this node runs (not the principal)
transcriptor:
  enabled: true
  bind: 0.0.0.0
  port: 23390

local_llm:
  enabled: true
  bin: C:\path\to\llama-server.exe
  model_path: C:\path\to\model.gguf
  port: 8080
  extra_args:
    - --host
    - 0.0.0.0

# Agent endpoint (if this node runs resident beings)
agent:
  enabled: true
  session_id: 23dfef93-...
  port: 23391
  name: don

whatsapp:
  enabled: true
  transport: beeper
  # SEPARATE Beeper account: DOLLY's own self-DM
  chat_id: "!room9:beeper.local"
  mirror_chat_id: "!room9:beeper.local"
  # Auto-dispatch to DOLLY's own chats (optional; depends on workload)
  auto_e_chats:
    - "!room9:beeper.local"
  # Users allowed to command DOLLY
  allowed_users:
    - "16468217865"           # Can issue commands to DOLLY too
    - "34836563681438"
    - "@dolly-egpt:beeper.com"  # DOLLY's SEPARATE Beeper account ← KEY
  media:
    audio_transcribe:
      enabled: true
      server:  # Resident whisper-server (fast transcription)
        enabled: true

telegram:
  enabled: true
  chat_id: -5136707031  # DOLLY's Telegram group (optional)
  agent: don

# MINIMAL siblings—only beings that live on this node
siblings:
  don:
    type: ccode
    resident: true  # Stay warm, always alive
    session_id: 23dfef93-...
    model: haiku

# Reference the principal node for mesh coordination
mesh:
  nodes:
    kg:  # REVE's identifier
      beings: [e, wren]
      routes:
        - limb: telegram
          room_id: "-5136707031"
```

**`config.local.json` — This node's secrets (gitignored):**
```json
{
  "beeper_token": "syt_<this-node-beeper-account-token>"
}
```

---

## Setup Steps

### 1. Create a Beeper Account
- In Beeper Desktop, create a **new account** with a **separate phone number**
- Sign in on this machine with that account
- Generate a Desktop API token: Settings → Developer → Desktop API
- Save to `~/.egpt/config.local.json`:
  ```json
  {
    "beeper_token": "syt_..."
  }
  ```

### 2. Auto-capture chat_id and allowed_users
- Start egpt with minimal config:
  ```yaml
  whatsapp:
    enabled: true
    transport: beeper
  ```
- Send a test message from this node's Beeper account to itself (Self-DM)
- egpt auto-captures:
  - `whatsapp.chat_id` from the self-DM room id
  - `whatsapp.allowed_users` from the sender's stable id
- Verify in `~/.egpt/logs/beeper.log` and copy into `config.yaml` if needed

### 3. (Optional) Define Local Beings
- Add siblings that run on this node (with session_id, cwd, etc.)
- Don't duplicate beings from other nodes

### 4. (Optional) Wire Services
- If this node provides shared services (transcription, llama), enable:
  ```yaml
  transcriptor:
    enabled: true
    port: 23390
  local_llm:
    enabled: true
    port: 8080
  ```
- Ensure ports don't conflict across machines

---

## Critical: Separate Accounts

If two nodes share the **same** Beeper account:
- Only ONE node's Beeper bridge stays alive (Beeper drops the duplicate)
- The other hangs or errors

**Solution**: Each principal node **must** have its own Beeper account (separate phone number)

---

## Secrets & Security

- **Never commit `config.local.json`** — add to `.gitignore`
- **Beeper tokens are high-value** — a token grants full account access
- **Shared transcription_token** — keep it out of version control; only on both machines
- **allowed_users** — use stable ids (phone numbers, Beeper handles), never display names

---

## Troubleshooting

**"Only one node's WhatsApp is responding"**
- You likely share the same Beeper account on both nodes
- Beeper drops the second connection (only one active per account)
- **Fix**: Each node must have its own Beeper account with separate phone number

**"Beeper bridge won't connect / says NO TOKEN"**
- Check `beeper_token` in `config.local.json` exists and is valid
- Verify it's the token for the account THIS node is signed into
- Look for error details in `~/.egpt/logs/beeper.log`

**"Wrong chat captured as chat_id"**
- The first message egpt sees becomes the captured self-DM
- Delete `whatsapp.chat_id` from config and send a message from Self again
- Or manually set it in config.yaml from the Beeper log
