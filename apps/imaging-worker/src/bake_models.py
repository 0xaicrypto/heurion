import sys
import time
from pathlib import Path

src_dir = Path(__file__).resolve().parent
if str(src_dir) not in sys.path:
    sys.path.insert(0, str(src_dir))

from model_registry import pull_model

MODELS = ['spleen_ct', 'brats_mri', 'lung_nodule_ct', 'wholebody_ct', 'prostate_mri']

def main():
    for m in MODELS:
        for attempt in range(3):
            try:
                print(f"Baking model {m} (attempt {attempt+1})...")
                pull_model(m)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"Warning: failed to bake {m} during build ({e}), will be pulled at runtime/deploy")
                else:
                    time.sleep(2)

if __name__ == "__main__":
    main()
