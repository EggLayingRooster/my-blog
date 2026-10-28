# 模块 1（数据与缓存一致性）检查：跨模块/待确认问题记录

日期：2026-10-29
来源：模块 1 审计（入口点、9 维度、高风险路径）。本文件只记录**需要结合其它模块或外部配置**才能确定/修复的问题；本模块内可确定的问题已在本轮修复。

## 待其它模块 / 外部确认

1. **Dashboard 时间范围时区**
   - 位置：`src/features/dashboard/service/dashboard.service.ts:17-39`
   - 现状：日界按 Worker UTC（`setHours/getDate`）计算，与发布语义（发布者本地时区）不一致；7d/30d/90d 的"当天"起点会偏移 8 小时。
   - 需要：config 模块提供站点/发布者时区（如 `blogConfig.timeZone` 或系统配置），再统一日界。

2. **Pageview 防刷 / 服务端去重**
   - 位置：`src/features/pageview/api/pageview.api.ts:9-28`
   - 现状：已补"文章必须存在且已发布"校验 + 入队失败日志；但仍无频控，脚本可反复调用刷 PV。
   - 需要：ServerFn 层接入 `src/lib/hono/middlewares.ts` 的 rateLimitMiddleware（或复用 Durable Object 限流），属于安全/基础设施模块。

3. **PAGEVIEW 幂等唯一约束**
   - 位置：`src/features/pageview/api/pageview.consumer.ts`
   - 现状：已改为逐条写入并容错（单条 FK 失败不再毒化整批），并失效 dashboard 流量缓存；Queue at-least-once 下重复投递仍可能重复计数。
   - 需要：DB 模块新增唯一索引（如 `(post_id, visitor_hash, day)`）或去重表，需 migration。

4. **CDN purge 失败告警**
   - 位置：`src/lib/invalidate.ts:20-96`、`src/features/posts/workflows/post-process.ts:123-132`
   - 现状：purge 已带重试（3 次指数退避）；失败只有 `console.error`，没有系统日志/后台提示。
   - 需要：通知/审计模块提供"写入系统日志"能力；Cloudflare purge token 的实际权限需要控制台或 API 实测确认（本地读不到 secret）。
   - 兜底已在本轮做：公开响应的 `CDN-Cache-Control: s-maxage` 从 31536000 降到 300（`src/lib/constants.ts`），purge 失效时最多 5 分钟陈旧。

5. **`purgeSiteCDNCache` 前缀语义**
   - 位置：`src/lib/invalidate.ts:104-121`
   - 现状：`prefixes: ["/"]` 会转换成裸域名（无尾斜杠）交给 Cloudflare prefix purge。
   - 需要：用真实 token 调用一次 purge API 验证返回码（外部 API 行为，无法静态确认）。

6. **Dashboard `lastUpdated` 语义**
   - 位置：`src/features/dashboard/service/dashboard.service.ts:62,105`
   - 现状：缓存里存的是构建时间，命中 3h 缓存时会显示旧时间点，误导"最后更新"。
   - 需要：dashboard 前端/契约模块决定展示语义（"缓存于 X" 还是实时时间）。

7. **缓存日志噪音**
   - 位置：`src/features/cache/cache.service.ts:37,52`
   - 现状：每次请求都 `console.log` cache hit/miss，生产日志量大。
   - 需要：日志/可观测模块统一采样或分级。

8. **Dashboard 热门文章缓存不随 PV 失效**
   - 位置：`src/features/pageview/service/pageview.service.ts:18-43`
   - 现状：popular 缓存 3h，pageview 写入只失效 dashboard traffic，不失效 popular。
   - 需要：产品确认是否可接受（当前按 3h 刷新）。

9. **`ENVIRONMENT` 误配防护**
   - 位置：`src/lib/env/server.env.ts:51-52`、`src/lib/invalidate.ts:29-34`
   - 现状：`ENVIRONMENT` 为 dev/test 时 purge 静默跳过；生产误配会导致缓存永不清。
   - 需要：部署/配置模块增加生产启动断言或告警。

10. **related 缓存旧 limit 键残留**
    - 位置：`src/features/posts/services/posts.service.ts:150-160`
    - 现状：related 键已改为 `posts:list` 版本化（发布/删除会失效当前版本）；同一版本下不同 `limit` 的历史键会留到 TTL（7d）过期，仅占 KV 存储，无正确性影响。
    - 需要：确认是否接受该存储成本（可选优化）。
