# Local MiniMax H3 1.11.0

对接自建 MiniMax H3 上游的本地任务插件：`h3-nsfw`、`h3-nsfw-opt` 两个模型，按秒计费，支持 480P/720P/768P/1080P。

额外路由：

- `POST /v1/videos/:task_id/continue`：基于原任务续写
- `POST /v1/videos/:task_id/second-sampling`：二次采样

插件自身不带 baseUrl，使用渠道里配置的上游地址和密钥；参考素材通过公网 URL 传入。

本地验证：`new-api plugin lint local-h3/1.11.0/plugin.js`。
