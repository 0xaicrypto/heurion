FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
# 某些依赖(全为 >= 浮动版本)在新版本缺多架构 wheel 时需要源码编译,
# slim 基础镜像没有 cc → meson 报 "Unknown compiler"。装最小工具链兜底。
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc g++ pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt
COPY stats_core.py main.py ./
EXPOSE 8005
CMD ["python", "main.py"]
