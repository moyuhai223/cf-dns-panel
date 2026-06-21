#!/usr/bin/env bash
#
# install.sh — one-click installer / updater for cf-dns-panel
#
# cf-dns-panel is a self-hosted Node.js web panel that manages Cloudflare DNS
# via the Cloudflare API. It listens ONLY on 127.0.0.1. Public HTTPS, TLS and
# the reverse proxy are handled OUTSIDE this script by the user's 1Panel.
# This installer therefore does NOT touch nginx, certificates or any firewall.
#
# Bootstrap (install or update):
#   curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | bash
#
# Pin to a released version (a git tag) instead of the latest main:
#   curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | bash -s -- --ref v1.0.0
#
# Configure via environment variables (or long flags), all optional:
#   INSTALL_DIR   install location               (default: /opt/cf-dns-panel)
#   REPO_URL      git repository to clone         (default: derived from REPO_OWNER)
#   BRANCH        git branch                      (default: main)
#   REF           git branch OR tag to deploy     (default: BRANCH; e.g. v1.0.0)
#   PORT          local listen port              (default: 8787)
#   SERVICE_USER  systemd service account         (default: cfpanel)
#   NODE_MAJOR    Node major to install if absent (default: 22)
#
# Uninstall:
#   curl -fsSL .../install.sh | bash -s -- --uninstall            # remove service + unit
#   curl -fsSL .../install.sh | bash -s -- --uninstall --purge    # ALSO remove dir + user (DATA LOSS)
#
# The script is piped to bash via stdin, so it NEVER reads config from stdin;
# any unavoidable prompt reads from /dev/tty. It is fully non-interactive by default.

set -o errexit
set -o nounset
set -o pipefail

# Make git non-interactive everywhere in this script: a wrong/private REPO_URL
# turns into an immediate clean failure (caught by the ERR trap) rather than a
# hang on an invisible credential prompt in a curl|bash context.
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=true

# ---------------------------------------------------------------------------
# Maintainer configuration — substitute the real GitHub owner/org here.
# ---------------------------------------------------------------------------
REPO_OWNER="moyuhai223"                # GitHub owner/org hosting this repository
REPO_NAME="cf-dns-panel"

# ---------------------------------------------------------------------------
# Defaults (overridable via environment or long flags). Guarded for set -u.
# ---------------------------------------------------------------------------
INSTALL_DIR="${INSTALL_DIR:-/opt/cf-dns-panel}"
BRANCH="${BRANCH:-main}"
REF="${REF:-}"                         # branch OR tag to deploy; resolved to BRANCH after arg parsing
PORT="${PORT:-8787}"
SERVICE_USER="${SERVICE_USER:-cfpanel}"
NODE_MAJOR="${NODE_MAJOR:-22}"
REPO_URL="${REPO_URL:-https://github.com/${REPO_OWNER}/${REPO_NAME}.git}"

SERVICE_NAME="cf-dns-panel"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Action flags
DO_UNINSTALL=0
DO_PURGE=0

# ---------------------------------------------------------------------------
# Logging helpers — colour only when stderr is a real TTY; never leak secrets.
# ALL helpers write to stderr so stdout stays clean for value-returning
# functions (node_major_version, gen_secret) — a stray log can never pollute
# a command substitution.
# ---------------------------------------------------------------------------
if [ -t 2 ]; then
  _C_RESET=$'\033[0m'; _C_INFO=$'\033[34m'; _C_OK=$'\033[32m'
  _C_WARN=$'\033[33m'; _C_ERR=$'\033[31m'
else
  _C_RESET=""; _C_INFO=""; _C_OK=""; _C_WARN=""; _C_ERR=""
fi

info() { printf '%s[ * ]%s %s\n' "$_C_INFO" "$_C_RESET" "$*" >&2; }
ok()   { printf '%s[ ok ]%s %s\n' "$_C_OK"   "$_C_RESET" "$*" >&2; }
warn() { printf '%s[ ! ]%s %s\n' "$_C_WARN" "$_C_RESET" "$*" >&2; }
err()  { printf '%s[ERR]%s %s\n' "$_C_ERR"  "$_C_RESET" "$*" >&2; }

