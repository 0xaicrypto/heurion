# Collabora CODE 自建镜像（#4 spike 生产决策的 POC 落地）：注入中文字体 + Windows 字体替换规则。
# CODE 官方镜像无 shell（不能 RUN apt），用 COPY 直接注文件。
FROM docker.io/collabora/code:latest

# Noto CJK（源：heurion2 容器 podman cp 而来，见 scripts/container.sh collabora 的注释）
COPY noto/ /usr/share/fonts/opentype/noto-cjk/

# fontconfig 替换：微软雅黑/宋体/黑体/等线... → Noto Sans/Serif CJK SC
COPY 62-heurion-cjk-aliases.conf /etc/fonts/conf.d/62-heurion-cjk-aliases.conf
