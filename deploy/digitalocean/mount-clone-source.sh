#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 BLOCK_DEVICE /mnt/firstmeasure-snapshots/SNAPSHOT_ID" >&2
  exit 2
fi

device="$(realpath "$1")"
mount_point="$2"
allowed_root="/mnt/firstmeasure-snapshots"

if [[ ! -b "$device" ]]; then
  echo "Not a block device: $device" >&2
  exit 2
fi
case "$mount_point" in
  "$allowed_root"/*) ;;
  *)
    echo "Clone snapshots must be mounted below $allowed_root." >&2
    exit 2
    ;;
esac
if findmnt --source "$device" >/dev/null 2>&1; then
  echo "Device is already mounted; refusing to change it." >&2
  findmnt --source "$device"
  exit 2
fi

filesystem="$(blkid -o value -s TYPE "$device")"
case "$filesystem" in
  ext4) mount_options="ro,noload,nodev,nosuid,noexec" ;;
  xfs) mount_options="ro,norecovery,nodev,nosuid,noexec" ;;
  *)
    echo "Unsupported snapshot filesystem '$filesystem'. Expected ext4 or xfs." >&2
    exit 2
    ;;
esac

install -d -m 0750 -o firstmeasure -g firstmeasure "$mount_point"
mount -t "$filesystem" -o "$mount_options" "$device" "$mount_point"

resolved_options="$(findmnt -n -o OPTIONS --target "$mount_point")"
if [[ ",$resolved_options," != *,ro,* ]]; then
  echo "Snapshot did not mount read-only; unmounting." >&2
  umount "$mount_point"
  exit 1
fi

echo "Mounted read-only clone source:"
findmnt --target "$mount_point"
