/**
 * #792: 滚动容器捕获 — DocEditor 外部更新回写与 writing-editor 气泡
 * Apply 曾各有一份逐字符重复的 DOM 上溯实现,统一到此处。
 * 找到最近的可滚动祖先,调用方在外部 DOM 变更（插入/重建）后恢复
 * scrollTop,把用户留在当前视口位置。
 */
export interface ScrollSnapshot {
  el: HTMLElement;
  top: number;
}

export function captureScrollContainer(start: HTMLElement | null | undefined): ScrollSnapshot | null {
  let el: HTMLElement | null = start ?? null;
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) {
      return { el, top: el.scrollTop };
    }
    el = el.parentElement;
  }
  return null;
}
