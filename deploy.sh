#!/usr/bin/env bash
set -euo pipefail

usage() {
    printf 'Usage: %s [--dry-run]\n' "${0##*/}"
}

dry_run=false
case "${1:-}" in
    '') ;;
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
esac
if (( $# > 1 )); then
    usage >&2
    exit 2
fi

pages=(index.html cv.html researchline.html)
repo=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
head=$(git -C "$repo" rev-parse --verify HEAD)
changes=$(git -C "$repo" status --porcelain --untracked-files=all --ignored -- "${pages[@]}" assets)
if [[ -n "$changes" ]]; then
    printf 'Refusing deployment: commit or remove changes in %s and assets/ first.\n%s\n' "${pages[*]}" "$changes" >&2
    exit 1
fi

# Export the pinned commit so edits made during transfer cannot reach the server.
snapshot=$(mktemp -d "${TMPDIR:-/tmp}/linenone-deploy.XXXXXX")
trap 'rm -rf -- "$snapshot"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$repo" archive "$head" -- "${pages[@]}" assets | tar -xf - -C "$snapshot"
for page in "${pages[@]}"; do
    if [[ ! -f "$snapshot/$page" ]]; then
        printf 'Refusing deployment: HEAD must contain %s.\n' "$page" >&2
        exit 1
    fi
done
if [[ ! -d "$snapshot/assets" ]] ||
    [[ -n "$(find "$snapshot" -type l -print)" ]]; then
    printf 'Refusing deployment: HEAD must contain assets/ and no symlinks.\n' >&2
    exit 1
fi

# One remote process owns the directory lock, permission change, transfer and cleanup.
# Dry runs use the same lock and checks but never chmod the destination.
remote_script=$(cat <<'REMOTE'
set -eu
dry_run=$1
shift
target=/volume1/web/linenone-site
if [ ! -d "$target" ] || [ -L "$target" ] ||
    [ -L "$target/assets" ] || [ -L "$target/index.html" ] ||
    [ -L "$target/cv.html" ] || [ -L "$target/researchline.html" ]; then
    echo "Refusing deployment: unexpected destination path." >&2
    exit 1
fi
if [ "$(stat -c %a "$target")" != 555 ]; then
    echo "Refusing deployment: destination permissions must be 555." >&2
    exit 1
fi
restore() {
    result=$?
    trap - 0
    if ! chmod 555 "$target"; then
        echo "Failed to restore destination permissions to 555." >&2
        result=1
    fi
    exit "$result"
}
if [ "$dry_run" = false ]; then
    trap restore 0
    trap "exit 129" HUP
    trap "exit 130" INT
    trap "exit 143" TERM
    chmod u+w "$target"
fi
/usr/bin/rsync "$@"
REMOTE
)
# openrsync and rsync tokenize --rsync-path differently. Quote once at the SSH boundary.
export LINENONE_DEPLOY_REMOTE="$remote_script" LINENONE_DEPLOY_DRY_RUN="$dry_run"
cat > "$snapshot/ssh-wrapper" <<'SSH'
#!/usr/bin/env bash
set -euo pipefail
host=$1
shift
[[ $host == synology && $1 == rsync ]] || exit 2
shift
quote() {
    printf "'%s'" "${1//\'/\'\\\'\'}"
}
command="flock -n /volume1/web/linenone-site sh -c $(quote "$LINENONE_DEPLOY_REMOTE") sh $LINENONE_DEPLOY_DRY_RUN"
for arg in "$@"; do
    command+=" $(quote "$arg")"
done
exec ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 "$host" "$command"
SSH
chmod +x "$snapshot/ssh-wrapper"
args=(-rc --delete --itemize-changes -e "\"$snapshot/ssh-wrapper\"")
if "$dry_run"; then
    args+=(--dry-run)
fi
printf 'Deploying commit %s to synology:/volume1/web/linenone-site/ (dry-run=%s)\n' "$head" "$dry_run"
# Explicit sources limit --delete to assets/; unrelated top-level files stay intact.
rsync "${args[@]}" -- "${pages[@]/#/$snapshot/}" "$snapshot/assets" synology:/volume1/web/linenone-site/
printf 'Deployment finished (dry-run=%s).\n' "$dry_run"
