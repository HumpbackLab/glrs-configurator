#!/usr/bin/env bash

# Sync a GitHub Release and all of its assets to a Gitee Release.
#
# Requirements:
#   curl, jq, base64
#
# Required environment variable:
#   GITEE_TOKEN  Gitee personal access token with permission to manage Releases
#                 and attachments in the destination repository.
#
# Basic usage:
#   export GITEE_TOKEN="your-gitee-token"
#   ./scripts/sync-github-release-to-gitee.sh \
#     HumpbackLab/glrs-configurator \
#     ncer/glrs-configurator \
#     v0.1.0
#
# Sync the latest GitHub Release:
#   ./scripts/sync-github-release-to-gitee.sh \
#     HumpbackLab/glrs-configurator \
#     ncer/glrs-configurator
#
# Publish a stable latest.json for the Tauri updater:
#   ./scripts/sync-github-release-to-gitee.sh \
#     HumpbackLab/glrs-configurator \
#     ncer/glrs-configurator \
#     latest
#
#   The manifest will be available at:
#   https://gitee.com/ncer/glrs-configurator/raw/master/updater/latest.json
#
# Optional environment variables:
#   GITHUB_TOKEN              GitHub token for private repositories/API limits.
#   GITEE_TARGET_COMMITISH    Override the destination branch or commit.
#   GITEE_MANIFEST_BRANCH     Publish latest.json to this Gitee branch; default: master.
#   GITEE_MANIFEST_PATH       Manifest path; default: updater/latest.json.
#   REWRITE_LATEST_JSON       Rewrite download URLs to Gitee; default: 1.
#   GITEE_MAX_ASSET_BYTES     Per-file limit; default: 50000000 (Gitee community limit).
#   REQUIRED_ASSET_SUFFIXES   Comma-separated suffixes that must exist, e.g. .apk.
#   SKIP_OVERSIZE_ASSETS      Skip files above the limit instead of failing; default: 0.
#
# The destination repository must be public for unauthenticated application
# updates. Never commit access tokens to the repository.

set -Eeuo pipefail

on_error() {
  local status=$?
  local line=${BASH_LINENO[0]}
  echo "error: command failed at line $line (exit $status)" >&2
  exit "$status"
}

trap on_error ERR