# ---------------------------------------------------------------------------
# ERR trap — report the failing command and line number, then abort.
# ---------------------------------------------------------------------------
on_err() {
  local exit_code=$?
  local line_no=${1:-?}
  err "Failed at line ${line_no} (exit ${exit_code}): ${BASH_COMMAND}"
  err "Installation aborted. Re-running after fixing the issue is safe (idempotent)."
  exit "$exit_code"
}
trap 'on_err "${LINENO}"' ERR

# ---------------------------------------------------------------------------
# Help / usage — documents both long flags and their env-var equivalents.
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
Usage: install.sh [options]

Install or update cf-dns-panel (idempotent; safe to re-run).

Options (env-var equivalent in parentheses):
  --install-dir DIR     Install location      (INSTALL_DIR)   default: ${INSTALL_DIR}
  --repo-url URL        Git repository URL     (REPO_URL)      default: ${REPO_URL}
  --branch NAME         Git branch             (BRANCH)        default: ${BRANCH}
  --ref NAME            Git branch OR tag      (REF)           default: same as --branch
                        Pin a release, e.g. --ref v1.0.0
  --port N              Local listen port      (PORT)          default: ${PORT}
  --service-user NAME   systemd service account(SERVICE_USER)  default: ${SERVICE_USER}
  --node-major N        Node major to install  (NODE_MAJOR)    default: ${NODE_MAJOR}
  --uninstall           Stop & remove the service and unit
  --purge               With --uninstall: also remove ${INSTALL_DIR} and the
                        service user (DESTROYS the panel database in data/)
  -h, --help            Show this help and exit

Configuration may be supplied via the env vars above or the matching flags.
The script never reads configuration from stdin (it is itself piped to bash).
EOF
}

# ---------------------------------------------------------------------------
# Require root. The panel installs system packages, a systemd unit and a
# dedicated service user, so root is mandatory. On a typical VPS you are already
# root — no sudo needed. Done before argument parsing.
# ---------------------------------------------------------------------------
require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    err "This installer must be run as root."
    err "Switch to root and re-run, e.g.:"
    err "  curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | bash"
    exit 1
  fi
}
require_root

# ---------------------------------------------------------------------------
# Argument parsing — long flags mirror the env vars. Runs as root.
# ---------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir)    INSTALL_DIR="${2:?--install-dir needs a value}"; shift 2 ;;
    --install-dir=*)  INSTALL_DIR="${1#*=}"; shift ;;
    --repo-url)       REPO_URL="${2:?--repo-url needs a value}"; shift 2 ;;
    --repo-url=*)     REPO_URL="${1#*=}"; shift ;;
    --branch)         BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --branch=*)       BRANCH="${1#*=}"; shift ;;
    --ref)            REF="${2:?--ref needs a value}"; shift 2 ;;
    --ref=*)          REF="${1#*=}"; shift ;;
    --port)           PORT="${2:?--port needs a value}"; shift 2 ;;
    --port=*)         PORT="${1#*=}"; shift ;;
    --service-user)   SERVICE_USER="${2:?--service-user needs a value}"; shift 2 ;;
    --service-user=*) SERVICE_USER="${1#*=}"; shift ;;
    --node-major)     NODE_MAJOR="${2:?--node-major needs a value}"; shift 2 ;;
    --node-major=*)   NODE_MAJOR="${1#*=}"; shift ;;
    --uninstall)      DO_UNINSTALL=1; shift ;;
    --purge)          DO_PURGE=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) err "Unknown argument: $1"; usage >&2; exit 2 ;;
  esac
done

# REF defaults to BRANCH so `--branch` alone keeps working; `--ref`/REF may pin a
# tag (e.g. v1.0.0) or any branch. Resolved here, AFTER parsing, so a later
# `--branch` still feeds REF when `--ref` was not given.
: "${REF:=$BRANCH}"

# ---------------------------------------------------------------------------
# Distro / package-manager detection.
# ---------------------------------------------------------------------------
PKG_MGR=""
detect_pkg_mgr() {
  if command -v apt-get >/dev/null 2>&1; then
    PKG_MGR="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG_MGR="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG_MGR="yum"
  else
    err "Unsupported system: no apt-get, dnf or yum found."
    err "Only Debian/Ubuntu (apt) and the RHEL family (dnf/yum) are supported."
    exit 1
  fi
  info "Detected package manager: ${PKG_MGR}"
}

