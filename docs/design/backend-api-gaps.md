# 后端缺失/建议添加的 API

以下是实现 Web UI 功能时发现的后端缺失或需改进的 API：

## 1. 患者创建 API（手动注册）

- **现状**: 后端有 `POST /api/v1/dicom/patients/register-manual` 可用 ✓
- **但**: Web UI 的"新建患者"按钮尚未接入，需要 UI 实现

## 2. 患者列表 API 响应格式

- **现状**: `GET /api/v1/dicom/patients/full` 直接返回 `Patient[]` 数组 ✓
- **建议**: 返回 `{ patients: Patient[], total: number }` 以支持分页

## 3. 今日概览 API 数据来源

- **现状**: 使用 `GET /api/v1/agent/state`（memory_count, anchor_count 等）
- **缺少**: 
  - 患者统计 API（活跃患者数、待处理报告数等）
  - `today.activePatients` 目前映射为 `memory_count`，语义不完全匹配

## 4. 搜索患者 API

- **状态**: ❌ 缺失
- **前端** 在患者列表侧边栏有搜索框，但目前只能前端过滤已加载列表
- **建议**: `GET /api/v1/dicom/patients/full?q=keyword`

## 5. 文件/上传列表 API

- **状态**: 已有 `GET /api/v1/files/list` 和 `POST /api/v1/files/upload`
- **尚需接入 UI**

## 6. Chat History API

- **状态**: 已有 `GET /api/v1/agent/messages?session_id=...`
- **尚需接入 UI**: 患者对话页加载历史消息

## 7. Session API

- **状态**: 已有 `GET /api/v1/sessions`, `POST /api/v1/sessions`, `DELETE`
- **尚需接入 UI**: 建 session 后在 header 中显示，支持多 session 切换

## 低优先级

- 患者影像列表/预览 API（DICOM 相关，后端已有，前端未接入）
- 记忆网络可视化 API（`/api/v1/memory` 路由，前端未接入）
- 研究报告导出 API（`/api/v1/report/pdf`）
