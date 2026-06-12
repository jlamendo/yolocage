#!/usr/bin/env bash
# yolocage container entrypoint.
#
# 1. Boot mitmproxy in the background on 127.0.0.1:8080
# 2. Trust mitmproxy's CA cert in the container's trust store + node's
# 3. Export HTTPS_PROXY so the agent process routes egress through us
# 4. Drop to the unprivileged `agent` user
# 5. Exec the agent (claude / codex), optionally wrapped in tmux
#
# Runs as root (tini → us); drops to `agent` via gosu before the final
# exec. The mitmproxy daemon also runs as root for simplicity — it has
# CAP_NET_BIND_SERVICE-equivalent (binding 8080 doesn't need it but
# CA-cert seeding to system locations does) and the cage is already
# the security boundary.

set -euo pipefail

err() { printf '%s\n' "yc-entrypoint: $*" >&2; }
die() { err "FATAL: $*"; exit 1; }

# ─── Seed the mitmproxy CA cert if the persistent volume is empty ──
# /home/agent/.mitmproxy is a docker named volume. First start of a
# cage finds it empty; subsequent starts reuse the same CA. mitmdump
# generates the cert on first run; we briefly launch it and kill it.

MITM_CA=/home/agent/.mitmproxy/mitmproxy-ca-cert.pem
mkdir -p /home/agent/.mitmproxy
chown -R agent:agent /home/agent/.mitmproxy

if [ ! -f "$MITM_CA" ]; then
  err "seeding mitmproxy CA (first run on this volume)"
  # mitmdump auto-generates the cert in HOME/.mitmproxy on first launch.
  # Run as agent so the resulting cert files are agent-owned.
  HOME=/home/agent gosu agent mitmdump --quiet --listen-port 18080 \
    >/tmp/mitm-seed.log 2>&1 &
  SEED_PID=$!
  # Wait for the cert file to appear, capped at 10s.
  for _ in $(seq 1 100); do
    [ -f "$MITM_CA" ] && break
    sleep 0.1
  done
  kill "$SEED_PID" 2>/dev/null || true
  wait "$SEED_PID" 2>/dev/null || true
fi

if [ ! -f "$MITM_CA" ]; then
  die "mitmproxy CA cert never appeared at $MITM_CA"
fi

# ─── Install the CA into the system trust + node-specific envs ─────
install -m 0644 "$MITM_CA" /usr/local/share/ca-certificates/yolocage.crt
update-ca-certificates >/dev/null

export NODE_EXTRA_CA_CERTS="$MITM_CA"
export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt

# ─── Boot the scrubber ─────────────────────────────────────────────
# --allow-hosts scopes TLS interception to ONLY the LLM API hosts in
# addon.py's LLM_HOSTS. Every other destination (github.com, npm, pypi)
# gets raw CONNECT tunnel passthrough so cert-pinning clients (git,
# go tools, etc.) see the real upstream cert.
mkdir -p /var/log/yolocage
chown -R agent:agent /var/log/yolocage

LLM_HOST_REGEX='^(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.deepseek\.com|api\.x\.ai|api\.cohere\.com|api\.mistral\.ai)(:443)?$'

HOME=/home/agent gosu agent mitmdump \
    --quiet \
    --mode regular \
    --listen-host 127.0.0.1 \
    --listen-port 8080 \
    --set block_global=false \
    --set stream_large_bodies=10m \
    --set connection_strategy=lazy \
    --allow-hosts "$LLM_HOST_REGEX" \
    -s /opt/yolocage/ssproxy/addon.py \
    >/var/log/yolocage/ssproxy.log 2>&1 &
MITM_PID=$!

# Wait for mitmproxy to accept on 8080. The proxy refusing connections
# would leave the agent talking direct to api.anthropic.com — failure
# closed, not silent bypass.
for _ in $(seq 1 50); do
  if (echo > /dev/tcp/127.0.0.1/8080) 2>/dev/null; then
    break
  fi
  if ! kill -0 "$MITM_PID" 2>/dev/null; then
    err "mitmdump died during startup — see /var/log/yolocage/ssproxy.log"
    cat /var/log/yolocage/ssproxy.log >&2 || true
    die "scrubber not ready"
  fi
  sleep 0.1
done

if ! (echo > /dev/tcp/127.0.0.1/8080) 2>/dev/null; then
  die "mitmdump never bound 8080"
fi

export HTTPS_PROXY=http://127.0.0.1:8080
export HTTP_PROXY=http://127.0.0.1:8080
export NO_PROXY=localhost,127.0.0.1,::1
# Some clients honor lowercase only; export both.
export https_proxy="$HTTPS_PROXY"
export http_proxy="$HTTP_PROXY"
export no_proxy="$NO_PROXY"

err "ssproxy ready on 127.0.0.1:8080 (pid $MITM_PID)"

# ─── Drop to agent user + exec the payload ─────────────────────────
# Default CMD is the agent's run command (claude/codex); the user can
# pass anything via `docker run … claude --resume`.
#
# YC_TMUX=1 wraps the agent in a tmux session named "agent" — useful
# for persistent named cages where you want claude-code to survive a
# detach.

cd /workspace 2>/dev/null || cd /home/agent

if [ "${YC_TMUX:-0}" = "1" ]; then
  exec gosu agent tmux new-session -s agent "$*"
else
  exec gosu agent "$@"
fi