# Wrappers ------------------------------------------------------------------
pkg_update_done=0
pkg_install() {
  # Install the given packages, refreshing metadata once per run for apt.
  case "$PKG_MGR" in
    apt)
      if [ "$pkg_update_done" -eq 0 ]; then
        info "Refreshing apt package metadata..."
        DEBIAN_FRONTEND=noninteractive apt-get update -y
        pkg_update_done=1
      fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
      ;;
    dnf)
      dnf install -y "$@"
      ;;
    yum)
      yum install -y "$@"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Uninstall path.
# ---------------------------------------------------------------------------
do_uninstall() {
  info "Uninstalling ${SERVICE_NAME}..."

  if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
    systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
    systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
    # Make sure no stray processes survive (important before userdel below).
    systemctl kill "${SERVICE_NAME}" 2>/dev/null || true
    ok "Service stopped and disabled."
  else
    warn "Service ${SERVICE_NAME} not found; nothing to stop."
  fi

  if [ -f "$SERVICE_FILE" ]; then
    rm -f "$SERVICE_FILE"
    ok "Removed ${SERVICE_FILE}."
  fi
  systemctl daemon-reload 2>/dev/null || true

  if [ "$DO_PURGE" -eq 1 ]; then
    warn "--purge given: removing INSTALL_DIR and the service user."
    warn "This DESTROYS the panel database under ${INSTALL_DIR}/data — irreversible."
    if [ -d "$INSTALL_DIR" ]; then
      rm -rf "$INSTALL_DIR"
      ok "Removed ${INSTALL_DIR}."
    fi
    if [ "$SERVICE_USER" != "root" ] && id "$SERVICE_USER" >/dev/null 2>&1; then
      # Ensure no lingering processes hold the account before userdel.
      pkill -KILL -u "$SERVICE_USER" 2>/dev/null || true
      sleep 1
      if command -v userdel >/dev/null 2>&1; then
        userdel "$SERVICE_USER" 2>/dev/null || true
      elif command -v deluser >/dev/null 2>&1; then
        deluser "$SERVICE_USER" 2>/dev/null || true
      fi
      if id "$SERVICE_USER" >/dev/null 2>&1; then
        warn "Could not fully remove user ${SERVICE_USER} (may still be in use)."
      else
        ok "Removed service user ${SERVICE_USER}."
      fi
    fi
  else
    info "INSTALL_DIR (${INSTALL_DIR}) and user ${SERVICE_USER} were kept."
    info "Re-run with --uninstall --purge to remove them (DATA LOSS)."
  fi

  ok "Uninstall complete."
}

# ---------------------------------------------------------------------------
# Prerequisite packages: base tools + build toolchain fallback for native deps
# (better-sqlite3 may need to rebuild from source on non-glibc/edge cases).
#
# NOTE (RHEL family): the base images ship `curl-minimal`, which Conflicts with
# the full `curl` package. We therefore do NOT request `curl` by name on dnf/yum
# (curl-minimal already provides /usr/bin/curl, the only thing we use). We then
# assert curl is present afterwards.
# ---------------------------------------------------------------------------
install_prereqs() {
  info "Installing prerequisites (ca-certificates, curl, git, build toolchain)..."
  case "$PKG_MGR" in
    apt)
      pkg_install ca-certificates curl git gnupg build-essential python3
      ;;
    dnf|yum)
      # Prefer the full Development Tools group for a complete native-build env,
      # then ensure the individual packages are present as a fallback. Do NOT
      # name `curl` (curl-minimal conflict).
      if [ "$PKG_MGR" = "dnf" ]; then
        dnf groupinstall -y "Development Tools" >/dev/null 2>&1 || true
      else
        yum groupinstall -y "Development Tools" >/dev/null 2>&1 || true
      fi
      pkg_install ca-certificates git python3 gcc gcc-c++ make
      ;;
  esac
  # Refresh CA trust store (best-effort; harmless if already current).
  update-ca-certificates >/dev/null 2>&1 || update-ca-trust >/dev/null 2>&1 || true

  # curl is required by NodeSource bootstrap and the health check. Assert it now
  # so we fail with a clear message rather than a later command-not-found.
  if ! command -v curl >/dev/null 2>&1; then
    err "curl is required but is not available after installing prerequisites."
    exit 1
  fi
  ok "Prerequisites installed."
}

