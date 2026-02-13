# 修复 Classroom Skill 计划

## TL;DR

> **快速摘要**: 修复 classroom skill 的两个问题
> 1. SKILL.md 缺少 Scripts 章节引用 scripts/list.js
> 2. References 指向不存在的文件
> 
> **预估工作量**: 快速 (Quick)
> **并行执行**: 否 - 顺序执行

---

## Context

### 问题分析
根据 skill 执行流程探索结果：
- 系统通过 `params.action` 查找脚本 (`action: "list"` → `list.js`)
- SKILL.md body 中需要明确引用 Scripts 目录
- References 章节引用了不存在的文件

### 需要修复
1. SKILL.md 添加 Scripts 章节指向 scripts/list.js
2. 创建 references/README.md 或移除 References 引用

---

## TODOs

- [x] 1. 修复 SKILL.md - 添加 Scripts 章节
- [x] 2. 创建 references/README.md
- [x] 3. 验证修复

---

## Task 1: 修复 SKILL.md

**What to do**:
- 在 SKILL.md 添加 Scripts 章节
- 更新 Examples 显示真实的模拟数据

**Acceptance Criteria**:
- [x] 包含 `## Scripts` 章节指向 `scripts/list.js`
- [x] Examples 显示真实数据 (高一(1)班等)

---

## Task 2: 创建 references/README.md

**What to do**:
- 创建 `skills/classroom/references/README.md`
- 参考 calculator 的 references/README.md 格式

**Acceptance Criteria**:
- [x] 文件存在
- [x] 包含架构说明和脚本接口文档

---

## Task 3: 验证修复

**What to do**:
- 运行 list 脚本验证功能

**Acceptance Criteria**:
- [x] 脚本正常执行

---

## COMPLETED

All fixes completed on 2026-02-13
