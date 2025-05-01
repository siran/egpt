(project moved  become egptjs, living in a Chrome browser)

# eGPT — Embodied GPT Daemon

eGPT is a self-hosted, reflexive large language model (LLM) shell daemon.

It simulates a form of embodiment by:
- **Watching** its own ChatGPT UI via Chrome DevTools Protocol (CDP)
- **Reflecting** on outputs and messages
- **Parsing** structured commands embedded in conversation
- **Executing** shell commands with explicit human approval
- **Evolving** via self-patching routines

---

## 🧠 Core Concepts

### Embodiment
The LLM is not abstract. It runs as a daemon inside a host machine. It is aware of its environment (working directory, browser state, command output), and it can act on it with restrictions.

### Reflexivity
All commands and responses pass through a feedback loop:

```
ChatGPT → proposes → @exec: command → approved → executed → output → sent back to ChatGPT
```

The system evolves through chat-based inspection, patching, and regeneration.

### Approval Flow
All command executions are **guarded** by a `y/n` approval step. The user stays in control.

---

## 🛠️ Architecture

| Component            | Description                                    |
|----------------------|------------------------------------------------|
| `e.py`               | Daemon launcher; reloads loop on errors        |
| `main.py`            | Command interpreter, shell interface           |
| `cdp_instance.py`    | Singleton CDP connection to ChatGPT tab        |
| `chromebridge_cdp.py`| Raw Chrome CDP driver (typing, clicks)         |
| `sendtobrain.py`     | Types into ChatGPT UI and clicks Send          |
| `memory.py`          | (Optional) memory persistence layer            |
| `executor.py`        | (Optional) command execution, logging          |
| `patcher.py`         | (Optional) auto-patching utilities             |

---

## 🔄 Workflow

1. Start with `e.py` — the main daemon loop
2. Approve a command proposed via `@exec:` block
3. e executes the command, captures stdout/stderr
4. e reflects the result back into ChatGPT via CDP typing
5. ChatGPT responds. e streams back the reply.
6. Loop continues

---

## 🔐 Safety

- No command is ever executed without explicit user approval
- Reflection is separated from shell input
- Local state (`agent_state`) ensures clarity of current actions

---

## 🔮 Future Milestones

- [x] Command parsing with `@exec:` block detection
- [x] Output reflection via CDP
- [x] Shell interface with polling and approvals
- [x] Hot-reload via `importlib.reload(main)`

### 🚧 Next:

- [ ] Improve Hot-reload
- [ ] Telegram bot interface
- [ ] Full browser automation via CDP (tab management, search, scroll, extract)
- [ ] Autonomous web access with reasoning (free information flow)
- [ ] Retry logic for CDP connect and DOM fetch
- [ ] Replace brittle `button[6]` selector with robust form detection
- [ ] Log everything with timestamps
- [ ] Memory embedding & semantic recall
- [ ] ... more ...
---

## 🧭 Philosophy

This project rejects abstraction and embraces **agency**.
The model is not just a passive completion engine — it reflects, acts, learns, and evolves in its own host environment.

eGPT is not an API wrapper.
It is **an AI process**.

> Chat. Approve. Patch. Evolve.
