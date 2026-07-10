# Wire `@l` — local llama sibling on the DOLLY worker

`@l` is a local-LLM sibling served by a `llama-server` on the DOLLY box
(`192.168.1.102`, the same machine as the transcriptor worker). Topology mirrors
the transcriptor: **DOLLY runs the server, the main spine only dials it.**

## DOLLY side (the GPU/worker box)
DOLLY's egpt daemon spawns + supervises `llama-server` itself via a `local_llm`
block in **DOLLY's** `config.yaml` (one supervisor, crash-respawn — same pattern
as the whisper worker; no separate NSSM service):

```yaml
local_llm:
  enabled: true
  bin: C:\Users\an\bin\llama.cpp\llama-server.exe
  model_path: C:\Users\an\models\<model>.gguf   # final model TBD by measured CPU speed
  port: 8080
  extra_args: ["--host", "0.0.0.0", "-ngl", "0", "--jinja"]
```

- `--host 0.0.0.0` → reachable from the spine (default is loopback-only).
- `-ngl 0` → **CPU** (deliberate; GPU is not used for `@l`). So speed is bounded
  by CPU + model size — measure tokens/sec and prefer a small instruct model
  (~1–3B) so `@l` is responsive rather than correct-but-painful.
- `--jinja` → tool-call template (future-proof; harmless for chat-only).

Then **firewall to the LAN only** (like the transcriptor's 23390) and restart
DOLLY's `egpt-daemon` (needs elevation):

```powershell
New-NetFirewallRule -DisplayName "llama-server LAN" -Direction Inbound `
  -Protocol TCP -LocalPort 8080 -Profile Private -Action Allow
# restart DOLLY's daemon (elevated):
sc.exe stop egpt-daemon; sc.exe start egpt-daemon
```

Verify from the spine: `curl http://192.168.1.102:8080/v1/models` → lists the model.

> **Auth:** raw `llama-server` is unauthenticated. LAN + Private-profile firewall
> is acceptable for a trusted home network; never internet-facing. If the HMAC
> posture of the transcriptor is wanted, front it with a signed egpt proxy (a
> `transcriptor.mjs` twin) — a follow-up, not needed to get `@l` working.

## Spine side (main egpt — Wren wires this)
Add to `siblings` in the spine config. **No `kind`** (beings carry none), **no
`model`** (server serves what it loaded), and **do NOT** set `local_llm` on the
spine (that would make the spine spawn its own server — it must only consume
DOLLY's):

```yaml
siblings:
  l:
    type: llama
    url: http://192.168.1.102:8080
    body_emoji: 🦙
```

## Flip checklist (when the DOLLY engineer reports back)
They report: the **port** and the **model id** from `/v1/models`. Then:
1. `curl http://192.168.1.102:<port>/v1/models` from the spine — confirm reachable.
2. Add the `siblings.l` block above (adjust `url` port if not 8080).
3. Restart the spine daemon.
4. Test: `@l hi` — and time it against `@me`/`@jay` for the comparison.
