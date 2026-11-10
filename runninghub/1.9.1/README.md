# RunningHub MiniMax H3 1.9.1

`minimax-h3-flash` 使用 H3 Pika 首遍工作流：Cobijada Hybrid INT8、Pika Flex LoRA 1.0、MysticXXX V5 LoRA 0.5 和 LCM 8 步 sigma。视频从原生解码节点直接输出 24 fps，不再使用 RIFE 补帧。`minimax-h3-standard` 逻辑不变。

参考素材仍由请求添加。视频帧数按 24 fps 和 H3 的 `17n+5` 规则对齐，实际成片时长可能略长于请求时长。

本地验证：`node runninghub/1.9.1/test.mjs`。
