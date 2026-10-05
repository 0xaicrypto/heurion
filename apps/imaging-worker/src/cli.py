import os
import sys
from pathlib import Path

try:
    from .device import get_device_info
    from .engine import MONAIEngine, generate_synthetic_ct_volume
except (ImportError, ValueError):
    from device import get_device_info
    from engine import MONAIEngine, generate_synthetic_ct_volume

def main():
    print("=" * 60)
    print("🏥 Heurion 2.0 MONAI Medical Imaging Benchmark")
    print("=" * 60)
    
    info = get_device_info()
    print(f"• 加速计算硬件: {info.get('accelerator')}")
    print(f"• 架构平台: {info.get('platform')}")
    print(f"• 统一内存: {info.get('total_unified_ram_gb', 'N/A')} GB")
    print(f"• PyTorch 版本: {info.get('torch_version')}")
    print("-" * 60)
    
    print("⏳ 正在生成 3D 胸腹部高精度 CT 体素阵列 (64 x 128 x 128)...")
    vol, _ = generate_synthetic_ct_volume(shape=(64, 128, 128), spacing=(1.5, 0.8, 0.8))
    print(f"✓ 3D 体素生成完毕: shape={vol.shape}, HU 范围=[{vol.min():.1f}, {vol.max():.1f}]")
    
    print("⚡ 调度 M4 Pro Metal (MPS) GPU 执行 3D 病灶分割与 RECIST 1.1 量化...")
    engine = MONAIEngine()
    result = engine.analyze_volume(vol, spacing=(1.5, 0.8, 0.8), model_name="lung_nodule_segmenter")
    
    recist = result["recist_metrics"]
    duration = result["inference_duration_sec"]
    print(f"\n🎉 计算完成！总耗时: {duration} 秒")
    print(f"• 病灶最大横截面 (Key Slice): 第 #{recist['key_slice_index']} 层")
    print(f"• RECIST 1.1 最大长径: {recist['longest_diameter_mm']} mm")
    print(f"• 垂直短径: {recist['short_axis_mm']} mm")
    print(f"• 肿瘤体积: {recist['total_volume_cm3']} cm³")
    
    # Save key slice PNG to desktop
    desktop_png = Path.home() / "Desktop" / "heurion-monai-key-slice.png"
    import base64
    b64_data = result["key_slice_png_base64"].split(",", 1)[1]
    with open(desktop_png, "wb") as f:
        f.write(base64.b64decode(b64_data))
    print(f"\n📸 已生成带分割轮廓与 RECIST 标尺的高清关键截面图:")
    print(f"👉 {desktop_png} ({result['key_slice_png_size_bytes']} bytes)")
    print("=" * 60)

if __name__ == "__main__":
    main()
