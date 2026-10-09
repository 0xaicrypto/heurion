# Heurion 2.0 医学影像微服务镜像 (MONAI & PyTorch CPU 优化版)
# 职责：3D 卷积分割、气道血管匹配、支气管扩张量化、粘液栓定位、RECIST 1.1 靶病灶测量
# 构建上下文是仓库根目录：docker build -f apps/imaging-worker/Dockerfile .

FROM python:3.12-slim-bookworm

# 复制官方 uv 二进制工具以实现极速依赖安装
COPY --from=ghcr.io/astral-sh/uv:0.5.26 /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8004 \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2 \
    VECLIB_MAXIMUM_THREADS=2 \
    NUMEXPR_NUM_THREADS=2 \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# 0. 安装系统字体（支持中文医学 HUD 标注与标尺绘制）
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-dejavu-core fonts-wqy-microhei && \
    rm -rf /var/lib/apt/lists/*

# 1. 预先安装 CPU 专用的 PyTorch 轮子（强制剥离无用 CUDA 驱动，缩减镜像体积 4GB 以上）
RUN uv venv /opt/venv && \
    uv pip install --no-cache --python /opt/venv/bin/python \
      --index-url https://download.pytorch.org/whl/cpu \
      "torch>=2.2.0"

# 2. 安装其余医学计算与 API 依赖（MONAI, NiBabel, SciPy, NumPy, FastAPI 等）
COPY apps/imaging-worker/pyproject.toml ./apps/imaging-worker/
RUN uv pip install --no-cache --python /opt/venv/bin/python \
      "fastapi>=0.115.0" \
      "uvicorn>=0.34.0" \
      "pydantic>=2.10.0" \
      "monai>=1.3.0" \
      "pydicom>=2.4.0" \
      "nibabel>=5.2.0" \
      "numpy>=1.26.0" \
      "pillow>=10.2.0" \
      "scipy>=1.12.0" \
      "einops>=0.7.0" \
      "python-multipart>=0.0.32"

# 3. 复制代码与创建模型和数据目录
COPY apps/imaging-worker/src /app/apps/imaging-worker/src
RUN mkdir -p /app/apps/imaging-worker/data /app/models

ENV HEURION_MODEL_DIR=/app/models

# 预先下载核心基座临床模型（脾脏、脑胶质瘤、肺结节、全身多器官、前列腺、SwinUNETR）
# 确保生产环境容器无需等待网络拉取即可立即执行真实 3D 卷积推理
RUN python3 /app/apps/imaging-worker/src/bake_models.py

WORKDIR /app/apps/imaging-worker

# 4. 创建非 root 用户运行，确保隔离安全性并赋予模型目录与数据目录写权限
RUN useradd -m -u 1000 imaginguser && \
    chown -R imaginguser:imaginguser /app /opt/venv

USER imaginguser
EXPOSE 8004

# 5. 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8004/health')"

# 6. 单 Worker 启动，控制最大并发防止 3D 体素操作突发内存翻倍
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8004", "--workers", "1"]
