#!/bin/sh
# POCLI Installer — https://github.com/artificial-intelligence-engineering/pocli
# Usage:
#   curl -fsSL https://artificial-intelligence-engineering.github.io/pocli/install.sh | sh
#   curl -fsSL https://artificial-intelligence-engineering.github.io/pocli/install.sh | sh -s -- --version v1.0.0
#   curl -fsSL https://artificial-intelligence-engineering.github.io/pocli/install.sh | sh -s -- --uninstall

set -eu

POCLI_REPO="${POCLI_REPO:-artificial-intelligence-engineering/pocli}"
POCLI_VERSION="${POCLI_VERSION:-latest}"
POCLI_INSTALL_DIR="${POCLI_INSTALL_DIR:-$HOME/.pocli/app}"
POCLI_RUNTIME_DIR="${POCLI_RUNTIME_DIR:-$HOME/.pocli/runtime/node}"
POCLI_BIN_DIR="${POCLI_BIN_DIR:-$HOME/.local/bin}"
POCLI_MIN_NODE_MAJOR=22
POCLI_MIN_NODE_MINOR=5
POCLI_ACTION="install"
POCLI_YES=0

log_info() {
  printf '\033[1;34m[pocli]\033[0m %s\n' "$*"
}

log_ok() {
  printf '\033[1;32m✔\033[0m %s\n' "$*"
}

log_warn() {
  printf '\033[1;33m!\033[0m %s\n' "$*" >&2
}

log_err() {
  printf '\033[1;31m✖\033[0m %s\n' "$*" >&2
}

print_usage() {
  cat <<'EOF'
POCLI Installer

Usage:
  install.sh [options]

Options:
  -v, --version <tag>   Install a specific release tag (default: latest)
  --uninstall           Remove POCLI app binary and managed Node runtime
  -y, --yes             Non-interactive mode
  -h, --help            Show this help message

Environment variables:
  POCLI_VERSION         Release tag or "latest" (default: latest)
  POCLI_INSTALL_DIR     Install directory (default: ~/.pocli/app)
  POCLI_BIN_DIR         Binary directory (default: ~/.local/bin)
  POCLI_LOCAL_TARBALL   Optional path to a local pocli-linux.tar.gz for offline/CI install
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -v|--version)
        if [ "$#" -lt 2 ]; then
          log_err "Missing argument for $1"
          exit 1
        fi
        POCLI_VERSION="$2"
        shift 2
        ;;
      --version=*)
        POCLI_VERSION="${1#*=}"
        shift
        ;;
      --uninstall)
        POCLI_ACTION="uninstall"
        shift
        ;;
      -y|--yes)
        POCLI_YES=1
        shift
        ;;
      -h|--help)
        print_usage
        exit 0
        ;;
      *)
        log_err "Unknown option: $1"
        print_usage
        exit 1
        ;;
    esac
  done
}

node_meets_minimum() {
  node_bin="$1"
  if [ ! -x "$node_bin" ]; then
    return 1
  fi
  "$node_bin" -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit((maj > $POCLI_MIN_NODE_MAJOR || (maj === $POCLI_MIN_NODE_MAJOR && min >= $POCLI_MIN_NODE_MINOR)) ? 0 : 1);" >/dev/null 2>&1
}

detect_arch() {
  raw_arch=$(uname -m)
  case "$raw_arch" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *)
      log_err "Unsupported CPU architecture: $raw_arch (supported: x86_64, arm64)"
      exit 1
      ;;
  esac
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log_err "Required command '$1' is not installed."
    exit 1
  fi
}

