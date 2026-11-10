# RunningHub MiniMax H3 1.9.0

`minimax-h3-flash` 使用 H3 Pika 首遍工作流（RunningHub 工作流 `2120088249770274817`）：Cobijada Hybrid INT8、Pika Flex LoRA（1.0）、MysticXXX V5 LoRA（0.5）、LCM 8 步 sigma 和 RIFE 2×。调用名称、参考素材输入及计费字段沿用原插件；`minimax-h3-standard` 的处理不变。

此工作流依赖 RunningHub 环境中的对应模型权重和自定义节点。参考素材由请求参数添加，视频帧数按 24 fps 和 H3 的 `17n+5` 规则计算，输出经 RIFE 插帧为 48 fps，因此实际成片时长可能略长于请求时长。

本地验证：`node runninghub/1.9.0/test.mjs`。
