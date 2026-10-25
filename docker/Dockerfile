# eGPT node blueprint: Beeper Desktop, Chrome, whisper.cpp, piper and claude in one container.
# Beeper is a GUI app, so it runs on a virtual X screen (Xvfb). x11vnc exposes
# that screen on :5900 for the one-time login; keep that port private.
# No eGPT code and no secrets in the image: the checkout is cloned onto its own volume at first boot.
#
# Build (no whisper model in the image; models live on the data volume):
#   docker build -f docker/Dockerfile -t egpt:edw-dev .

ARG NODE_VERSION=24.13.1

# whisper.cpp from source, at a pinned tag.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_TAG=v1.9.5
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp /src/whisper.cpp
WORKDIR /src/whisper.cpp
# AVX2/FMA baseline, not -march=native: the image must run on other hosts too.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
      -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
      -DWHISPER_BUILD_TESTS=OFF \
  && cmake --build build -j"$(nproc)" --target whisper-cli whisper-server

FROM node:${NODE_VERSION}-bookworm-slim

# Electron runtime libs, virtual display, VNC, and tools egpt shells out to.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git tini procps lsof unzip gnupg jq \
      xvfb x11vnc openbox xdotool imagemagick \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libdrm2 \
      libsecret-1-0 libnotify4 libatspi2.0-0 libx11-xcb1 libxtst6 xdg-utils \
      fonts-noto-core fonts-noto-color-emoji \
      ffmpeg libgomp1 python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Google Chrome stable, at /usr/bin/google-chrome-stable (chrome-launcher.mjs CHROME_PATHS.linux).
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /usr/share/keyrings/google-linux.asc \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux.asc] https://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*

# Beeper Desktop, unpacked from its AppImage (no FUSE needed at runtime).
ARG BEEPER_URL=https://api.beeper.com/desktop/download/linux/x64/stable/com.automattic.beeper.desktop
RUN mkdir -p /opt/beeper-dl && cd /opt/beeper-dl \
  && curl -fsSL -o Beeper.AppImage "$BEEPER_URL" \
  && chmod +x Beeper.AppImage && ./Beeper.AppImage --appimage-extract >/dev/null \
  && mv squashfs-root /opt/beeper && cd / && rm -rf /opt/beeper-dl

# The default persona engine (/usr/local/bin/claude, found on PATH).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Piper: RADIO_PIPER holds venv/ and voices/ (src/spine/synthesizer-worker.mjs).
ARG PIPER_TTS_VERSION=1.8.0
ARG PIPER_VOICES_REV=5041a7a49ae5b3a0f30e6837769eb03fdbb231bd
RUN python3 -m venv /opt/piper/venv \
  && /opt/piper/venv/bin/pip install --no-cache-dir "piper-tts==$PIPER_TTS_VERSION" \
  && mkdir -p /opt/piper/voices && cd /opt/piper/voices \
  && for f in es_MX-claude-high.onnx es_MX-claude-high.onnx.json; do \
       curl -fsSL -o "$f" "https://huggingface.co/rhasspy/piper-voices/resolve/$PIPER_VOICES_REV/es/es_MX/claude/high/$f"; \
     done

# noVNC: the same VNC screen as a browser tab on :6080 (vnc.html).
RUN apt-get update && apt-get install -y --no-install-recommends novnc websockify \
  && rm -rf /var/lib/apt/lists/*

# AWS CLI v2, PGP-verified with AWS's published key (docker/awscli.asc).
ARG AWSCLI_VERSION=2.38.1
ARG AWSCLI_KEY_FPR=FB5DB77FD5C118B80511ADA8A6310ACC4672475C
RUN --mount=type=bind,source=docker/awscli.asc,target=/tmp/awscli.asc \
    cd /tmp && export GNUPGHOME="$(mktemp -d)" \
  && curl -fsSL -o awscli.zip "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-$AWSCLI_VERSION.zip" \
  && curl -fsSL -o awscli.zip.sig "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-$AWSCLI_VERSION.zip.sig" \
  && gpg --batch --quiet --import awscli.asc \
  && gpg --batch --status-fd 1 --verify awscli.zip.sig awscli.zip | grep -q "^\[GNUPG:\] VALIDSIG $AWSCLI_KEY_FPR " \
  && unzip -q awscli.zip && ./aws/install \
  && rm -rf awscli.zip awscli.zip.sig aws "$GNUPGHOME"

COPY --from=whisper /src/whisper.cpp/build/bin/whisper-cli /src/whisper.cpp/build/bin/whisper-server /usr/local/bin/
COPY --from=whisper /src/whisper.cpp/samples/jfk.wav /opt/whisper/samples/jfk.wav

# The being box: a sandboxed being runs as its conversation's own uid in a private view
# (docker/egpt-box). Root-owned; the spine may run it through one sudoers line.
RUN apt-get update && apt-get install -y --no-install-recommends sudo acl openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/egpt-entrypoint
COPY --chmod=755 docker/scripts/ /usr/local/bin/
COPY --chmod=755 docker/egpt-box /usr/local/sbin/egpt-box
COPY --chmod=440 docker/sudoers-egpt-box /etc/sudoers.d/egpt-box

# Non-root user (uid 1000 matches the usual host user for volume ownership).
# Its home is 0700: no other uid reads config, secrets, .claude or conversations.
# The X socket directory exists up front: Xvfb runs as egpt, and listens on no abstract socket.
RUN userdel -r node 2>/dev/null; useradd -m -u 1000 -s /bin/bash egpt && chmod 700 /home/egpt \
  && install -d -m 1777 /tmp/.X11-unix

USER egpt
# EGPT_SESSION1=1: the daemon loads chrome-host (daemon-runtime.mjs).
ENV HOME=/home/egpt EGPT_HOME=/home/egpt/.egpt DISPLAY=:99 EGPT_SESSION1=1 \
    RADIO_PIPER=/opt/piper CLAUDE_CONFIG_DIR=/home/egpt/.claude
RUN mkdir -p /home/egpt/.egpt /home/egpt/.config/BeeperTexts /home/egpt/.claude /home/egpt/src/egpt
VOLUME ["/home/egpt/.egpt", "/home/egpt/.config/BeeperTexts", "/home/egpt/.claude", "/home/egpt/src/egpt"]
EXPOSE 5900 6080

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/egpt-entrypoint"]
