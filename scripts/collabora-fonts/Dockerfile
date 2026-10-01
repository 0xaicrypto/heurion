# Collabora CODE 自建镜像（#4 spike 生产决策的 POC 落地）：注入中文字体 + Windows 字体替换规则
# + 自动保存提速（idlesave 15s / autosave 60s —— 评论驱动的触发链路依赖及时落盘）。
# CODE 官方镜像无 shell（不能 RUN apt），用 COPY 直接注文件。
FROM docker.io/collabora/code:latest

# Noto CJK（源：heurion2 容器 podman cp 而来）
COPY noto/ /usr/share/fonts/opentype/noto-cjk/

# fontconfig 替换：微软雅黑/宋体/黑体/等线... → Noto Sans/Serif CJK SC
COPY 62-heurion-cjk-aliases.conf /etc/fonts/conf.d/62-heurion-cjk-aliases.conf

# coolwsd 配置（基于官方默认改 autosave/idlesave）
COPY coolwsd.xml /etc/coolwsd/coolwsd.xml