usage() {
  cat <<'EOF'
Usage:
  GITEE_TOKEN=... sync-github-release-to-gitee.sh <github-owner/repo> <gitee-owner/repo> [tag]

Arguments:
  github-owner/repo  Source GitHub repository.
  gitee-owner/repo   Destination Gitee repository.
  tag                Release tag to sync. Defaults to "latest".

Environment:
  GITEE_TOKEN                 Required Gitee personal access token.
  GITHUB_TOKEN                Optional; required for private GitHub repositories.
  REWRITE_LATEST_JSON         Rewrite updater download URLs to Gitee (default: 1).
  GITEE_TARGET_COMMITISH      Branch/commit used when Gitee needs to create the tag.
  GITEE_MANIFEST_BRANCH       Also publish latest.json to this Gitee branch (default: master).
  GITEE_MANIFEST_PATH         Stable manifest path (default: updater/latest.json).
  GITEE_MAX_ASSET_BYTES       Per-file limit (default: 50000000, Gitee community limit).
  REQUIRED_ASSET_SUFFIXES     Comma-separated GitHub asset suffixes that must exist.
  SKIP_EXISTING_ASSETS        Skip same-name, same-size non-manifest files (default: 0).
  SKIP_OVERSIZE_ASSETS        Skip assets above GITEE_MAX_ASSET_BYTES (default: 0).

The destination repository must be public if an unauthenticated desktop app will
download updates from it. Existing attachments with the same filename are replaced.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

[[ ${1:-} != -h && ${1:-} != --help ]] || { usage; exit 0; }
[[ $# -ge 2 && $# -le 3 ]] || { usage >&2; exit 2; }

require_command curl
require_command jq
require_command base64
require_command sed
require_command tr

github_repo=$1
gitee_repo=$2
requested_tag=${3:-latest}

[[ $github_repo == */* && $github_repo != */*/* ]] || die "invalid GitHub repository: $github_repo"
[[ $gitee_repo == */* && $gitee_repo != */*/* ]] || die "invalid Gitee repository: $gitee_repo"
[[ -n ${GITEE_TOKEN:-} ]] || die "GITEE_TOKEN is required"

rewrite_latest=${REWRITE_LATEST_JSON:-1}
manifest_branch=${GITEE_MANIFEST_BRANCH:-master}
manifest_path=${GITEE_MANIFEST_PATH:-updater/latest.json}
max_asset_bytes=${GITEE_MAX_ASSET_BYTES:-50000000}
skip_existing=${SKIP_EXISTING_ASSETS:-0}
skip_oversize=${SKIP_OVERSIZE_ASSETS:-0}
required_asset_suffixes=${REQUIRED_ASSET_SUFFIXES:-}

[[ $rewrite_latest == 0 || $rewrite_latest == 1 ]] || die "REWRITE_LATEST_JSON must be 0 or 1"
[[ $skip_existing == 0 || $skip_existing == 1 ]] || die "SKIP_EXISTING_ASSETS must be 0 or 1"
[[ $skip_oversize == 0 || $skip_oversize == 1 ]] || die "SKIP_OVERSIZE_ASSETS must be 0 or 1"
[[ $max_asset_bytes =~ ^[0-9]+$ ]] || die "GITEE_MAX_ASSET_BYTES must be an integer"
[[ $manifest_path =~ ^[A-Za-z0-9._/-]+$ ]] || die "GITEE_MANIFEST_PATH contains unsupported characters"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
auth_file="$tmp_dir/gitee-auth-header"
umask 077
printf 'Authorization: token %s\n' "$GITEE_TOKEN" > "$auth_file"
gitee_auth=(--header @"$auth_file")

github_headers=(
  -H "Accept: application/vnd.github+json"
  -H "X-GitHub-Api-Version: 2022-11-28"
  -H "User-Agent: github-to-gitee-release-sync"
)
if [[ -n ${GITHUB_TOKEN:-} ]]; then
  github_headers+=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi

if [[ $requested_tag == latest ]]; then
  github_release_url="https://api.github.com/repos/$github_repo/releases/latest"
else
  encoded_tag=$(jq -rn --arg value "$requested_tag" '$value | @uri')
  github_release_url="https://api.github.com/repos/$github_repo/releases/tags/$encoded_tag"
fi

echo "Fetching GitHub release: $github_repo ($requested_tag)"
curl --fail-with-body --silent --show-error --location \
  "${github_headers[@]}" "$github_release_url" > "$tmp_dir/github-release.json"

[[ $(jq -r '.draft' "$tmp_dir/github-release.json") != true ]] || die "draft GitHub releases cannot be mirrored"

if [[ -n $required_asset_suffixes ]]; then
  IFS=',' read -r -a required_suffixes <<< "$required_asset_suffixes"
  for suffix in "${required_suffixes[@]}"; do
    [[ -n $suffix ]] || die "REQUIRED_ASSET_SUFFIXES contains an empty suffix"
    jq -e --arg suffix "$suffix" --argjson max "$max_asset_bytes" \
      'any(.assets[]?; (.name | endswith($suffix)) and .size <= $max)' \
      "$tmp_dir/github-release.json" >/dev/null \
      || die "GitHub release does not contain a required *$suffix asset within the Gitee size limit"
  done
fi

tag=$(jq -er '.tag_name' "$tmp_dir/github-release.json")
release_name=$(jq -r '.name // .tag_name' "$tmp_dir/github-release.json")
release_body=$(jq -r '.body // ""' "$tmp_dir/github-release.json")
prerelease=$(jq -r '.prerelease // false' "$tmp_dir/github-release.json")
target_commitish=${GITEE_TARGET_COMMITISH:-$(jq -r '.target_commitish // "master"' "$tmp_dir/github-release.json")}
encoded_tag=$(jq -rn --arg value "$tag" '$value | @uri')
gitee_api="https://gitee.com/api/v5/repos/$gitee_repo"

gitee_status=$(curl --silent --show-error --output "$tmp_dir/gitee-release.json" \
  --write-out '%{http_code}' "${gitee_auth[@]}" \
  "$gitee_api/releases/tags/$encoded_tag")
if [[ $gitee_status == 200 && $(jq -r 'type' "$tmp_dir/gitee-release.json") == null ]]; then
  gitee_status=404
fi

release_form=(
  --data-urlencode "tag_name=$tag"
  --data-urlencode "name=$release_name"
  --data-urlencode "body=$release_body"
  --data-urlencode "prerelease=$prerelease"
  --data-urlencode "target_commitish=$target_commitish"
)

case $gitee_status in
  200)
    release_id=$(jq -er '.id' "$tmp_dir/gitee-release.json")
    echo "Updating Gitee release: $gitee_repo ($tag)"
    curl --fail-with-body --silent --show-error --request PATCH \
      "${gitee_auth[@]}" "${release_form[@]}" "$gitee_api/releases/$release_id" > "$tmp_dir/gitee-release.json"
    ;;
  404)
    echo "Creating Gitee release: $gitee_repo ($tag)"
    curl --fail-with-body --silent --show-error --request POST \
      "${gitee_auth[@]}" "${release_form[@]}" "$gitee_api/releases" > "$tmp_dir/gitee-release.json"
    release_id=$(jq -er '.id' "$tmp_dir/gitee-release.json")
    ;;
  *)
    cat "$tmp_dir/gitee-release.json" >&2
    die "Gitee release lookup returned HTTP $gitee_status"
    ;;
esac

curl --fail-with-body --silent --show-error --get \
  "${gitee_auth[@]}" \
  --data-urlencode "per_page=100" \
  "$gitee_api/releases/$release_id/attach_files" > "$tmp_dir/gitee-assets.json"

manifest_file=
while IFS= read -r encoded_asset; do
  asset=$(printf '%s' "$encoded_asset" | base64 --decode)
  asset_name=$(jq -r '.name' <<< "$asset")
  asset_url=$(jq -r '.browser_download_url' <<< "$asset")
  asset_size=$(jq -r '.size' <<< "$asset")

  if (( asset_size > max_asset_bytes )); then
    if [[ $skip_oversize == 1 ]]; then
      echo "Skipping oversized Gitee asset: $asset_name ($asset_size bytes; limit $max_asset_bytes)"
      continue
    fi
    die "$asset_name is $asset_size bytes; Gitee limit is $max_asset_bytes"
  fi

  existing_size=$(jq -r --arg name "$asset_name" '.[] | select(.name == $name) | .size' "$tmp_dir/gitee-assets.json" | head -1)
  if [[ $skip_existing == 1 && $asset_name != latest.json && $existing_size == "$asset_size" ]]; then
    echo "Skipping unchanged Gitee asset: $asset_name"
    continue
  fi

  local_file="$tmp_dir/$asset_name"
  echo "Downloading GitHub asset: $asset_name"
  curl --fail-with-body --silent --show-error --location \
    "${github_headers[@]}" "$asset_url" --output "$local_file"

  if [[ $asset_name == latest.json && $rewrite_latest == 1 ]]; then
    gitee_download_base="https://gitee.com/$gitee_repo/releases/download/$encoded_tag"
    asset_url_map=$(jq --arg base "$gitee_download_base" '
      [.assets[] | {key: .url, value: ($base + "/" + (.name | @uri))}] | from_entries
    ' "$tmp_dir/github-release.json")
    jq --arg base "$gitee_download_base" --argjson asset_urls "$asset_url_map" '
      .platforms |= with_entries(
        .value.url as $source_url
        | .value.url = (
            $asset_urls[$source_url]
            // ($source_url | sub("^https://github\\.com/[^/]+/[^/]+/releases/download/[^/]+"; $base))
          )
      )
    ' "$local_file" > "$tmp_dir/latest.rewritten.json"
    local_file="$tmp_dir/latest.rewritten.json"
    manifest_file=$local_file
  fi

  while IFS= read -r existing_id; do
    [[ -z $existing_id ]] || {
      echo "Replacing existing Gitee asset: $asset_name"
      curl --fail-with-body --silent --show-error --request DELETE \
        "${gitee_auth[@]}" \
        "$gitee_api/releases/$release_id/attach_files/$existing_id" >/dev/null
    }
  done < <(jq -r --arg name "$asset_name" '.[] | select(.name == $name) | .id' "$tmp_dir/gitee-assets.json")

  echo "Uploading Gitee asset: $asset_name"
  curl --fail-with-body --silent --show-error --request POST \
    "${gitee_auth[@]}" \
    --form "file=@$local_file;filename=$asset_name" \
    "$gitee_api/releases/$release_id/attach_files" >/dev/null
done < <(jq -r '.assets[] | @base64' "$tmp_dir/github-release.json")

if [[ -n $manifest_branch ]]; then
  [[ -n $manifest_file ]] || die "latest.json was not present in the GitHub release"
  encoded_path=$(jq -rn --arg value "$manifest_path" '$value | @uri' | sed 's/%2F/\//g')
  content_url="$gitee_api/contents/$encoded_path"
  content_status=$(curl --silent --show-error --output "$tmp_dir/gitee-content.json" \
    --write-out '%{http_code}' --get "${gitee_auth[@]}" \
    --data-urlencode "ref=$manifest_branch" \
    "$content_url")
  manifest_base64=$(base64 < "$manifest_file" | tr -d '\n')
  content_form=(
    --data-urlencode "content=$manifest_base64"
    --data-urlencode "message=Update mirrored release manifest for $tag"
    --data-urlencode "branch=$manifest_branch"
  )

  case $content_status in
    200)
      content_sha=$(jq -er '.sha' "$tmp_dir/gitee-content.json")
      content_form+=(--data-urlencode "sha=$content_sha")
      curl --fail-with-body --silent --show-error --request PUT \
        "${gitee_auth[@]}" "${content_form[@]}" "$content_url" >/dev/null
      ;;
    404)
      curl --fail-with-body --silent --show-error --request POST \
        "${gitee_auth[@]}" "${content_form[@]}" "$content_url" >/dev/null
      ;;
    *)
      cat "$tmp_dir/gitee-content.json" >&2
      die "Gitee manifest lookup returned HTTP $content_status"
      ;;
  esac

  echo "Stable updater manifest: https://raw.giteeusercontent.com/$gitee_repo/raw/$manifest_branch/$manifest_path"
fi

echo "Release sync complete: https://gitee.com/$gitee_repo/releases/tag/$encoded_tag"
