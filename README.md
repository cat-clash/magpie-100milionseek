# magpie-100milionseek

[100 Million Seek](https://100milionseek.top/docs)（`100milionseek.top`）的 [Magpie](https://usemagpie.ai) 供应商插件。

- **统一 API**：`https://100milionseek.top/v1`，只填 `hms-` 开头的 API Key 即可登录。
- **一键批量导入**：把一大段 Key 粘进去（每行一个、带备注、带序号、JSON……都能识别），自动去重、自动校验、批量写入 Magpie 的登录态文件。
- 模型 `deepseek-v4.1-flash-free`（198K 上下文 / 64K 输出），读 `x-quota-*` 响应头显示每日额度。
- **1.3.0**：模型表按「真能 chat」过滤（judge 模型不进表，选了不会 400）；429 并发限流在插件内先
  退避重试（`sessionRetry`，默认 2 次），宿主基本看不到限流。

---

## 模型：全站只有一个 chat 模型（2026-11-26 实测）

「500,000,000 token 的档位能调用哪些模型」的答案是**一个**，不是两个、也没有隐藏款：

| 证据 | 结果 |
| --- | --- |
| `GET /v1/models`（18 把 Key 全扫一遍） | 全部只回 2 条：`deepseek-v4.1-flash-free`、`jev-1.13-free` |
| `POST /v1/chat/completions` 逐 id 试 | 只有 `deepseek-v4.1-flash-free` 可用；`jev-1.13-free` 回 `400 wrong_endpoint` |
| 另一批候选 id（deepseek-v4.1-pro / deepseek-chat / gpt-5.4 / claude-sonnet-4.6 / qwen3-max / kimi-k2 / glm-4.6 / hy3 …共 24 个） | 一律 `404 model_not_found` |
| `GET /api/status`（公开） | `model.id` 只有一个：`deepseek-v4.1-flash-free` |
| 官网 `/join` 付费档（$1/$3/$5） | 只放开**每分钟请求数**与**并发数**，不换模型 |
| `GET /v1/responses`、`POST /v1/embeddings` | `404 not_found` —— 不存在 |

所以：

- **chat 模型 = `deepseek-v4.1-flash-free`**（198K 输入 / 64K 输出，1x 计费，支持 stream 与 tools）。
- **`jev-1.13-free` 是 judge 模型**：只服务 `POST /v1/systemone`，入参 `{model, state, questions}`，
  出一组「每题一个概率」，0.2x 计费。拿去 `/chat/completions` 会 400，所以 1.3.0 起
  **不再并进 Magpie 模型表**（以前它会被列出来，选中就报错）。
  要用它就直接打 base URL（relay 对 `/v1/systemone` 是原样透传）：

  ```bash
  curl https://100milionseek.top/v1/systemone \
    -H "Authorization: Bearer $HMS_API_KEY" -H "Content-Type: application/json" \
    -d '{"model":"jev-1.13-free","state":{...},"questions":["这样回答有帮助吗？"]}'
  ```

- **额度**：`500,000,000` token/账号/天（里程碑活动，至 2026-12-03 02:14 UTC；活动结束回到
  100,000,000/天）。这是**同一把 Key 的日额度上限**，跟模型数量无关。多账号池化才是把额度变大的
  唯一办法：18 个账号 ≈ **90 亿 token/天**、并发 90（每账号硬限 5）。

---

## 限流（429）是怎么被消掉的

站点对**每账号**有两道闸：5 个并发、每日 token 额度。

| 429 code | 含义 | 本插件行为 |
| --- | --- | --- |
| `session_limit_reached` | 第 6 个并发请求 | 插件内短退避重试（`sessionRetry`，默认 2 次，250ms→500ms + jitter）；仍失败就换池子里另一把 Key 重发 |
| `daily_quota_exceeded` | 当日额度用完 | 插件内直接换另一把 Key 重发（`keyFailover`，默认开，最多换 2 把） |

**换号不依赖宿主**：magpie 主程序识别的响应头里没有 `x-magpie-failover` / `x-magpie-retry`
（2026-11-26 查二进制里的 `MAGPIE_ONLY` 常量表），所以 1.3.1 起插件自己读
`plugin-auth.json` 里同供应商的 `hms-` Key 池，429 时用另一把 Key 原样重发同一请求
（body 必须可重放；流式 body 不换号）。宿主看到的是换号后的真实结果，不是 429。
两次换号都不行才把 429 返回，并照旧带上 `x-magpie-failover` 标记。

- `keyFailover: false` 可关掉（只留同账号重试）；`sessionRetry: 0` 可关掉退避重试。
- 池子读盘有 30s 缓存，不进请求热路径；`plugin-auth.json` 里改完账号最多等 30s 生效。
- 所有 Key 都是**当前这个 magpie 供应商**的登录态，插件不会碰其他供应商的凭据。
- 站点每账号 5 并发、500M/天的硬限仍在；18 把 Key ≈ 90 亿 token/天、90 并发。
  **别把 `maxConcurrency` 调到 5 以上**：超了必然撞 `session_limit_reached`。

---

## 原理：为什么批量导入是独立 CLI

Magpie 的 auth hook **没有** `import` 字段，宿主不会调用它做批量登录。所有账号登录态统一存在扁平文件 `~/.config/magpie/plugin-auth.json`（Windows 为 `%USERPROFILE%\.config\magpie\plugin-auth.json`）：

```jsonc
{
  "hms":             { "type": "api", "key": "hms-...", "accountId": "hms-<指纹>" },  // 第一个账号
  "hms#a1b2c3":      { "type": "api", "key": "hms-...", "accountId": "hms-<指纹>" },  // 其余账号
  "hms#d4e5f6":      { "type": "api", "key": "hms-..." }
}
```

本插件的做法：
1. **插件本体**（`index.mjs`）负责单个 Key 登录、聊天转发、额度显示 —— 用 `magpie plugin add` 安装。
2. **批量导入 CLI**（`cli/import-keys.mjs`）直接把多个 Key 写进上面的文件 —— 绕过宿主没有批量 hook 的限制，这是本插件「批量导入账号」的真正实现。

账号按 Key 指纹派生稳定 slot（`hms#<6位>`），重复导入同一把 Key 会跳过而不是产生重复账号。

---

## 安装插件

```bash
magpie plugin add cat-clash/magpie-100milionseek
```

或本地目录：

```bash
magpie plugin add ./magpie-100milionseek
```

从 GitHub 完整地址也可：

```bash
magpie plugin add https://github.com/cat-clash/magpie-100milionseek
```

装好后 Magpie 里会出现供应商 `100 Million Seek`；`magpie plugin login hms` 可用单 Key 登录（会走在线校验）。

---

## 一键批量导入（核心功能）

### 方式 A：直接粘贴（推荐）

把 Key 列表放进一个文本文件 `keys.txt`，每行一个；然后：

```bash
bun cli/import-keys.mjs keys.txt
# 或用所在环境自带的 node：
node cli/import-keys.mjs keys.txt
```

也可以用管道：

```bash
cat keys.txt | bun cli/import-keys.mjs
```

`keys.txt` 可以是任意含 `hms-` Key 的文本，下面这些都能被智能识别：

```
hms-aaaaaa111111
hms-bbbbbb222222   # 主账号
2. 备用, hms-cccccc333333
token: "hms-dddddd444444"
["hms-eeeeee555555", "hms-ffffff666666"]
```

规则：
- 只认 `hms-` 后接至少 6 位字母/数字/`-`/`_` 的 Key。
- 自动去重（相同 Key 只写一次）。
- 注释行（`#` `//` `;`）、空行、没有 Key 的行会给出诊断。
- 默认**逐条在线校验**（`GET /v1/models`，不扣聊天额度）；无效 Key 不写入。
- 写盘前自动备份为 `plugin-auth.json.bak`；文件权限 `600`。

### 方式 B：跳过校验（离线快速导入）

```bash
bun cli/import-keys.mjs --no-verify keys.txt
```

### 方式 C：预览不写盘

```bash
bun cli/import-keys.mjs --dry-run keys.txt
```

### 常用选项

| 选项 | 作用 |
| --- | --- |
| `--no-verify` | 跳过在线校验，直接写入 |
| `--dry-run` | 只解析+校验并打印，不写文件 |
| `--config <path>` | 指定 `plugin-auth.json` 路径（默认自动探测） |
| `--provider <id>` | 登录态 provider id（默认 `hms`，需与插件 options 一致） |
| `--reset` | 先清空现有同 provider 账号再写（默认追加去重） |
| `--json` | 结果以 JSON 输出（便于脚本处理） |
| `--stdin` | 强制从标准输入读取 |
| `-h, --help` | 帮助 |

### 生效

导入后让 Magpie 重新载入：Plugins → Reload，或重启 Magpie。之后 `magpie` 会把这些账号作为 `hms` 供应商的多个登录态，按请求轮转；每个 Key 的每日额度独立。

---

## 插件配置（plugins.json options）

```jsonc
{
  "plugins": [
    {
      "spec": "cat-clash/magpie-100milionseek",
      "options": {
        "providerId": "",             // 空=hms；改了要用 --provider 同步给 CLI
        "maxConcurrency": 5,          // 每账号并发，站点硬限 5
        "usageCacheMs": 300000,       // 额度缓存 5 分钟（默认，不必改）
        "usageTimeoutMs": 6000,       // 额度探测超时，必须比 Magpie UI 超时短
        "liveModelList": true,        // 在线刷新模型表
        "modelListTtlMs": 3600000,
        "importMax": 200,             // auth.import 内部上限（CLI 单列写 1000）
        "keyLabel": "",               // 单 Key 登录默认备注
        "debugTiming": false,         // 打开后 stderr 打一行 [hms] 耗时（TTFB/总耗时）
        "proxy": "",                  // ""=跟环境变量；"direct"=强制直连；或 "http://127.0.0.1:7897"
        "dropTools": [],              // 转发层裁掉的工具名单：精确名或前缀通配，如 ["mcp__github__*","read_file"]
        "sessionRetry": 2,            // 429 并发限流时插件内重试次数（0=关，直接交给宿主）
        "keyFailover": true           // 429 时插件内换另一把 Key 重发（不依赖宿主轮转）
      }
    }
  ]
}
```

### dropTools：减小 prefill 体积

上游慢在首字前的 prefill（实测 ~90ms/千 token，55K 输入要 30s+）。system prompt 是 Magpie 发的、插件动不了；但请求体里的 `tools` 数组可以裁——如果你的 agent 挂了很多 MCP 工具、实际用不到的，直接在转发层删掉它们的 schema，输入体积立减：

```jsonc
"dropTools": ["mcp__github__*", "mcp__notion__*", "read_file"]   // 前缀* 通配或精确名
```

- 只作用于 `POST /chat/completions` 的请求体，`/models` 等其它请求不受影响
- 名单为空（默认）时字节级原样透传，零开销
- 非法 JSON、无 tools 字段、无命中 → 原样透传，绝不弄丢请求
- ⚠️ 裁掉的工具模型就「看不见」了——agent 真去调用会被模型拒绝。只裁你确定不用的
- 真正的正路是在 agent 端（如 opencode / dsh 的配置里）精简挂载的工具和 system prompt；本选项是 provider 侧的最后手段

### 关于 token 速度

实测慢在**首字之前的 prefill**（上游对大输入极慢），不是吐字阶段。本插件能省的：

- **额度/模型表全部本地缓存**：UI 不再打上游等超时；chat 请求零额外往返。
- **连接复用**：能加载 undici 就挂共享连接池，省重复 DNS/TLS 握手。

已实测并放弃的方向：`cache_control` prompt cache——上游 usage 里没有任何缓存字段，重复同前缀零收益，传了也白传（v1.1.0 曾内置后移除）。

真正决定首字快慢的是上游 prefill 和网络出口。本插件不再往请求路径上加任何等待。

### 网络出口（代理挂了怎么办）

系统代理（Clash 等）节点不可用时，Magpie 里所有走环境变量代理的请求都会超时（UI 显示「暂时无法获取最新额度」）。本插件可单独指定出口，不影响其他插件：

```jsonc
"proxy": "direct"                  // 强制直连（Bun 唯一可靠写法）
"proxy": "http://127.0.0.1:7897"    // 指定某个代理
```

CLI 导入同理：`bun cli/import-keys.mjs --direct keys.txt` 或 `--proxy http://127.0.0.1:7897`。

---

## 额度与并发

- 每账号每 UTC 日 **100,000,000 tokens**（里程碑活动期间 **500,000,000**；2026-11-26 实测 17 个号是 500M、
  1 个号是 520M），响应头 `x-quota-limit / used / remaining / reset`。
- 额度窗口按 Magpie 契约上报：`used` 是**百分比**（0–100），绝对用量走 `amount` + `limit`，`display` 直接显示剩余 token（如 `626,038 / 100,000,000 tokens · 99,373,962 tokens left`）。用量很小时会正确显示接近 0%（而不是把绝对数误当百分比显示成「剩余 0%」）。
- 每账号并发上限 **5**；第 6 个请求站点返回 `429 session_limit_reached`，本插件标记退避。
- 日额度耗尽 `429 daily_quota_exceeded`：本插件标记 `x-magpie-failover`，让 Magpie 自动切到下一个账号。
- `bun` 才能跑 Magpie 插件；CLI 用 `bun` 或 Node 20+ 均可（`node:test` 风格测试两者兼容）。

---

## 测试

```bash
bun test tests/plugin.test.mjs
# 或
node --test tests/plugin.test.mjs
```

37 个用例覆盖：导出形态、config 装配、智能识别/去重/截断、脱敏、登录态结构、转发分档（401/429/成功透传）、配额窗口、模型表合并与 judge 过滤、上游元数据映射、429 并发重试（成功/用尽/关闭/流式 body 不重发）、429 插件内换 Key（额度耗尽/重试耗尽后换、开关、池子读取去重）、options 收口。

---

MIT · 非官方插件，仅对接公开 API。
