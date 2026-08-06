# LLM Fallback Chain:provider 自动降级

> 实现:`src/llm/fallback-client.ts`、`src/llm/cooldown-cache.ts`、`src/llm/failover-classifier.ts`、`src/llm/failover-config.ts`
> 配置:`config/llm-fallback.json`
> 测试:`__tests__/fallback-integration.test.ts`(端到端)

---

## 一、为什么要 fallback

单一 LLM provider 是整个 Agent 的单点故障。实际会遇到的情况:

- **限流**:并发一上来,OpenRouter 直接 429,整批任务全挂;
- **key 失效**:额度用完 / key 被轮换,401,在人工介入前所有请求都失败;
- **上游抖动**:5xx、连接超时,几十秒的瞬时故障。

这些故障有一个共同点:**换一个 provider 就能立刻恢复**。Fallback chain 做的就是这件事 —— 按优先级配置一条候选链,某个 candidate 失败时自动切到下一个,并把失败的那个放进冷却表,避免后续请求继续撞墙。

对调用方完全透明:`FallbackLLMClient` 实现同一个 `ILLMClient` 接口,`generateText` / `generateStructured` / `generateWithTools` 三条路径都走同样的切换逻辑。上层(MainAgent / SubAgent / requirement-analyzer)不需要任何改动。

```
调用方 ──► FallbackLLMClient ──┬─► candidate 1 (priority 1)  ← 冷却中则跳过
       (ILLMClient 装饰器)     ├─► candidate 2 (priority 2)
                              └─► candidate 3 (priority 3)
                                      │
                              全部失败 └─► throw FailoverError
```

---

## 二、配置

### 配置文件 `config/llm-fallback.json`

```json
{
  "candidates": [
    { "providerKey": "siliconflow:Pro/MiniMaxAI/MiniMax-M2.5", "priority": 1, "model": "Pro/MiniMaxAI/MiniMax-M2.5" },
    { "providerKey": "haier:glm-5-fp8",                       "priority": 2, "model": "glm-5-fp8" }
  ]
}
```

字段说明(schema 见 `src/llm/failover-config.ts`,用 zod 校验):

| 字段 | 约束 | 说明 |
|---|---|---|
| `providerKey` | `^[a-z0-9_-]+:[a-zA-Z0-9_./-]+$` | 格式 `<provider>:<modelId>`。冒号前的 provider 必须是受支持的值:`siliconflow` / `haier`。这个 key 同时也是 **cooldown 表的主键** |
| `priority` | 整数,≥ 1,**全局唯一** | 数字越小越优先。重复的 priority 会导致 schema 校验失败 |
| `model` | 非空字符串 | 传给 provider 的实际模型 ID |

`candidates` 至少要有 1 项。工厂 `buildFallbackLLMClient()` 按 `priority` 升序排序后构建候选链,每个 candidate 一个独立的 `LLMClient` 实例(通过 `configureProvider(provider, model)` 设置各自的 provider / API key / **baseUrl** / 模型)。

### 各 provider 的 API key 与默认 endpoint

candidate 的 API key 从对应的环境变量读,**不写在配置文件里**。`configureProvider()` 切换 provider 时会**同步切换 baseUrl**,所以跨厂商降级(`siliconflow` → `haier`)会打到正确的 endpoint。

| provider | 默认 baseUrl | 环境变量 |
|---|---|---|
| `siliconflow` | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` |
| `haier` | `https://modelapi-test.haier.net/model/v1` | `HAIER_API_KEY` |

