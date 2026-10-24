#!/bin/sh
# 容器入口:命名卷首次挂载时属于 root,交还给构建用户后再降权执行。
# 只处理容器内部路径,不触碰只读挂载的源码(/src)和输出目录(/out)。
set -eu

uid="${HOST_UID:-1000}"
gid="${HOST_GID:-1000}"

for dir in /cache/gradle /cache/home /build; do
    mkdir -p "$dir"
    if [ "$(stat -c %u "$dir")" != "$uid" ]; then
        chown -R "$uid:$gid" "$dir"
    fi
done

exec gosu "$uid:$gid" "$@"
