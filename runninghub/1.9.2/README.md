# RunningHub MiniMax H3 1.9.2

兼容 new-api 新版插件规范：余额钩子由旧的 `parseBalanceResponse` 迁移为 `parseBalance`，返回值字段由 `balance` 改为新版规定的 `amount`（币种仍为 `currency`）。未更新插件会导致新版 new-api 拒绝加载该插件。

生成逻辑与 1.9.1 一致：`minimax-h3-flash` 使用 H3 Pika 首遍工作流，`minimax-h3-standard` 逻辑不变。

本地验证：`node runninghub/1.9.2/test.mjs`，以及 `new-api plugin lint runninghub/1.9.2/plugin.js`。
