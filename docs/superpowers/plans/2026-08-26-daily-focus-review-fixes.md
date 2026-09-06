# 每日聚焦评审修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复每日聚焦正式冻结、T+3 结算、策略评分、来源审计和前端契约问题，使 `daily-focus-v1` 的生产语义与已确认设计一致。

**Architecture:** 保持纯策略、编排服务、SQLite 持久化和独立 API 的既有边界。时间相关判断通过显式交易日、特征截止和行情水位输入完成；策略继续保持无数据库、网络和时钟依赖；所有冻结复算所需参考值进入不可变审计载荷。

**Tech Stack:** TypeScript、Node `node:test`/`tsx`、Node SQLite、React、Vite。

---

### Task 1: 收盘冻结与 T+3 结算时序

**Files:**
- Modify: `server/dailyCandidateService.ts`
- Modify: `server/radarEngine.ts`
- Modify: `src/domain/marketCalendar.ts`
- Test: `server/dailyCandidateService.test.ts`

- [x] **Step 1: 写失败测试**：T+3 当日 14:59 行情只能保持 `observing`，15:00 完整收盘行情才能 `completed`；15:00–15:30 自动调度必须使用完整行情刷新。
- [x] **Step 2: 运行定向测试并确认失败**：`pnpm exec tsx --test server/dailyCandidateService.test.ts`。
- [x] **Step 3: 最小实现**：结算校验 `quoteAt >= T+3 15:00`；新增显式 `shouldUseFullMarketRefresh(now)`，交易时段及冻结决策窗口均返回 `true`。
- [x] **Step 4: 运行定向测试并确认通过**。

### Task 2: 交易日计算与盘中同长窗口

**Files:**
- Modify: `server/dailyCandidateService.ts`
- Modify: `server/radarEngine.ts`
- Modify: `src/domain/marketCalendar.ts`
- Test: `server/dailyCandidateService.test.ts`

- [x] **Step 1: 写失败测试**：本地仅有 7 个行情日时，2020 年上市股票仍满足 30 个交易日；10:00 预览使用 30 分钟而不是 240 分钟讨论窗口。
- [x] **Step 2: 运行定向测试并确认失败**。
- [x] **Step 3: 最小实现**：由已验证交易日历计算上市交易日数；预览显式传入 `now`，计算扣除午休的交易分钟，并只接纳相同 `elapsedMinutes` 的五个历史窗口。
- [x] **Step 4: 运行定向测试并确认通过**。

### Task 3: 百分位、A/B 补位与过热边界

**Files:**
- Modify: `server/dailyCandidateStrategy.ts`
- Modify: `server/dailyCandidateService.ts`
- Test: `server/dailyCandidateStrategy.test.ts`
- Test: `server/dailyCandidateService.test.ts`

- [x] **Step 1: 写失败测试**：偏态参考集产生经验百分位而非 P5/P95 线性值；高分 B 不得替换 A；打开涨停后收盘恰好封板仍扣 3 分。
- [x] **Step 2: 运行定向测试并确认失败**。
- [x] **Step 3: 最小实现**：缩尾后按经验秩计算 0–100 分；先固定 A 再以 B 补位；`reopenedLimit` 允许收盘等于涨停价。
- [x] **Step 4: 运行定向测试并确认通过**。

### Task 4: 来源覆盖与冻结可复算审计

**Files:**
- Modify: `server/eastMoney.ts`
- Modify: `server/dailyCandidateService.ts`
- Modify: `server/radarEngine.ts`
- Test: `server/dailyCandidateService.test.ts`

- [x] **Step 1: 写失败测试**：当前窗口未覆盖股票的事件不得进入候选；周一公告窗口从前一交易日 15:00 前开始；冻结载荷包含参考集审计和选择诊断。
- [x] **Step 2: 运行定向测试并确认失败**。
- [x] **Step 3: 最小实现**：贯穿 `coveredCodes` 并逐股票授权；公告查询接收显式窗口；将 `referenceAudit`、`selectionDiagnostics`、完整事件评分输入保存到不可变榜单。
- [x] **Step 4: 运行定向测试并确认通过**。

### Task 5: API、UI 与测试入口

**Files:**
- Modify: `server/dailyCandidateService.ts`
- Modify: `src/pages/ScreenerPage.tsx`
- Modify: `package.json`
- Test: `server/dailyCandidateApi.test.ts`
- Test: `src/lib/dailyFocusPresentation.test.ts`

- [x] **Step 1: 写失败测试**：预览包含 `methodologyVersion`；讨论基线显示冻结的中位数；默认测试命令执行 `src/**/*.test.ts`。
- [x] **Step 2: 运行定向测试并确认失败**。
- [x] **Step 3: 最小实现**：统一预览/冻结响应契约；UI 使用 `discussionGrowth.countMedian`；扩展测试 glob。
- [x] **Step 4: 运行完整验证**：`pnpm test`、`pnpm check`、`pnpm build`。

### Task 6: 生产盘中历史窗口闭环

**Files:**
- Modify: `server/eastMoney.ts`
- Modify: `server/radarEngine.ts`
- Modify: `server/dailyCandidateService.ts`
- Test: `server/dailyCandidateService.test.ts`

- [x] **Step 1: 写失败测试**：未注入测试窗口时，具有 D-6 至当前时刻完整范围证明的讨论源仍能生成 10:00 盘中预览。
- [x] **Step 2: 运行定向测试并确认失败**。
- [x] **Step 3: 最小实现**：讨论源从 D-6 收盘开始查询；按来源事件 ID、逐股覆盖与游标穷尽证明重建此前五个同分钟窗口。
- [x] **Step 4: 运行定向测试与完整验证并确认通过**。
