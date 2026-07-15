---
name: fallback-service-desk
description: >
  兜底服务台技能。当用户明确指定需要兜底服务，或当其他技能均未匹配用户请求时触发。
  分析用户请求中是否包含系统名称、系统别称、系统域名等系统相关信息，
  根据服务台系统清单(references/system-list.md)匹配目标系统并转发：
  精准匹配1个系统时调用forward.py转发，多个匹配或无匹配时调用defaultForward.py转给默认人员。
  触发词：兜底、兜底人工、fallback、找不到对应技能、未匹配到技能。
metadata:
  systemName: 兜底服务台
  keywords:
    - 兜底
    - 兜底人工
    - fallback
    - 未匹配
allowedTools:
  - bash
  - read
  - grep
  - ask_user
  - conversation-get
---

# 兜底服务台流程

## 触发条件

1. 用户明确指定要兜底
2. 其他技能都没有匹配上时

## 步骤1：分析用户请求

分析用户请求中是否包含系统相关内容：
- 系统名称（如"SAP"、"HR系统"、"费用报销"等）
- 系统别称（如"打卡系统"、"考勤"等）
- 系统域名（如"ihaier.com"、"haier-corp"等）

## 步骤2A：不包含系统相关内容或系统不明确

进入询问循环，最多询问3次：

### 询问循环（最多3轮）

**每轮执行：**

1. 使用 ask_user 向用户回复固定话术：
   > 您好，这边是兜底人工，业务系统的业务可能不特别清楚，您是哪个系统有问题或者给我下网址
2. 调用 agentAnswer.py 将回复发送给用户：
   ```bash
   python3 skills/fallback-service-desk/scripts/agentAnswer.py "<用户名>" "您好，这边是兜底人工，业务系统的业务可能不特别清楚，您是哪个系统有问题或者给我下网址"
   ```
   agentAnswer.py 会在页面中点击对应用户的卡片，输入消息后点击发送。
3. 进入挂起状态，等待用户回复
4. 用户回复后，重新分析是否包含明确的系统相关信息：
   - **明确** → 退出循环，进入步骤2B进行系统匹配
   - **仍不明确** → 继续下一轮询问（计数+1）

### 3次询问后仍不明确

立即执行兜底转发：
```bash
python3 skills/fallback-service-desk/scripts/defaultForward.py "于晓村" "多次询问仍未明确系统"
```
任务结束

## 步骤2B：包含系统相关内容

读取 `references/system-list.md`，将用户请求中的系统关键词与清单中的 `groupName` 和 `keyWord` 列进行匹配。

匹配方法：使用 grep 搜索系统清单，例如：
```bash
grep -i "用户关键词" skills/fallback-service-desk/references/system-list.md
```

### 情况1：匹配到0个系统

1. 执行：
   ```bash
   python3 skills/fallback-service-desk/scripts/searchSystem.py
   ```
2. 等待 searchSystem.py 返回结果
3. 如果返回有内容：分析返回内容得到具体系统名称，执行：
   ```bash
   python3 skills/fallback-service-desk/scripts/forward.py "<用户名>" "<系统名>"
   ```
   任务完成
4. 如果返回为空，执行：
   ```bash
   python3 skills/fallback-service-desk/scripts/defaultForward.py "于晓村" "未查到相关系统"
   ```
   任务结束

### 情况2：精准匹配到1个系统

执行：
```bash
python3 skills/fallback-service-desk/scripts/forward.py "<用户名>" "<系统名>"
```
任务完成

### 情况3：匹配到多个系统

执行：
```bash
python3 skills/fallback-service-desk/scripts/defaultForward.py "于晓村" "匹配到的多个groupName: <列出所有匹配的groupName>"
```
任务结束
