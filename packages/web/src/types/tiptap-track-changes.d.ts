/**
 * tiptap-track-changes v0.2.1 的命令类型补齐。
 *
 * 该包运行时(addCommands)注册了 setTrackChangesMode/acceptAll/rejectAll/
 * acceptChange/rejectChange 等顶层命令,但其 .d.ts 只增强了 insertion/deletion
 * 两组 mark 命令 — 调用侧只能 `(editor.commands as any).xxx()`。
 * 此处按 node_modules/tiptap-track-changes/dist/index.js 的实际注册对齐
 * @tiptap/core 的 Commands 接口(与包内 insertion/deletion 增强同机制合并;
 * Commands 接口按「组名: { 命令名: 签名 }」嵌套,顶层命令组名=命令名)。
 */
import type { ChangeAuthor, TrackChangesMode } from 'tiptap-track-changes'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    setTrackChangesMode: {
      setTrackChangesMode: (mode: TrackChangesMode) => ReturnType
    }
    setEditMode: {
      setEditMode: () => ReturnType
    }
    setSuggestMode: {
      setSuggestMode: () => ReturnType
    }
    setViewMode: {
      setViewMode: () => ReturnType
    }
    setTrackChangesAuthor: {
      setTrackChangesAuthor: (author: ChangeAuthor) => ReturnType
    }
    acceptChange: {
      acceptChange: (changeId: string) => ReturnType
    }
    rejectChange: {
      rejectChange: (changeId: string) => ReturnType
    }
    acceptAll: {
      acceptAll: () => ReturnType
    }
    rejectAll: {
      rejectAll: () => ReturnType
    }
  }
}