install_standalone_node() {
  arch="$1"
  log_info "Node.js >= ${POCLI_MIN_NODE_MAJOR}.${POCLI_MIN_NODE_MINOR} not found. Provisioning standalone Node.js LTS in $POCLI_RUNTIME_DIR..."

  index_url="https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt"
  shasums=$(curl -fsSL "$index_url") || {
    log_err "Failed to fetch Node.js release index from $index_url"
    exit 1
  }

  tarball_name=$(printf '%s\n' "$shasums" | awk -v pat="linux-${arch}.tar.gz\$" '$2 ~ pat { print $2; exit }')
  if [ -z "$tarball_name" ]; then
    tarball_name=$(printf '%s\n' "$shasums" | awk -v pat="linux-${arch}.tar.xz\$" '$2 ~ pat { print $2; exit }')
  fi
  if [ -z "$tarball_name" ]; then
    log_err "Could not resolve standalone Node.js binary for linux-${arch}."
    exit 1
  fi

  node_url="https://nodejs.org/dist/latest-v24.x/${tarball_name}"
  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM

  log_info "Downloading $tarball_name..."
  curl -fsSL "$node_url" -o "$tmp_dir/$tarball_name"

  expected_sha=$(printf '%s\n' "$shasums" | awk -v f="$tarball_name" '$2 == f { print $1; exit }')
  if [ -n "$expected_sha" ] && command -v sha256sum >/dev/null 2>&1; then
    actual_sha=$(sha256sum "$tmp_dir/$tarball_name" | awk '{ print $1 }')
    if [ "$expected_sha" != "$actual_sha" ]; then
      log_err "SHA-256 verification failed for $tarball_name"
      exit 1
    fi
  fi

  rm -rf "${POCLI_RUNTIME_DIR}.tmp"
  mkdir -p "${POCLI_RUNTIME_DIR}.tmp"
  case "$tarball_name" in
    *.tar.xz) tar -xJf "$tmp_dir/$tarball_name" -C "${POCLI_RUNTIME_DIR}.tmp" --strip-components=1 ;;
    *) tar -xzf "$tmp_dir/$tarball_name" -C "${POCLI_RUNTIME_DIR}.tmp" --strip-components=1 ;;
  esac

  rm -rf "$POCLI_RUNTIME_DIR"
  mv "${POCLI_RUNTIME_DIR}.tmp" "$POCLI_RUNTIME_DIR"
  rm -rf "$tmp_dir"
  trap - EXIT INT TERM

  log_ok "Installed standalone Node.js $("$POCLI_RUNTIME_DIR/bin/node" --version) into $POCLI_RUNTIME_DIR"
}

uninstall_pocli() {
  log_info "Uninstalling POCLI..."
  rm -rf "$POCLI_INSTALL_DIR" "$POCLI_RUNTIME_DIR" "$POCLI_BIN_DIR/pocli"
  log_ok "Removed $POCLI_INSTALL_DIR, $POCLI_RUNTIME_DIR, and $POCLI_BIN_DIR/pocli"
  log_info "Note: User database and workspaces in \$HOME/.pocli/ were preserved."
}

write_launcher() {
  mkdir -p "$POCLI_BIN_DIR"
  launcher_path="$POCLI_BIN_DIR/pocli"
  cat >"$launcher_path" <<EOF
#!/bin/sh
if [ -x "$POCLI_RUNTIME_DIR/bin/node" ]; then
  exec "$POCLI_RUNTIME_DIR/bin/node" "$POCLI_INSTALL_DIR/dist/cli.js" "\$@"
fi
exec node "$POCLI_INSTALL_DIR/dist/cli.js" "\$@"
EOF
  chmod 0755 "$launcher_path"
}

