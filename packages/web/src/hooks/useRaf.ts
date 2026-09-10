import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * #949 — RAF 帧率合帧状态：高频更新（流式 chunk/拖动上报）每帧最多
 * 应用一次最新值；enabled=false 时立即同步并取消挂起帧。
 * 抽自 LlmContent.tsx / DocEditor.tsx 的逐行重复实现（#797/#927 同模式）。
 */
export function useRafValue<T>(source: T, enabled: boolean): T {
  const [display, setDisplay] = useState(source)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setDisplay(source)
      return
    }
    // 合帧：已挂起帧未应用前不再排新帧（最新值在下一帧生效）。
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      setDisplay(source)
    })
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
  }, [source, enabled])

  return display
}

/**
 * #949 — ref 保存最新回调（防闭包过期）+ RAF 合帧上报：回调每帧最多
 * 触发一次，参数取最后一次调用值。抽自 DocEditor 选区上报模式。
 * 回调可为 undefined（调用安全空转）。
 */
export function useRafCallback<Args extends unknown[]>(cb: ((...args: Args) => void) | undefined): (...args: Args) => void {
  const cbRef = useRef(cb)
  cbRef.current = cb
  const rafRef = useRef<number | null>(null)
  const latestArgsRef = useRef<Args | null>(null)

  const report = useCallback((...args: Args) => {
    latestArgsRef.current = args
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      cbRef.current?.(...latestArgsRef.current!)
    })
  }, [])

  useEffect(() => () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [])

  return report
}
