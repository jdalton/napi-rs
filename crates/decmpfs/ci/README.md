# decmpfs — local btrfs harness

The `btrfs` backend can only be exercised on a real btrfs filesystem. CI runs it
on an `ubuntu-24.04` runner; off-Linux (macOS / Windows) use this container.

```sh
docker build -f crates/decmpfs/ci/Dockerfile -t decmpfs-btrfs crates/decmpfs
docker run --rm --privileged decmpfs-btrfs
```

`--privileged` is required to loop-mount btrfs. The container provisions the
filesystems with [`btrfs-loopback.sh`](./btrfs-loopback.sh) — the same script the
CI `btrfs` job sources, so the two can't drift — and runs the btrfs integration
test against them. (The unit tests aren't btrfs-specific; CI runs them on Linux,
macOS, and Windows.)

Optimized to ~4.4 MB: a multi-stage build on musl (rust:alpine) produces a static,
upx-packed binary, and the runtime is `FROM scratch` — no OS rootfs. It holds
static busybox (the shell + mount/modprobe), `mkfs.btrfs` with its `ldd`'d
libraries, and the test binary. BuildKit cache mounts make rebuilds incremental so
libzstd's C build is compiled once.

The runtime's applet symlinks (in the Dockerfile) cover the tools the scripts
call; if `btrfs-loopback.sh` grows a new command, add it there.
