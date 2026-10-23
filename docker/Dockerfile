# eGPT + Beeper Desktop in one container.
# Beeper is a GUI app, so it runs on a virtual X screen (Xvfb). x11vnc exposes
# that screen on :5900 for the one-time login; keep that port private.
FROM node:22-bookworm-slim

# Electron runtime libs, virtual display, VNC, and tools egpt shells out to.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git tini procps lsof \
      xvfb x11vnc openbox xdotool imagemagick \
      libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 libdrm2 \
      libsecret-1-0 libnotify4 libatspi2.0-0 libx11-xcb1 libxtst6 xdg-utils \
      fonts-noto-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# Beeper Desktop, unpacked from its AppImage (no FUSE needed at runtime).
ARG BEEPER_URL=https://api.beeper.com/desktop/download/linux/x64/stable/com.automattic.beeper.desktop
RUN mkdir -p /opt/beeper-dl && cd /opt/beeper-dl \
  && curl -fsSL -o Beeper.AppImage "$BEEPER_URL" \
  && chmod +x Beeper.AppImage && ./Beeper.AppImage --appimage-extract >/dev/null \
  && mv squashfs-root /opt/beeper && cd / && rm -rf /opt/beeper-dl

# The default persona engine.
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Non-root user (uid 1000 matches the usual host user for volume ownership).
RUN userdel -r node 2>/dev/null; useradd -m -u 1000 -s /bin/bash egpt
WORKDIR /opt/egpt
COPY --chown=egpt:egpt package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=egpt:egpt . .
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/egpt-entrypoint
COPY --chmod=755 docker/scripts/ /usr/local/bin/

USER egpt
ENV HOME=/home/egpt EGPT_HOME=/home/egpt/.egpt DISPLAY=:99
RUN mkdir -p /home/egpt/.egpt /home/egpt/.config/BeeperTexts /home/egpt/.claude
VOLUME ["/home/egpt/.egpt", "/home/egpt/.config/BeeperTexts", "/home/egpt/.claude"]
EXPOSE 5900

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/egpt-entrypoint"]