main() {
  parse_args "$@"

  if [ "$POCLI_ACTION" = "uninstall" ]; then
    uninstall_pocli
    exit 0
  fi

  os_name=$(uname -s)
  if [ "$os_name" != "Linux" ]; then
    log_warn "POCLI is optimized for Linux; detected OS '$os_name'. Continuing anyway..."
  fi
  arch=$(detect_arch)

  require_cmd curl
  require_cmd tar

  printf '\n\033[1;31m  POCLI Installer\033[0m — \033[2mThe open-source AI dev team in your terminal\033[0m\n\n'

  # Check Node.js >= 22.5.0 (needed for native node:sqlite)
  selected_node=""
  if [ -x "$POCLI_RUNTIME_DIR/bin/node" ] && node_meets_minimum "$POCLI_RUNTIME_DIR/bin/node"; then
    selected_node="$POCLI_RUNTIME_DIR/bin/node"
    log_ok "Using managed Node.js $("$selected_node" --version)"
  elif command -v node >/dev/null 2>&1 && node_meets_minimum "$(command -v node)"; then
    selected_node=$(command -v node)
    log_ok "System Node.js $("$selected_node" --version) satisfies >= ${POCLI_MIN_NODE_MAJOR}.${POCLI_MIN_NODE_MINOR}"
  else
    install_standalone_node "$arch"
    selected_node="$POCLI_RUNTIME_DIR/bin/node"
  fi

  # Optional system tool diagnostics
  if command -v git >/dev/null 2>&1; then
    log_ok "git detected ($(git --version))"
  else
    log_warn "git not found — install git so Developer & QA agents can manage repos/*.git"
  fi
  if command -v python3 >/dev/null 2>&1; then
    log_ok "python3 detected ($(python3 --version 2>&1))"
  else
    log_info "Optional: install python3 + python3-venv for autonomous QA Robot Framework suites"
  fi

  tmp_pkg_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_pkg_dir"' EXIT INT TERM
  tarball_file="$tmp_pkg_dir/pocli-linux.tar.gz"

  if [ -n "${POCLI_LOCAL_TARBALL:-}" ]; then
    log_info "Installing from local tarball: $POCLI_LOCAL_TARBALL"
    cp "$POCLI_LOCAL_TARBALL" "$tarball_file"
  else
    if [ "$POCLI_VERSION" = "latest" ]; then
      base_url="https://github.com/${POCLI_REPO}/releases/latest/download"
    else
      base_url="https://github.com/${POCLI_REPO}/releases/download/${POCLI_VERSION}"
    fi
    tarball_url="${base_url}/pocli-linux.tar.gz"
    sha_url="${base_url}/pocli-linux.tar.gz.sha256"

    log_info "Downloading POCLI release ($POCLI_VERSION) from GitHub Releases..."
    if ! curl -fsSL "$tarball_url" -o "$tarball_file"; then
      log_err "Failed to download $tarball_url"
      exit 1
    fi

    if curl -fsSL "$sha_url" -o "$tmp_pkg_dir/pocli-linux.tar.gz.sha256" 2>/dev/null; then
      if command -v sha256sum >/dev/null 2>&1; then
        expected=$(awk '{ print $1; exit }' "$tmp_pkg_dir/pocli-linux.tar.gz.sha256")
        actual=$(sha256sum "$tarball_file" | awk '{ print $1 }')
        if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
          log_err "SHA-256 verification failed for pocli-linux.tar.gz"
          exit 1
        fi
        log_ok "Verified SHA-256 checksum"
      fi
    fi
  fi

  mkdir -p "$(dirname "$POCLI_INSTALL_DIR")"
  rm -rf "${POCLI_INSTALL_DIR}.tmp"
  mkdir -p "${POCLI_INSTALL_DIR}.tmp"
  tar -xzf "$tarball_file" -C "${POCLI_INSTALL_DIR}.tmp"

  if [ ! -f "${POCLI_INSTALL_DIR}.tmp/dist/cli.js" ]; then
    log_err "Invalid release archive: dist/cli.js missing"
    exit 1
  fi
  chmod 0755 "${POCLI_INSTALL_DIR}.tmp/dist/cli.js"

  if [ ! -e "${POCLI_INSTALL_DIR}.tmp/node_modules" ]; then
    npm_bin="$(dirname "$selected_node")/npm"
    if [ -x "$npm_bin" ]; then
      log_info "Installing production Node dependencies..."
      (cd "${POCLI_INSTALL_DIR}.tmp" && "$npm_bin" ci --omit=dev --ignore-scripts >/dev/null 2>&1 || "$npm_bin" install --omit=dev --ignore-scripts >/dev/null 2>&1) || true
    fi
  fi

  rm -rf "$POCLI_INSTALL_DIR"
  mv "${POCLI_INSTALL_DIR}.tmp" "$POCLI_INSTALL_DIR"
  write_launcher

  rm -rf "$tmp_pkg_dir"
  trap - EXIT INT TERM

  installed_ver=$("$POCLI_BIN_DIR/pocli" --version 2>/dev/null || printf '%s' "$POCLI_VERSION")
  log_ok "Installed POCLI ($installed_ver) into $POCLI_INSTALL_DIR"
  log_ok "Created launcher binary at $POCLI_BIN_DIR/pocli"

  case ":$PATH:" in
    *":$POCLI_BIN_DIR:"*)
      log_ok "$POCLI_BIN_DIR is already in PATH"
      ;;
    *)
      printf '\n'
      log_warn "$POCLI_BIN_DIR is not in your PATH. Add it to ~/.bashrc or ~/.zshrc:"
      printf '  export PATH="%s:$PATH"\n' "$POCLI_BIN_DIR"
      ;;
  esac

  printf '\nNext steps:\n'
  printf '  pocli --help       # List all CLI commands\n'
  printf '  pocli auth status  # Configure your LLM provider API key\n'
  printf '  pocli              # Launch the fullscreen Command Center\n\n'
}

main "$@"