# ---------------------------------------------------------------------------
# Node.js: keep existing Node when MAJOR >= 20; otherwise install NODE_MAJOR
# from the official NodeSource setup script.
# ---------------------------------------------------------------------------
node_major_version() {
  # Echo the numeric major version of the current node, or nothing if absent.
  if command -v node >/dev/null 2>&1; then
    local v
    v="$(node --version 2>/dev/null || true)"   # e.g. v22.3.0
    v="${v#v}"
    v="${v%%.*}"
    case "$v" in
      ''|*[!0-9]*) printf '' ;;   # not a clean number
      *) printf '%s' "$v" ;;
    esac
  fi
}

ensure_node() {
  local cur
  cur="$(node_major_version)"
  # The comparison lives inside an `if` so a non-numeric edge value can never
  # trip errexit on a bare line.
  if [ -n "$cur" ] && [ "$cur" -ge 20 ] 2>/dev/null; then
    ok "Existing Node.js detected (major v${cur} >= 20); keeping it."
  else
    if [ -n "$cur" ]; then
      warn "Node.js major v${cur} is too old (need >= 20); installing Node ${NODE_MAJOR} from NodeSource."
    else
      info "Node.js not found; installing Node ${NODE_MAJOR} from NodeSource."
    fi
    case "$PKG_MGR" in
      apt)
        local setup
        setup="$(mktemp)"
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$setup"
        bash "$setup"
        rm -f "$setup"
        pkg_update_done=0   # NodeSource added a new apt source; force refresh
        pkg_install nodejs
        ;;
      dnf|yum)
        local setup
        setup="$(mktemp)"
        curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" -o "$setup"
        bash "$setup"
        rm -f "$setup"
        # Reset/disable the distro nodejs AppStream module so the NodeSource
        # package wins instead of an old module-stream nodejs (e.g. RHEL 9's
        # nodejs:18). Guarded for systems without dnf modules.
        if [ "$PKG_MGR" = "dnf" ]; then
          dnf -y module reset nodejs   >/dev/null 2>&1 || true
          dnf -y module disable nodejs >/dev/null 2>&1 || true
        fi
        pkg_install nodejs
        ;;
    esac
  fi

  # Verify node + npm are usable.
  if ! command -v node >/dev/null 2>&1; then
    err "Node.js installation failed: 'node' not found on PATH."
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    err "npm not found after Node.js installation."
    exit 1
  fi
  ok "Node $(node --version) / npm $(npm --version) ready."
}

# ---------------------------------------------------------------------------
# Service user: dedicated, non-login system account (skip when using root).
# ---------------------------------------------------------------------------
ensure_service_user() {
  if [ "$SERVICE_USER" = "root" ]; then
    info "SERVICE_USER is root; not creating a dedicated user."
    return 0
  fi
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    ok "Service user ${SERVICE_USER} already exists."
    return 0
  fi
  info "Creating system service user ${SERVICE_USER}..."
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
      || useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER" 2>/dev/null \
      || useradd --system --no-create-home "$SERVICE_USER"
  elif command -v adduser >/dev/null 2>&1; then
    adduser --system --no-create-home --group "$SERVICE_USER"
  else
    err "Neither useradd nor adduser available; cannot create ${SERVICE_USER}."
    exit 1
  fi
  ok "Created service user ${SERVICE_USER}."
}