> **代理场景**:如果设置了 `LLM_BASE_URL` 环境变量,它会**覆盖**所有 provider 的默认 baseUrl(全公司走同一 proxy)。不设就走各 provider 的默认 endpoint。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_FALLBACK_ENABLED` | `true` | 设为字符串 `"false"` 才会关闭(其他任何值 —— 包括不设 —— 都视为开启)。关闭后 `buildFallbackLLMClient()` 直接返回裸 `LLMClient`,走 `LLM_PROVIDER` / `LLM_MODEL` 那套单 provider 配置 |
| `LLM_FALLBACK_CONFIG_PATH` | `<resource>/config/llm-fallback.json` | 配置文件路径。通过 `resolveResource()` 解析,兼容源码运行与打包后的 dist |

### 降级不会让服务起不来

配置文件读不到(ENOENT)、JSON 语法错误、schema 校验不过 —— 这三种情况**都不抛错**,只打一条 warn 日志然后退回裸 `LLMClient`。配错一个 JSON 不应该导致整个服务 boot 失败。

```json
{"level":"warn","module":"LLM","message":"LLM fallback config file unreadable, falling back to bare LLMClient","configPath":"/app/config/llm-fallback.json","error":"ENOENT: no such file or directory"}
```

---

## 三、Cooldown 表

candidate 失败后会按失败原因进入冷却,冷却期内的 candidate 在选路时被**直接跳过**(不会发起请求)。冷却表是进程内的单例 `cooldown`(`src/llm/cooldown-cache.ts`)。

### base TTL 表

| FailoverReason | base TTL | 由哪些 `LLMErrorType` 映射而来 | 为什么是这个时长 |
|---|---|---|---|
| `auth_failed` | **300s**(5 分钟) | `INVALID_KEY` | key 失效需要人工换 key,短冷却毫无意义,只会白白重试 |
| `context_too_long` | **600s**(10 分钟) | `CONTEXT_TOO_LONG` | 几乎不会自愈(注:这个 reason 实际不会触发切换,见下节,所以该 TTL 基本用不上) |
| `rate_limit` | **60s**(1 分钟) | `RATE_LIMIT` | 常见限流窗口长度 |
| `output_too_long` | **60s** | `OUTPUT_TOO_LONG` | 同上(同样不触发切换) |
| `server_error` | **30s** | `TIMEOUT`、`NETWORK_ERROR`、`API_ERROR` | 5xx / 网络抖动多是瞬时的,冷却最短,尽快恢复主 provider |

映射表定义在 `src/llm/failover-types.ts` 的 `LLMErrorTypeToFailoverReason`,类型是 `Record<LLMErrorType, FailoverReason | null>` —— **新增 `LLMErrorType` 时编译器会强制你补上这一行**。

### TTL 不会被反复失败无限延长

同一个 `providerKey` 在冷却期内被重复 `mark`,**保留原来的 `expiresAt`,只递增 `hitCount`**。`hitCount` 只进日志,不参与 TTL 计算。

这是刻意的:如果每次失败都重算 TTL,高并发下一个短暂故障能把 provider 冷却成几十分钟,恢复路径就被自己堵死了。冷却期过后 entry 会在下一次 `isAvailable()` 查询时自动清理。

---

## 四、不切换 provider 的错误

不是所有失败都值得换一家试。以下两类会**原样上抛原始 `LLMError`**,一个 candidate 都不多试,也**不进冷却表**:

| 错误 | 为什么不切 |
|---|---|
| `CONTEXT_TOO_LONG` | 输入太长是**请求本身**的问题。换 provider 通常只会换来同样的错误,还白白浪费一次调用和一次配额。正确做法是上层做 compaction(`src/llm/compaction.ts`)后重试 |
| `OUTPUT_TOO_LONG` | 同上,输出超限是模型参数问题,不是 provider 可用性问题 |

另外三类会被 classifier 判为「与 failover 无关」(`classifyFailoverReason` 返回 `null`),同样**原样上抛**:

| 错误 | 为什么不切 |
|---|---|
| `CANCELLED` | 用户主动取消。切到下一个 provider 等于无视用户意图 |
| `QUEUE_FULL` | 本地并发队列满了,是**我们这边**的背压信号,跟 provider 好不好没关系 |
| `UNKNOWN_ERROR` | 语义不明,保守起见不做自动切换,让原始错误上抛便于排障 |

非 `LLMError` 的普通异常(代码 bug、`TypeError` 等)也一样直接上抛 —— 不会被误判成 provider 故障。

### 全部候选都失败:`FailoverError`

候选链走完仍没成功,抛 `FailoverError`(`src/llm/failover-types.ts`):

```ts
class FailoverError extends Error {
  readonly reason: FailoverReason;               // 最后一次失败的原因
  readonly providerKey: string;                  // 最后一次尝试的 candidate
  readonly attempts: ReadonlyArray<FailoverAttempt>;  // 全部尝试记录 [{providerKey, reason}]
}
// message: "LLM failover exhausted: zhipu:glm-4-plus rate_limit after 3 attempts"
```

**`message` 里刻意不含任何原始错误的 message 或 stack**。上游 provider 的报错经常把 API key、请求体片段回显在 message 里,这个错误会一路冒泡到上层日志甚至 HTTP 响应,所以只保留 `providerKey` + `reason` + 尝试次数。要看原始错误,去 `LLM candidate failed, trying next` 那几条 warn 日志。

---

## 五、日志与排障

所有 fallback 相关日志都是 **warn 级别的单行 JSON**(logger 见 `src/observability/logger.ts`),字段固定,可以直接 grep / 喂给日志系统。

### candidate 失败,准备切下一个

```json
{"level":"warn","timestamp":"2026-08-06T07:21:59.708Z","module":"FallbackLLMClient","message":"LLM candidate failed, trying next","providerKey":"siliconflow:Pro/MiniMaxAI/MiniMax-M2.5","reason":"rate_limit"}
```

### 进入冷却(紧跟在上一条之前)

```json
{"level":"warn","timestamp":"2026-08-06T07:21:59.708Z","module":"CooldownCache","message":"LLM provider marked cooldown","providerKey":"siliconflow:Pro/MiniMaxAI/MiniMax-M2.5","reason":"rate_limit","ttlMs":60000,"hitCount":1}
```

### 切换成功(说明这次请求靠 fallback 救回来了)

```json
{"level":"warn","timestamp":"2026-08-06T07:21:59.704Z","module":"FallbackLLMClient","message":"LLM failover succeeded","fromProviderKey":"siliconflow:Pro/MiniMaxAI/MiniMax-M2.5","toProviderKey":"haier:glm-5-fp8","attempts":1}
```

> 注意 `fromProviderKey` 是**第一个**失败的 candidate,不是紧邻的那个。中间失败了几个看 `attempts`。

### 跳过冷却中的 candidate

这条是 **debug** 级别(默认 `LOG_LEVEL=info` 下看不到),排障时把 `LOG_LEVEL=debug` 打开:

```json
{"level":"debug","module":"FallbackLLMClient","message":"skipping candidate in cooldown","providerKey":"siliconflow:Pro/MiniMaxAI/MiniMax-M2.5"}
```

### 运维怎么用

```bash
# 最近有没有发生过 failover?
grep '"message":"LLM candidate failed, trying next"' app.log

