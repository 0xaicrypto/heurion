# Heurion 2.0 MONAI Medical Imaging Worker

High-performance Medical Imaging & 3D Volumetric Inference Microservice for Heurion 2.0.

## Supported Hardware Accelerators
- **Apple Silicon (MPS)**: Native Metal Performance Shaders GPU acceleration on M1/M2/M3/M4 (Pro/Max/Ultra) with zero-copy unified memory.
- **NVIDIA CUDA**: Standard data-center and workstation GPU acceleration with FP16/AMP.
- **CPU**: Multi-core high-throughput AVX-512 / AVX2 inference (DigitalOcean Dedicated CPU Droplets).

## Quick Start
```bash
# Run tests
uv run --python 3.12 pytest tests

# Start microservice
uv run --python 3.12 uvicorn src.server:app --port 8004
```