# ---------------------------------------------------------------------------
# Fetch the code idempotently: clone, or fetch + hard reset an existing repo.
# REF may be a branch OR a tag (e.g. v1.0.0). We fetch the ref and force the
# working tree to exactly its commit via FETCH_HEAD — uniform for both, and it
# lets an existing install switch between a branch and a pinned tag on re-run.
#
# git runs AS ROOT here, but on an update the .git dir is owned by the service
# user (from a prior set_ownership). Mark the dir safe so git >= 2.35.2 does not
# refuse with "detected dubious ownership". safe.directory add is idempotent.
# ---------------------------------------------------------------------------
fetch_code() {
  if [ -d "${INSTALL_DIR}/.git" ]; then
    info "Existing repo at ${INSTALL_DIR}; updating to ${REF}..."
    git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
    git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
    # Fetch the requested ref (branch or tag); FETCH_HEAD points at its commit.
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$REF"
    # Detach onto exactly what we fetched — works for a tag (no local branch to
    # track) and a branch alike, and never leaves a stale local branch behind.
    git -C "$INSTALL_DIR" checkout -f --detach FETCH_HEAD
    git -C "$INSTALL_DIR" reset --hard FETCH_HEAD
    git -C "$INSTALL_DIR" clean -fd
    ok "Repository updated to ${REF}."
  else
    if [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
      err "${INSTALL_DIR} exists, is non-empty, and is not a git repo. Refusing to overwrite."
      err "Move it aside or choose a different --install-dir."
      exit 1
    fi
    info "Cloning ${REPO_URL} (ref ${REF}) into ${INSTALL_DIR}..."
    mkdir -p "$INSTALL_DIR"
    # --branch accepts a tag name as well as a branch; --depth 1 stays shallow.
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
    git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
    ok "Repository cloned at ${REF}."
  fi
}

# ---------------------------------------------------------------------------
# Build: install root deps, then build the SPA into public/.
# Runs as root with an isolated npm cache, then chowns everything to the user.
# ---------------------------------------------------------------------------
build_app() {
  info "Installing dependencies and building the web SPA (this may take a while)..."
  local npm_cache
  npm_cache="$(mktemp -d)"
  export npm_config_cache="$npm_cache"
  export npm_config_fund=false
  export npm_config_audit=false

  # Root runtime deps (includes the native better-sqlite3).
  ( cd "$INSTALL_DIR" && npm install --no-audit --no-fund )

  # Build the SPA into public/ (package.json "build" installs+builds web/).
  ( cd "$INSTALL_DIR" && npm run build )

  rm -rf "$npm_cache"
  ok "Build complete."
}

# ---------------------------------------------------------------------------
# .env: create only if missing (NEVER overwrite — it holds the persistent
# APP_SECRET). Lock down to 600 and the service user. Ensure data/ exists.
# ---------------------------------------------------------------------------
gen_secret() {
  # 64 hex chars (32 bytes). Prefer openssl; fall back to /dev/urandom.
  # The fallback uses a BOUNDED producer: `head -c 1024 /dev/urandom` feeds a
  # finite stream, so the downstream `head -c 64` closing the pipe cannot send
  # SIGPIPE to an unbounded `tr` reading /dev/urandom (which would surface as
  # rc=141 under pipefail and abort the installer).
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 1024 /dev/urandom | LC_ALL=C tr -dc 'a-f0-9' | head -c 64
  fi
}

setup_env() {
  local env_file="${INSTALL_DIR}/.env"
  if [ -f "$env_file" ]; then
    ok ".env already exists; preserving it (APP_SECRET and settings untouched)."
  else
    info "Creating ${env_file} with a freshly generated APP_SECRET..."
    local secret
    secret="$(gen_secret || true)"
    if [ "${#secret}" -ne 64 ]; then
      err "Failed to generate a 64-char APP_SECRET (got ${#secret} chars)."
      err "Install openssl or ensure /dev/urandom is readable, then re-run."
      exit 1
    fi
    # Write atomically with a restrictive umask so the secret is never world-readable.
    ( umask 077
      cat > "$env_file" <<EOF
# cf-dns-panel configuration — generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# This file holds the persistent APP_SECRET; do NOT share or regenerate it
# unless you intend to invalidate all existing sessions and encrypted tokens.

# Bind locally only; 1Panel terminates TLS and reverse-proxies to this address.
HOST=127.0.0.1
PORT=${PORT}

# Secret for cookie signing + AES token encryption. Keep this stable & private.
APP_SECRET=${secret}

# Leave false while you test over plain HTTP. Set true AFTER you enable HTTPS
# in 1Panel, otherwise secure cookies will block login over HTTP.
COOKIE_SECURE=false

# --- Optional settings (see .env.example for full docs) ---------------------
# Only needed if 1Panel reverse-proxies under a sub-path (e.g. /dns). Must match
# the proxy location. Leave unset for root-path serving.
#BASE_PATH=

# Logging verbosity: fatal | error | warn | info | debug | trace
#LOG_LEVEL=info

# Override data/DB locations (defaults live under the install dir's data/).
#DATA_DIR=
#DB_PATH=
EOF
    )
    chmod 600 "$env_file"
    ok ".env created (mode 600)."
  fi

  # Ensure the data directory exists for the SQLite DB and secret.key fallback.
  mkdir -p "${INSTALL_DIR}/data"
}

# ---------------------------------------------------------------------------
# Read the effective HOST/PORT/BASE_PATH the APP will actually use from the
# authoritative .env (single source of truth). Falls back to the installer's
# PORT default if .env lacks the key. Used by the health check + summary so an
# update that preserves a differently-configured .env still verifies correctly.
# ---------------------------------------------------------------------------
EFFECTIVE_PORT=""
EFFECTIVE_BASE_PATH=""
read_effective_config() {
  local env_file="${INSTALL_DIR}/.env"
  local p bp
  p="$(grep -E '^[[:space:]]*PORT=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]\"'"'"'' || true)"
  EFFECTIVE_PORT="${p:-$PORT}"
  bp="$(grep -E '^[[:space:]]*BASE_PATH=' "$env_file" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '[:space:]\"'"'"'' || true)"
  # Normalise: ensure a leading slash if set, and strip any trailing slash.
  if [ -n "$bp" ]; then
    [ "${bp#/}" = "$bp" ] && bp="/$bp"
    bp="${bp%/}"
  fi
  EFFECTIVE_BASE_PATH="$bp"
}

# ---------------------------------------------------------------------------
# Ownership: hand the whole tree (incl. .env and data/) to the service user.
# Runs unconditionally after build so every re-run converges to a fully
# service-user-owned tree (build wrote some artifacts as root).
# ---------------------------------------------------------------------------
set_ownership() {
  if [ "$SERVICE_USER" = "root" ]; then
    return 0
  fi
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    err "Service user ${SERVICE_USER} does not exist at ownership step; cannot chown."
    exit 1
  fi
  info "Setting ownership of ${INSTALL_DIR} to ${SERVICE_USER}..."
  local grp
  grp="$(id -gn "$SERVICE_USER" 2>/dev/null || echo "$SERVICE_USER")"
  chown -R "${SERVICE_USER}:${grp}" "$INSTALL_DIR"
  chmod 600 "${INSTALL_DIR}/.env" 2>/dev/null || true
  ok "Ownership set."
}

# ---------------------------------------------------------------------------
# systemd unit: WorkingDirectory + absolute node ExecStart. The app's .env
# owns HOST/PORT/APP_SECRET/COOKIE_SECURE — the unit deliberately does NOT
# duplicate them (avoids override ambiguity). Only NODE_ENV is set here.
#
# ProtectHome is applied conditionally: enabling it would make INSTALL_DIRs that
# live under /home or /root unreadable to the service, breaking start. For the
# default /opt path it is enabled.
# ---------------------------------------------------------------------------
install_service() {
  local node_bin
  # Tolerate command -v failing so the guard below can produce its message
  # rather than errexit aborting on the bare assignment.
  node_bin="$(command -v node || true)"
  if [ -z "$node_bin" ]; then
    err "Cannot resolve an absolute node path for the systemd unit."
    exit 1
  fi
  info "Installing systemd unit at ${SERVICE_FILE}..."

  local svc_group
  svc_group="$(id -gn "$SERVICE_USER" 2>/dev/null || echo "$SERVICE_USER")"

  local protect_home_line=""
  case "$INSTALL_DIR" in
    /home/*|/root/*) protect_home_line="" ;;             # would break readability
    *)               protect_home_line="ProtectHome=true" ;;
  esac

  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=cf-dns-panel — Cloudflare DNS management web panel
Documentation=https://github.com/${REPO_OWNER}/${REPO_NAME}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${svc_group}
WorkingDirectory=${INSTALL_DIR}
# .env (loaded by the app) owns HOST/PORT/APP_SECRET/COOKIE_SECURE.
Environment=NODE_ENV=production
ExecStart=${node_bin} server/index.js
Restart=on-failure
RestartSec=3
# Light hardening (kept conservative for a 127.0.0.1 service writing to data/).
NoNewPrivileges=true
ProtectSystem=full
${protect_home_line}
PrivateTmp=true
ReadWritePaths=${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
EOF
  ok "systemd unit written."
}

# ---------------------------------------------------------------------------
# Enable + start the service, then verify it is active and answering the health
# endpoint at the APP's real PORT and BASE_PATH. Asserts the body so an SPA
# index.html fallback (HTTP 200) cannot count as a false PASS.
# ---------------------------------------------------------------------------
start_and_verify() {
  info "Reloading systemd and starting the service..."
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
  systemctl restart "${SERVICE_NAME}"

  # Give the app a moment to bind and open the DB.
  local i active=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
      active=1
      break
    fi
    sleep 1
  done

  if [ "$active" -ne 1 ]; then
    err "Service ${SERVICE_NAME} did not become active. Recent status + logs:"
    systemctl status "${SERVICE_NAME}" --no-pager -l >&2 || true
    journalctl -u "${SERVICE_NAME}" -n 40 --no-pager >&2 || true
    exit 1
  fi
  ok "Service is active."

  # Build the probe URL from the app's authoritative .env values.
  local health_url="http://127.0.0.1:${EFFECTIVE_PORT}${EFFECTIVE_BASE_PATH}/healthz"
  info "Verifying ${health_url} ..."
  local ok_health=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    # --max-time bounds each probe so a hung socket cannot stall the loop.
    # Assert the JSON body (route returns {"ok":true,...}) to defeat an SPA
    # index.html 200 false-positive under BASE_PATH/notFound fallback.
    if curl -fsS --max-time 3 "$health_url" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
      ok_health=1
      break
    fi
    sleep 1
  done

  if [ "$ok_health" -eq 1 ]; then
    ok "Health check passed (${health_url} returned ok)."
  else
    err "Health check FAILED at ${health_url}. Recent status + logs:"
    systemctl status "${SERVICE_NAME}" --no-pager -l >&2 || true
    journalctl -u "${SERVICE_NAME}" -n 40 --no-pager >&2 || true
    err "The service is running but did not answer the health check; inspect the logs above."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Final summary.
# ---------------------------------------------------------------------------
print_summary() {
  local url="http://127.0.0.1:${EFFECTIVE_PORT}${EFFECTIVE_BASE_PATH}"
  # Best-effort: read the deployed version from package.json (node is present).
  local version=""
  if [ -f "${INSTALL_DIR}/package.json" ]; then
    version="$(grep -m1 '"version"' "${INSTALL_DIR}/package.json" 2>/dev/null \
      | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)"
  fi
  cat <<EOF

  cf-dns-panel is installed and running.

  Install location : ${INSTALL_DIR}
  Version          : ${version:-unknown}  (ref ${REF})
  Service          : ${SERVICE_NAME} (systemd)  — User=${SERVICE_USER}
  Local URL        : ${url}
  Health endpoint  : ${url}/healthz
  Config file      : ${INSTALL_DIR}/.env  (mode 600, holds APP_SECRET)

Next steps with 1Panel (this script intentionally leaves TLS/proxy to you):
  1. In 1Panel, create a website / reverse proxy that forwards your public
     HTTPS domain to:  http://127.0.0.1:${EFFECTIVE_PORT}
  2. Once HTTPS is working end-to-end, edit ${INSTALL_DIR}/.env and set:
         COOKIE_SECURE=true
     then restart:   systemctl restart ${SERVICE_NAME}
     (Leave it false while testing over plain HTTP, or login cookies break.)

Manage the service:
  systemctl status ${SERVICE_NAME}
  journalctl -u ${SERVICE_NAME} -f

Update to the latest code (idempotent — re-run this installer):
  curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | bash

Uninstall:
  curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | bash -s -- --uninstall          # remove service + unit (keeps data)
  curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | bash -s -- --uninstall --purge  # ALSO delete ${INSTALL_DIR} + user (DATA LOSS)

EOF
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
main() {
  if [ "$DO_UNINSTALL" -eq 1 ]; then
    do_uninstall
    exit 0
  fi

  if [ "$REPO_OWNER" = "REPLACE_ME_OWNER" ] && [ "${REPO_URL}" = "https://github.com/REPLACE_ME_OWNER/${REPO_NAME}.git" ]; then
    err "Maintainer setup incomplete: set REPO_OWNER near the top of install.sh,"
    err "or pass --repo-url / set REPO_URL to the real repository before running."
    exit 1
  fi

  info "Starting cf-dns-panel installation/update..."
  info "  INSTALL_DIR=${INSTALL_DIR}  REF=${REF}  PORT=${PORT}"
  info "  SERVICE_USER=${SERVICE_USER}  NODE_MAJOR=${NODE_MAJOR}"

  detect_pkg_mgr
  install_prereqs
  ensure_node
  ensure_service_user
  fetch_code
  build_app
  setup_env
  read_effective_config
  set_ownership
  install_service
  start_and_verify
  print_summary
}

main "$@"