# 哪个 provider 掉得最多?
grep '"LLM candidate failed' app.log | jq -r .providerKey | sort | uniq -c | sort -rn

# 是不是 key 失效了?(auth_failed 意味着需要人工换 key,不会自愈)
grep '"reason":"auth_failed"' app.log

# 有没有整条链打穿?(这些请求是真的失败了)
grep 'LLM failover exhausted' app.log

# 串联单次请求的全链路(logger 自动注入 traceId)
grep '"traceId":"<id>"' app.log
```

**告警建议**:`LLM failover succeeded` 属于「自愈了但有问题」,适合做低优先级告警或看板计数;`LLM failover exhausted` 是真正的用户可见失败,应该直接告警;`"reason":"auth_failed"` 单独拉一条告警,因为它不会自愈。

---

## 六、已知限制

1. **Cooldown 是进程内的,不持久化。**
   状态存在单个 Node 进程的 `Map` 里。进程重启即清空,多实例部署时各实例的冷却表相互独立 —— 实例 A 已经熔断的 provider,实例 B 仍然会去撞一次墙。设计上接受这个代价:冷却表是**优化**(少打无效请求)而非**正确性保证**,最坏情况只是多几次失败的调用,不影响结果正确。如果重启频繁(比如崩溃循环),可能会反复重试已知不可用的 provider。

2. **只做自动降级,不做自动升级或负载均衡。**
   永远按 `priority` 从头试,没有权重轮询、没有健康度评分、没有主动探活。主 provider 的恢复完全靠 cooldown TTL 到期后的下一次自然请求去试探。

3. **失败状态不暴露给前端。**
   `FailoverError` 只在服务端日志里有细节(而且刻意脱敏)。用户侧看到的是普通的任务失败,不会知道「切了两家都不行」。当前没有把 provider 健康度做成接口或看板。

4. **跨 candidate 会重放请求。**
   切换时整个请求(包括 `generateWithTools` 的完整 messages)会原样发给下一个 candidate。如果失败发生在若干轮工具调用之后,这些工具会被**重新执行一遍**。依赖工具本身的幂等性 + `concurrencyChecker` 兜底。非幂等的工具(比如发消息、写外部系统)在 failover 场景下有重复执行的风险。

5. **并发槽位有两层。**
   `FallbackLLMClient` 通过 `sharedSlot`(`LLMSlotRegistry`,capacity = `LLM_MAX_CONCURRENT_REQUESTS`)在候选链层面限流,而每个 `LLMClient` 内部还有一套自己的 class-level semaphore。两层上限都是同一个配置值,实际生效的是更严格的那层;这是重构过程中的中间状态,不影响正确性,但会让「当前并发数」这个指标不那么直观。

---

## 七、验证

```bash
# 端到端集成测试(6 个场景:限流切换+恢复 / key 失效长冷却 /
# context 超长不切 / 全失败 / abort 跨 candidate / generateStructured 链路)
bun test __tests__/fallback-integration.test.ts

# 全套 fallback 相关单测
bun test __tests__/failover-types.test.ts __tests__/failover-classifier.test.ts \
         __tests__/cooldown-cache.test.ts __tests__/llm-slot-registry.test.ts \
         __tests__/fallback-client.test.ts __tests__/fallback-config.test.ts \
         __tests__/fallback-wiring.test.ts __tests__/fallback-integration.test.ts
```

### 手动验证(在真实环境确认接线正确)

1. 把 `config/llm-fallback.json` 配成两个 candidate(priority 1 主,priority 2 备);
2. 临时把主 provider 的 API key 环境变量改成一个无效值;
3. 发一条正常消息 —— 任务应该正常完成(走了备用 candidate);
4. 查日志,应看到 `LLM candidate failed, trying next` + `LLM failover succeeded`;
5. 把 key 改回去 —— 注意 `auth_failed` 的冷却是 **300s**,要等 5 分钟后的下一次请求才会重新尝试主 provider(等不及就重启进程,冷却表随进程清空)。
