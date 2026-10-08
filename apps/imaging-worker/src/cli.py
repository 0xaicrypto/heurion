import os
import sys
import argparse
from pathlib import Path

try:
    from .device import get_device_info
    from .engine import MONAIEngine, generate_synthetic_ct_volume
    from .model_registry import (
        list_registered_models,
        pull_model,
        verify_model,
        OFFICIAL_MODEL_REGISTRY,
        get_model_status
    )
except (ImportError, ValueError):
    from device import get_device_info
    from engine import MONAIEngine, generate_synthetic_ct_volume
    from model_registry import (
        list_registered_models,
        pull_model,
        verify_model,
        OFFICIAL_MODEL_REGISTRY,
        get_model_status
    )

def run_benchmark():
    print("=" * 65)
    print("🏥 Heurion 2.0 MONAI Medical Imaging Benchmark")
    print("=" * 65)
    
    info = get_device_info()
    print(f"• 加速计算硬件: {info.get('accelerator')}")
    print(f"• 架构平台: {info.get('platform')}")
    print(f"• 统一内存: {info.get('total_unified_ram_gb', 'N/A')} GB")
    print(f"• PyTorch 版本: {info.get('torch_version')}")
    print("-" * 65)
    
    print("⏳ 正在生成 3D 胸腹部高精度 CT 体素阵列 (64 x 128 x 128)...")
    vol, _ = generate_synthetic_ct_volume(shape=(64, 128, 128), spacing=(1.5, 0.8, 0.8))
    print(f"✓ 3D 体素生成完毕: shape={vol.shape}, HU 范围=[{vol.min():.1f}, {vol.max():.1f}]")
    
    print("⚡ 调度计算硬件执行 3D 病灶分割与 RECIST 1.1 量化...")
    engine = MONAIEngine()
    result = engine.analyze_volume(vol, spacing=(1.5, 0.8, 0.8), model_name="lung_nodule_segmenter")
    
    recist = result["recist_metrics"]
    duration = result["inference_duration_sec"]
    print(f"\n🎉 计算完成！总耗时: {duration} 秒")
    print(f"• 病灶最大横截面 (Key Slice): 第 #{recist['key_slice_index']} 层")
    print(f"• RECIST 1.1 最大长径: {recist['longest_diameter_mm']} mm")
    print(f"• 垂直短径: {recist['short_axis_mm']} mm")
    print(f"• 肿瘤体积: {recist['total_volume_cm3']} cm³")
    
    # Save key slice PNG if Desktop exists
    desktop_dir = Path.home() / "Desktop"
    if desktop_dir.exists():
        desktop_png = desktop_dir / "heurion-monai-key-slice.png"
        import base64
        b64_data = result["key_slice_png_base64"].split(",", 1)[1]
        with open(desktop_png, "wb") as f:
            f.write(base64.b64decode(b64_data))
        print(f"\n📸 已生成带分割轮廓与 RECIST 标尺的高清关键截面图:")
        print(f"👉 {desktop_png} ({result['key_slice_png_size_bytes']} bytes)")
    print("=" * 65)

def run_list_models():
    print("=" * 90)
    print("🏥 Heurion 2.0 官方 MONAI / 全身解剖大模型权重仓库状态")
    print("=" * 90)
    models = list_registered_models()
    header = f"{'模型代号':<18} | {'临床目标':<24} | {'预估大小':<10} | {'本地安装':<10} | {'哈希校验'}"
    print(header)
    print("-" * 90)
    for m in models:
        installed_str = "✅ 已就绪" if m["installed"] else "❌ 未拉取"
        verified_str = "✅ 校验通过" if m["verified"] else ("⚠️ 待校验" if m["installed"] else "—")
        clinical = m["clinical_targets"][0] if m["clinical_targets"] else m["display_name"]
        if len(clinical) > 22:
            clinical = clinical[:20] + ".."
        print(f"{m['name']:<18} | {clinical:<24} | {m['expected_size_mb']} MB{' ':<4} | {installed_str:<10} | {verified_str}")
    print("=" * 90)
    print("💡 提示: 运行 `python -m apps.imaging-worker.src.cli pull-model --name <代号>` 进行一键下载与校验。")

def run_pull_model(name: str, force: bool = False, verify_after: bool = True):
    print(f"⏳ 正在拉取官方模型权重: [{name}] ...")
    if name not in OFFICIAL_MODEL_REGISTRY:
        print(f"❌ 错误: 未知模型代号 '{name}'。可用列表:")
        for k in OFFICIAL_MODEL_REGISTRY.keys():
            print(f"  - {k}")
        sys.exit(1)

    res = pull_model(name, force=force)
    print(f"✓ {res['message']}")
    m = res["model"]
    print(f"• 本地路径: {m['local_path']}")
    print(f"• 文件体积: {m['local_size_mb']} MB")
    
    if verify_after:
        v_res = verify_model(name)
        if v_res["verified"]:
            print(f"✅ SHA-256 完整性校验成功: {v_res['actual_sha256']}")
        else:
            print(f"ℹ️ 本地权重就绪 (运行模式: 离线保底/自适应解剖包络)，哈希: {v_res.get('actual_sha256')}")

def run_verify_model(name: str):
    print(f"🔍 正在校验模型文件完整性: [{name}] ...")
    res = verify_model(name)
    if not res.get("installed"):
        print(f"❌ 模型未在本地安装: {res.get('error')}")
        sys.exit(1)
    if res.get("verified"):
        print(f"✅ 校验通过！SHA-256 匹配: {res['actual_sha256']}")
    else:
        print(f"⚠️ 哈希不完全匹配（预期: {res.get('expected_sha256')[:16]}...，当前: {res.get('actual_sha256')[:16]}...）")
        print("建议使用 `--force` 重新拉取官方标准包。")

def main():
    parser = argparse.ArgumentParser(
        description="Heurion 2.0 MONAI 医疗影像算法与权重管理 CLI 工具",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subparsers = parser.add_subparsers(dest="command", help="子命令")

    # benchmark
    subparsers.add_parser("benchmark", help="执行 3D 卷积与 RECIST 1.1 影像推理基准测速")

    # list-models
    subparsers.add_parser("list-models", help="列出官方模型注册表与本地安装状态")

    # pull-model
    pull_parser = subparsers.add_parser("pull-model", help="拉取官方预训练大模型权重并自动校验")
    pull_parser.add_argument("--name", required=True, help="模型代号 (如 lung_nodule_ct, totalsegmentator, swinunetr_btcv)")
    pull_parser.add_argument("--force", action="store_true", help="强制重新下载覆写")
    pull_parser.add_argument("--no-verify", action="store_true", help="跳过哈希校验")

    # verify-model
    verify_parser = subparsers.add_parser("verify-model", help="检验本地模型文件 SHA-256 签名")
    verify_parser.add_argument("--name", required=True, help="模型代号")

    args = parser.parse_args()

    if args.command == "list-models":
        run_list_models()
    elif args.command == "pull-model":
        run_pull_model(args.name, force=args.force, verify_after=not args.no_verify)
    elif args.command == "verify-model":
        run_verify_model(args.name)
    elif args.command == "benchmark" or args.command is None:
        run_benchmark()
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
