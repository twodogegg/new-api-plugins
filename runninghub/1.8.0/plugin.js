// Embedded snapshots of the RunningHub workflows: 2113713138997743617 serves
// the standard model (its saved copy no longer contains the flash branch), and
// 2118783699809558529 serves flash. Resolve switches and media loaders per
// request and submit only the selected graph.
const MODEL = "minimax-h3-flash";
const STANDARD_MODEL = "minimax-h3-standard";
const ASSET_UPLOAD_ACTION = "asset_upload";
const FPS = 24;
const RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const RESOLUTIONS = { "480P": "854x480", "768P": "1344x768", "1080P": "1920x1080" };
const SIZES = {
  "854x480": "480P",
  "480x854": "480P",
  "480x480": "480P",
  "1344x768": "768P",
  "768x1344": "768P",
  "768x768": "768P",
  "1920x1080": "1080P",
  "1080x1920": "1080P",
  "1080x1080": "1080P",
};

export const meta = {
  apiVersion: 1,
  key: "runninghub",
  name: "RunningHub MiniMax H3",
  icon: "text:RH",
  version: "1.8.0",
  author: { name: "twodogegg", url: "https://github.com/twodogegg" },
  website: "https://www.runninghub.cn",
  baseUrl: "https://www.runninghub.cn",
  description: {
    en: "MiniMax H3 standard and Flash video generation with image, video, and audio references via RunningHub; standard also supports first and last frames",
    zh: "通过 RunningHub 生成 MiniMax H3 标准版和 Flash 视频，支持图片、视频和音频参考；标准版另支持首尾帧",
  },
  models: [MODEL, STANDARD_MODEL],
  fetchMode: "per_task",
  protocols: ["openai_video"],
  routes: [
    { method: "POST", path: "/v1/h3/assets", type: "submit", decode: "uploadAsset", render: "assetUploaded", retainResult: false },
    { method: "POST", path: "/runninghub/v2/video_generation", type: "submit", decode: "createVideo", render: "videoCreated", models: [MODEL, STANDARD_MODEL] },
    { method: "GET", path: "/runninghub/v2/query/video_generation/:task_id", type: "query", render: "videoStatus" },
  ],
  usageSchema: {
    seconds: { type: "number", unit: "second", description: { en: "Video generation unit price", zh: "视频生成单价" } },
    resolution: { enum: ["480P", "768P", "1080P"], description: { en: "Output video resolution", zh: "输出视频分辨率" } },
  },
  usageExamples: [
    { label: "480P", facts: { seconds: 124 / FPS, resolution: "480P" } },
    { label: "768P", facts: { seconds: 124 / FPS, resolution: "768P" } },
    { label: "1080P", facts: { seconds: 243 / FPS, resolution: "1080P" } },
  ],
  usageProfiles: [
    {
      models: [STANDARD_MODEL],
      schema: {
        seconds: { type: "number", unit: "second", description: { en: "Video generation unit price", zh: "视频生成单价" } },
        resolution: { enum: ["480P", "768P"], description: { en: "Output video resolution", zh: "输出视频分辨率" } },
      },
      examples: [
        { label: "480P", facts: { seconds: 124 / FPS, resolution: "480P" } },
        { label: "768P", facts: { seconds: 124 / FPS, resolution: "768P" } },
      ],
    },
  ],
};

export function buildBalanceRequest(ctx) {
  return {
    url: ctx.baseUrl.replace(/\/+$/, "") + "/uc/openapi/accountStatus",
    method: "POST",
    headers: { Authorization: "Bearer " + ctx.apiKey, "Content-Type": "application/json" },
    body: { apikey: ctx.apiKey },
  };
}

export function parseBalanceResponse(_ctx, response) {
  const body = response.body;
  if (!object(body) || body.code !== 0 || !object(body.data)) throw new Error("RunningHub account query failed");
  const value = body.data.remainMoney;
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+(\.\d+)?$/.test(String(value)))
    throw new Error("RunningHub account response is missing a valid cash balance");
  const balance = Number(value);
  if (!Number.isFinite(balance)) throw new Error("RunningHub cash balance must be finite");
  const currency = body.data.currency;
  if (currency !== "CNY" && currency !== "USD") throw new Error("RunningHub account currency is unsupported");
  // RH coins are a separate credit balance, not USD or CNY cash.
  return { balance: balance, currency: currency };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mediaList(value, name, maximum) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > maximum) throw new Error(name + " accepts at most " + maximum + " references");
  return values.map(function (item) {
    if (typeof item !== "string" || !item.trim()) throw new Error(name + " must contain non-empty media URLs or RunningHub filenames");
    const path = item.trim();
    // RunningHub's official loading nodes accept public URLs or filenames
    // returned by its upload API. Local paths and data URIs are not uploads.
    const uploadedFile =
      /^(api|openapi)\/[A-Za-z0-9_./-]+$/.test(path) &&
      !path.split("/").some(function (part) {
        return part === "." || part === "..";
      });
    if (!/^https?:\/\/[^\s]+$/.test(path) && !uploadedFile) {
      throw new Error(name + " requires a public HTTP(S) URL or a RunningHub api/ or openapi/ filename");
    }
    return path;
  });
}

function canonicalRequest(ctx, req) {
  if (!object(req)) throw new Error("request body must be an object");
  const model = ctx.upstreamModel || ctx.model;
  if (![MODEL, STANDARD_MODEL].includes(model)) throw new Error("unsupported RunningHub model");
  if (typeof req.prompt !== "string" || !req.prompt.trim()) throw new Error("prompt is required");
  if (req.metadata !== undefined && !object(req.metadata)) throw new Error("metadata must be an object");
  const metadata = req.metadata || {};
  if (metadata.content !== undefined) throw new Error("use the MiniMax native endpoint for content inputs");
  const rawSeconds = req.seconds === undefined ? (req.duration === undefined ? 5 : req.duration) : req.seconds;
  const seconds = Number(rawSeconds);
  if ((typeof rawSeconds !== "number" && typeof rawSeconds !== "string") || !Number.isInteger(seconds) || seconds < 4 || seconds > 15) {
    throw new Error("seconds must be an integer between 4 and 15");
  }
  if (req.seconds !== undefined && req.duration !== undefined && Number(req.duration) !== seconds) throw new Error("seconds and duration must match");
  const rawSize = req.size === undefined ? "480P" : req.size;
  const size =
    typeof rawSize === "string" && Object.prototype.hasOwnProperty.call(RESOLUTIONS, rawSize.toUpperCase()) ? RESOLUTIONS[rawSize.toUpperCase()] : rawSize;
  if (typeof size !== "string" || !Object.prototype.hasOwnProperty.call(SIZES, size)) {
    throw new Error("size must be 480P, 768P, 1080P, or one of " + Object.keys(SIZES).join(", "));
  }
  if (model === STANDARD_MODEL && SIZES[size] === "1080P") throw new Error("minimax-h3-standard supports only 480P and 768P");
  if (req.images !== undefined && !Array.isArray(req.images)) throw new Error("images must be an array");
  const images = Array.from(
    new Set(
      mediaList(req.input_reference, "input_reference", 1).concat(
        mediaList(req.images, "images", 9),
        mediaList(metadata.reference_images, "metadata.reference_images", 9)
      )
    )
  );
  if (images.length > 9) throw new Error("at most 9 reference images are supported");
  const videos = mediaList(metadata.reference_video, "metadata.reference_video", 3);
  const audios = mediaList(metadata.reference_audio, "metadata.reference_audio", 3);
  const frames = {};
  for (const name of ["first_frame_image", "last_frame_image"]) {
    if (metadata[name] === undefined) continue;
    if (typeof metadata[name] !== "string") throw new Error(name + " must be a single image URL or RunningHub filename");
    frames[name] = mediaList(metadata[name], name, 1)[0];
  }
  if (Object.keys(frames).length && (images.length || videos.length || audios.length)) throw new Error("cannot mix first/last frames with reference media");
  if (Object.keys(frames).length && model === MODEL)
    throw new Error("minimax-h3-flash does not support first and last frame images; use minimax-h3-standard for frame-conditioned generation");
  if (req.ratio !== undefined && !RATIOS.includes(req.ratio)) throw new Error("ratio must be one of " + RATIOS.join(", "));
  if (req.ratio === "adaptive" && !Object.keys(frames).length && !images.length && !videos.length)
    throw new Error("ratio adaptive requires an image or video input");
  const normalized = {
    model: ctx.model,
    prompt: req.prompt.trim(),
    seconds: seconds,
    size: size,
    images: images,
    metadata: Object.assign({ reference_video: videos, reference_audio: audios }, frames),
  };
  if (req.ratio !== undefined) normalized.ratio = req.ratio;
  return normalized;
}

function usage(req) {
  // The workflow rounds UP to 17k+5 frames. Reserve the duration actually sent
  // to the sampler, not the shorter requested duration or GPU execution time.
  const frames = req.seconds * FPS;
  return { seconds: (frames + ((5 - (frames % 17) + 17) % 17)) / FPS, resolution: SIZES[req.size] };
}

// Lazy switches are evaluated here so unselected models, missing placeholder
// files, and browser group-control nodes never reach the provider executor.
function activeWorkflow(workflow, root) {
  const active = {};
  const pending = [root];
  while (pending.length) {
    const id = pending.pop();
    if (active[id]) continue;
    const node = workflow[id];
    for (const name of Object.keys(node.inputs)) {
      let value = node.inputs[name];
      while (Array.isArray(value) && workflow[value[0]] && workflow[value[0]].class_type === "LazySwitchKJ") {
        const inputs = workflow[value[0]].inputs;
        const enabled = workflow[inputs.switch[0]].inputs.value;
        value = inputs[enabled ? "on_true" : "on_false"];
      }
      node.inputs[name] = value;
      if (Array.isArray(value) && value.length === 2 && workflow[value[0]]) pending.push(value[0]);
    }
    active[id] = node;
  }
  return active;
}

export function buildSubmitRequest(ctx) {
  if (ctx.action === ASSET_UPLOAD_ACTION) {
    if (!Array.isArray(ctx.files) || ctx.files.length !== 1) throw new Error("exactly one file is required");
    const file = ctx.files[0];
    return {
      url: ctx.baseUrl.replace(/\/+$/, "") + "/openapi/v2/media/upload/binary",
      method: "POST",
      headers: { Accept: "application/json", Authorization: "Bearer " + ctx.apiKey },
      bodyType: "multipart",
      parts: [{ name: "file", fileRef: file.ref, filename: file.filename }],
    };
  }
  const req = canonicalRequest(ctx, ctx.requestBody);
  const standard = (ctx.upstreamModel || ctx.model) === STANDARD_MODEL;
  const firstLast = Boolean(req.metadata.first_frame_image || req.metadata.last_frame_image);
  const workflow = utils.json.clone(standard ? WORKFLOW : FLASH_WORKFLOW);
  if (standard) {
    workflow["400"].inputs.value = firstLast;
    workflow["420"].inputs.value = false;
  }
  const conditioningNode = standard ? (firstLast ? "1403" : "1136") : "136";
  const decodeNode = standard ? "1122" : "122";
  const outputNode = standard ? "243" : "130";
  const seedNode = standard ? "1129" : "129";
  const promptNode = standard ? (firstLast ? "409" : "2") : "138";
  const secondsNode = standard ? "17" : "132";
  workflow[promptNode].inputs.value = req.prompt;
  workflow[secondsNode].inputs.value = req.seconds;
  let dimensions = req.size.split("x").map(Number);
  const shortEdge = Math.min(dimensions[0], dimensions[1]);
  const maximumPixels = dimensions[0] * dimensions[1];
  if (req.ratio === "adaptive") {
    // Read geometry inside ComfyUI after the normal media loader. This also
    // works for RunningHub upload filenames and the first reference-video frame.
    const imageNode = standard
      ? req.metadata.first_frame_image ? "274" : req.metadata.last_frame_image ? "277" : req.images.length ? "274" : "301"
      : req.images.length ? "200" : "221";
    workflow["900"] = { class_type: "GetImageSize", inputs: { image: [imageNode, 0] } };
    // Bound the canvas even when a remote image has an extreme aspect ratio.
    const maximumEdge = Math.ceil(Math.sqrt(maximumPixels * 2.5) / 32) * 32;
    for (const axis of ["width", "height"]) {
      const id = axis === "width" ? "901" : "902";
      const input = axis === "width" ? "a" : "b";
      const fitted = "round(" + input + " * min(" + shortEdge + " / min(a, b), sqrt(" + maximumPixels + " / (a * b))) / 32) * 32";
      const expression = "max(32, min(" + maximumEdge + ", " + fitted + "))";
      workflow[id] = {
        class_type: "ComfyMathExpression",
        inputs: {
          expression: expression,
          "values.a": ["900", 0],
          "values.b": ["900", 1],
        },
      };
      workflow[conditioningNode].inputs[axis] = [id, 1];
    }
  } else {
    if (req.ratio) {
      if (req.ratio === "16:9") dimensions = [Math.max(dimensions[0], dimensions[1]), shortEdge];
      else if (req.ratio === "9:16") dimensions = [shortEdge, Math.max(dimensions[0], dimensions[1])];
      else if (req.ratio === "1:1") dimensions = [shortEdge, shortEdge];
      else {
        const ratio = req.ratio.split(":").map(Number);
        const scale = Math.min(shortEdge / Math.min(ratio[0], ratio[1]), Math.sqrt(maximumPixels / (ratio[0] * ratio[1])));
        dimensions = ratio.map(function (value) {
          return Math.max(2, 2 * Math.round((value * scale) / 2));
        });
      }
    }
    const width = Math.ceil(dimensions[0] / 32) * 32;
    const height = Math.ceil(dimensions[1] / 32) * 32;
    workflow[conditioningNode].inputs.width = width;
    workflow[conditioningNode].inputs.height = height;
    // H3 samples on a 32-pixel canvas; crop the decoded video back to the
    // requested output size.
    const outputWidth = width;
    const outputHeight = height;
    if (outputWidth !== dimensions[0] || outputHeight !== dimensions[1]) {
      workflow["322"] = {
        class_type: "ImageCrop",
        inputs: { image: [decodeNode, 0], width: dimensions[0], height: dimensions[1], x: (outputWidth - dimensions[0]) / 2, y: (outputHeight - dimensions[1]) / 2 },
      };
      workflow[outputNode].inputs.images = ["322", 0];
    }
  }
  const seed = parseInt(utils.hmacSHA256(ctx.publicTaskId || utils.uuid(), "runninghub-h3-seed").slice(0, 13), 16);
  workflow[seedNode].inputs.noise_seed = seed;
  const references = standard
    ? firstLast
      ? [
          {
            values: req.metadata.first_frame_image ? [req.metadata.first_frame_image] : [],
            ids: ["274"],
            type: "LoadImage",
            field: "image",
            input: "first_frame",
          },
          { values: req.metadata.last_frame_image ? [req.metadata.last_frame_image] : [], ids: ["277"], type: "LoadImage", field: "image", input: "last_frame" },
        ]
      : [
          {
            values: req.images,
            ids: ["274", "277", "280", "283", "286", "289", "292", "295", "298"],
            type: "LoadImage",
            field: "image",
            input: "ref_images.ref_image_",
          },
          { values: req.metadata.reference_video, ids: ["301", "304", "307"], type: "VHS_LoadVideo", field: "video", input: "ref_videos.ref_video_" },
          { values: req.metadata.reference_audio, ids: ["310", "313", "316"], type: "LoadAudio", field: "audio", input: "ref_audios.ref_audio_" },
        ]
    : [
        {
          values: req.images,
          ids: ["200", "201", "202", "203", "204", "205", "206", "207", "208"],
          type: "LoadImage",
          field: "image",
          input: "ref_images.ref_image_",
        },
        { values: req.metadata.reference_video, ids: ["220", "222", "224"], type: "LoadVideo", field: "file", input: "ref_videos.ref_video_" },
        { values: req.metadata.reference_audio, ids: ["240", "241", "242"], type: "LoadAudio", field: "audio", input: "ref_audios.ref_audio_" },
      ];
  for (const reference of references) {
    reference.values.forEach(function (value, index) {
      const id = reference.ids[index];
      const inputs = {};
      inputs[reference.field] = value;
      if (reference.type === "VHS_LoadVideo")
        Object.assign(inputs, {
          force_rate: FPS,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 120,
          skip_first_frames: 0,
          select_every_nth: 1,
          format: "None",
          force_size: "Disabled",
        });
      if (reference.type === "LoadAudio") inputs.audioUI = "";
      workflow[id] = { class_type: reference.type, inputs: inputs };
      let source = id;
      if (reference.type === "LoadVideo") {
        source = String(Number(id) + 1);
        workflow[source] = { class_type: "GetVideoComponents", inputs: { video: [id, 0] } };
      }
      workflow[conditioningNode].inputs[firstLast ? reference.input : reference.input + index] = [source, 0];
    });
  }
  return {
    url: ctx.baseUrl.replace(/\/+$/, "") + "/task/openapi/create",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.apiKey },
    body: {
      apiKey: ctx.apiKey,
      workflowId: standard ? "2113713138997743617" : "2118783699809558529",
      workflow: JSON.stringify(activeWorkflow(workflow, standard ? "243" : "145")),
      instanceType: SIZES[req.size] === "480P" ? "default" : "plus",
      nodeInfoList: [{ nodeId: seedNode, fieldName: "noise_seed", fieldValue: seed }],
    },
  };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  // Asset uploads generate no video: report zero facts over the usage schema
  // so any per-unit task expression evaluates to $0 instead of failing on
  // missing usage keys.
  if (ctx.action === ASSET_UPLOAD_ACTION) return { seconds: 0, resolution: "480P" };
  return usage(canonicalRequest(ctx, ctx.requestBody));
}

export function parseSubmitResponse(ctx, response) {
  const body = response.body;
  if (ctx.action === ASSET_UPLOAD_ACTION) {
    if (!object(body) || body.code !== 0 || !object(body.data)) throw new Error("RunningHub upload failed");
    const data = body.data;
    if (typeof data.fileName !== "string" || !/^(api|openapi)\/[A-Za-z0-9_./-]+$/.test(data.fileName))
      throw new Error("RunningHub upload response is missing a valid fileName");
    return {
      taskId: data.fileName,
      taskData: { fileName: data.fileName, type: data.type, size: data.size },
      immediate: { status: "SUCCESS", progress: "100%" },
    };
  }
  if (!object(body) || body.code !== 0 || !object(body.data))
    throw new Error("RunningHub submission failed: " + ((object(body) && body.msg) || "invalid response"));
  const data = body.data;
  // A numeric snowflake ID has already lost precision in JSON/JavaScript.
  if (typeof data.taskId !== "string" || !data.taskId.trim()) throw new Error("RunningHub taskId must be a non-empty string");
  const req = canonicalRequest(ctx, ctx.requestBody);
  const result = {
    taskId: data.taskId,
    taskData: { taskId: data.taskId, status: data.taskStatus },
    state: { usage: usage(req) },
  };
  if (data.taskStatus === "FAILED") result.immediate = { status: "FAILURE", reason: "RunningHub rejected the workflow", progress: "100%" };
  return result;
}

export function buildQueryRequest(ctx) {
  return {
    url: ctx.baseUrl.replace(/\/+$/, "") + "/openapi/v2/query",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.apiKey },
    body: { taskId: ctx.taskId },
  };
}

function videoResult(body) {
  if (!object(body) || !Array.isArray(body.results)) return null;
  for (const result of body.results) {
    if (!object(result) || typeof result.url !== "string" || !/^https?:\/\/[^\s]+$/.test(result.url)) continue;
    const type = String(result.outputType || "").toLowerCase();
    if (["mp4", "video", "video/mp4"].includes(type) || /\.mp4(?:[?#]|$)/i.test(result.url)) return result;
  }
  return null;
}

export function parseTaskResult(ctx, body) {
  if (!object(body) || (body.taskId !== undefined && body.taskId !== ctx.taskId)) return { status: "UNKNOWN", reason: "unexpected RunningHub task response" };
  const statuses = { QUEUED: "QUEUED", RUNNING: "IN_PROGRESS", SUCCESS: "SUCCESS", FAILED: "FAILURE", CANCELLED: "FAILURE" };
  const status = typeof body.status === "string" && Object.prototype.hasOwnProperty.call(statuses, body.status) ? statuses[body.status] : null;
  if (!status) return { status: "UNKNOWN", reason: "unrecognized RunningHub status" };
  const result = { status: status, progress: status === "QUEUED" ? "0%" : status === "IN_PROGRESS" ? "50%" : "100%" };
  if (status === "SUCCESS") {
    const video = videoResult(body);
    if (!video) return { status: "UNKNOWN", reason: "RunningHub completed without an MP4 video" };
    result.url = video.url;
  }
  if (status === "FAILURE") result.reason = (typeof body.errorMessage === "string" && body.errorMessage) || "RunningHub task failed";
  return result;
}

export function extractUsageOnComplete(ctx, result, _body) {
  // Query v2 does not report generated video duration. Keep the frozen,
  // frame-aligned estimate; results.taskCostTime is compute time, not video time.
  if (result.status !== "SUCCESS" || !object(ctx.state) || !object(ctx.state.usage)) return null;
  const facts = ctx.state.usage;
  if (
    typeof facts.seconds !== "number" ||
    !Number.isFinite(facts.seconds) ||
    facts.seconds < 4 ||
    facts.seconds > 362 / FPS ||
    !["480P", "768P", "1080P"].includes(facts.resolution)
  )
    return null;
  return { seconds: facts.seconds, resolution: facts.resolution };
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" && videoResult(task.data) ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : [];
}

export function buildContentRequest(ctx) {
  const video = videoResult(ctx.data);
  if (ctx.artifactKey !== "video" || !video) throw new Error("artifact_not_found");
  return { url: video.url, method: ctx.clientRequest.method, credentialless: true };
}

export const native = {
  uploadAsset: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "multipart") throw new Error("multipart body required");
    if (!Array.isArray(ctx.body.files) || ctx.body.files.length !== 1) throw new Error("exactly one file is required");
    const file = ctx.body.files[0];
    if (file.field !== "file") throw new Error("file field is required");
    return {
      kind: "submit",
      model: MODEL,
      action: ASSET_UPLOAD_ACTION,
      requestBody: { fileRef: file.ref, filename: file.filename, mimeType: file.mimeType, size: file.size },
    };
  },
  assetUploaded: function (_ctx, task) {
    const data = object(task && task.data) ? task.data : {};
    if (typeof data.fileName !== "string" || !/^(api|openapi)\/[A-Za-z0-9_./-]+$/.test(data.fileName))
      throw new Error("RunningHub upload did not return a valid fileName");
    return {
      id: data.fileName,
      fileName: data.fileName,
      type: typeof data.type === "string" ? data.type : "",
      size: typeof data.size === "string" || typeof data.size === "number" ? data.size : "",
      expires_in: 86400,
    };
  },
  createVideo: function (ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const body = ctx.body.value;
    if (!object(body)) throw new Error("request body must be an object");
    if (!Array.isArray(body.content) || !body.content.length) throw new Error("content must be a non-empty array");
    if (body.resolution === undefined) throw new Error("resolution is required");
    if (typeof body.duration !== "number") throw new Error("duration must be an integer between 4 and 15");
    if (body.callback_url !== undefined && body.callback_url !== null && body.callback_url !== "")
      throw new Error("callback_url is not supported; poll the task query endpoint");
    if (body.extra !== undefined) throw new Error("extra is not supported by these RunningHub models");
    const texts = [];
    const images = [];
    const metadata = { reference_video: [], reference_audio: [] };
    for (const item of body.content) {
      if (!object(item)) throw new Error("each content item must be an object");
      if (item.type === "text") {
        if (typeof item.text !== "string" || Array.from(item.text).length > 7000) throw new Error("content text must be a string of at most 7000 characters");
        if (item.text.trim()) texts.push(item.text.trim());
        continue;
      }
      if (!["image_url", "video_url", "audio_url"].includes(item.type) || !object(item[item.type]))
        throw new Error("unsupported content item type or media object");
      const url = item[item.type].url;
      if (typeof url !== "string" || !url.trim()) throw new Error("content media requires a non-empty URL or RunningHub filename");
      const role =
        item.role === undefined ? (item.type === "image_url" ? "first_frame" : item.type === "video_url" ? "reference_video" : "reference_audio") : item.role;
      if (item.type === "image_url" && ["first_frame", "last_frame"].includes(role)) {
        const key = role + "_image";
        if (metadata[key] !== undefined) throw new Error("at most one " + role + " image is supported");
        metadata[key] = mediaList(url, role, 1)[0];
        if (!metadata[key]) throw new Error(role + " requires an image URL");
      } else if (item.type === "image_url" && role === "reference_image") images.push(url);
      else if (item.type === "video_url" && role === "reference_video") metadata.reference_video.push(url);
      else if (item.type === "audio_url" && role === "reference_audio") metadata.reference_audio.push(url);
      else throw new Error("unsupported content role for " + item.type);
    }
    if (!texts.length) throw new Error("content must include a non-empty text item");
    if (body.ratio !== undefined && !RATIOS.includes(body.ratio)) throw new Error("ratio must be one of " + RATIOS.join(", "));
    const hasFrames = Boolean(metadata.first_frame_image || metadata.last_frame_image);
    const visual = hasFrames || images.length || metadata.reference_video.length;
    if (!visual && !metadata.reference_audio.length && (body.ratio === undefined || body.ratio === "adaptive"))
      throw new Error("text-to-video requires a concrete ratio");
    const requestBody = canonicalRequest(
      { model: body.model },
      {
        prompt: texts.join("\n"),
        seconds: body.duration,
        size: body.resolution,
        images: images,
        metadata: metadata,
        ratio: hasFrames ? "adaptive" : body.ratio === undefined ? (visual ? "adaptive" : "16:9") : body.ratio,
      }
    );
    // aigc_watermark is accepted in any form, deliberately omitted from the
    // normalized request, and never forwarded to the workflow.
    return { kind: "submit", model: body.model, action: visual ? "image_to_video" : "text_to_video", requestBody: requestBody };
  },
  videoCreated: function (_ctx, task) {
    return { task_id: task.task_id };
  },
  videoStatus: function (_ctx, task) {
    const statuses = { NOT_START: "queued", SUBMITTED: "queued", QUEUED: "queued", IN_PROGRESS: "running", SUCCESS: "succeeded", FAILURE: "failed" };
    const output = {
      id: task.task_id,
      model: task.model || "",
      status: statuses[task.status] || "unknown",
      created_at: task.created_at,
      updated_at: task.updated_at,
      task_type: "generation",
      modality: "video",
    };
    const video = videoResult(task.data);
    if (task.status === "SUCCESS" && video) output.content = { url: video.url };
    if (task.status === "FAILURE") output.error = { code: "task_failed", message: task.fail_reason || "RunningHub task failed" };
    return { task: output };
  },
  error: function (_ctx, error) {
    const types = {
      400: "bad_request_error",
      401: "authorized_error",
      402: "insufficient_balance_error",
      403: "permission_error",
      404: "not_found_error",
      429: "rate_limit_error",
    };
    return { type: "error", error: { type: types[error.httpStatus] || "server_error", message: error.message, http_code: String(error.httpStatus) } };
  },
};

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) throw new Error("JSON or multipart body required");
      let req;
      if (ctx.body.kind === "json") req = ctx.body.value;
      else {
        if ((ctx.body.files || []).length) throw new Error("Upload reference files to RunningHub first, then pass their URLs or filenames in input_reference");
        req = {};
        for (const name of Object.keys(ctx.body.fields || {})) {
          const values = ctx.body.fields[name];
          if (values.length !== 1) throw new Error(name + " must be provided once");
          req[name] = values[0];
        }
        if (req.metadata !== undefined) {
          try {
            req.metadata = JSON.parse(req.metadata);
          } catch (e) {
            throw new Error("metadata must be a JSON object string", { cause: e });
          }
        }
      }
      const requestBody = canonicalRequest(ctx, req);
      return {
        kind: "submit",
        model: ctx.model,
        action:
          requestBody.images.length ||
          requestBody.metadata.reference_video.length ||
          requestBody.metadata.first_frame_image ||
          requestBody.metadata.last_frame_image
            ? "image_to_video"
            : "text_to_video",
        requestBody: requestBody,
      };
    },
    render: function (_ctx, task) {
      const video = videoResult(task.data);
      const result = video ? { url: video.url } : {};
      if (task.status === "FAILURE") result.error = { code: "task_failed", message: task.fail_reason || "RunningHub task failed" };
      return result;
    },
  },
};

// Standard model graph; sample media and prompts are deliberately omitted.
const WORKFLOW = {
  1142: {
    class_type: "PathchSageAttentionKJ",
    inputs: {
      sage_attention: "auto",
      model: ["1406", 0],
      allow_compile: false,
    },
  },
  233: {
    class_type: "SelfLiftH3Sampler",
    inputs: {
      upscaler_model: "minimax_h3_latent_upscaler_3d_fp32_v2.pth",
      latent_image: ["408", 0],
      seed: 0,
      upscaler_unload: true,
      cfg: 1,
      w_max: 1,
      transition_step: 4,
      positive: ["407", 0],
      lowres_scale: 0.4000000000000001,
      sampler: ["240", 0],
      negative: ["236", 0],
      w_min: 0.5,
      rho: 0,
      model: ["218", 0],
      vae: ["3", 0],
      sigmas: ["241", 0],
      highres_tiling: false,
    },
  },
  1136: {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: {
      length: ["1131", 1],
      ref_image_size: "max",
      audio_vae: ["4", 0],
      width: ["1115", 0],
      vae: ["1119", 0],
      prompt: ["2", 0],
      clip: ["1128", 0],
      height: ["1115", 1],
    },
  },
  236: {
    class_type: "ConditioningZeroOut",
    inputs: {
      conditioning: ["407", 0],
    },
  },
  11: {
    class_type: "MiniMaxH3ReferenceToVideo",
    inputs: {
      length: ["19", 1],
      ref_image_size: "max",
      audio_vae: ["4", 0],
      width: ["20", 0],
      vae: ["3", 0],
      prompt: ["2", 0],
      clip: ["15", 0],
      height: ["20", 1],
    },
  },
  15: {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      type: "minimax",
      device: "default",
    },
  },
  17: {
    class_type: "PrimitiveFloat",
    inputs: {
      value: 5,
    },
  },
  19: {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
      "values.a": ["17", 0],
    },
  },
  240: {
    class_type: "KSamplerSelect",
    inputs: {
      sampler_name: "euler",
    },
  },
  241: {
    class_type: "BasicScheduler",
    inputs: {
      scheduler: "beta",
      denoise: 1,
      model: ["218", 0],
      steps: 8,
    },
  },
  121: {
    class_type: "LoraLoaderModelOnly",
    inputs: {
      lora_name: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
      strength_model: 1,
      model: ["30", 0],
    },
  },
  243: {
    class_type: "VHS_VideoCombine",
    inputs: {
      images: ["421", 0],
      pix_fmt: "yuv420p",
      format: "video/h264-mp4",
      frame_rate: 24,
      pingpong: false,
      save_output: true,
      filename_prefix: "minimaxh3",
      loop_count: 0,
      save_metadata: true,
      crf: 19,
      trim_to_audio: false,
      no_preview: false,
      audio: ["422", 0],
    },
  },
  2: {
    class_type: "PrimitiveStringMultiline",
    inputs: {
      value: "",
    },
  },
  244: {
    class_type: "VAEDecode",
    inputs: {
      vae: ["3", 0],
      samples: ["233", 0],
    },
  },
  3: {
    class_type: "VAELoader",
    inputs: {
      vae_name: "minimax_h3_lightvae_lite_vae_int8_convrot.safetensors",
    },
  },
  245: {
    class_type: "VAEDecodeAudio",
    inputs: {
      vae: ["4", 0],
      samples: ["233", 0],
    },
  },
  4: {
    class_type: "VAELoader",
    inputs: {
      vae_name: "minimax_h3_audio_vae_fp32.safetensors",
    },
  },
  400: {
    class_type: "PrimitiveBoolean",
    inputs: {
      value: false,
    },
  },
  401: {
    class_type: "UNETLoader",
    inputs: {
      weight_dtype: "default",
      unet_name: "minimax_h3_hybrid_fl2va_ref2va_b25-49-int8_r.safetensors",
    },
  },
  402: {
    class_type: "LoraLoaderModelOnly",
    inputs: {
      lora_name: "minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors",
      strength_model: 1,
      model: ["401", 0],
    },
  },
  403: {
    class_type: "MiniMaxH3ImageToVideo",
    inputs: {
      width: ["20", 0],
      length: ["19", 1],
      vae: ["3", 0],
      prompt: ["409", 0],
      clip: ["15", 0],
      height: ["20", 1],
    },
  },
  406: {
    class_type: "LazySwitchKJ",
    inputs: {
      on_false: ["121", 0],
      on_true: ["402", 0],
      switch: ["400", 0],
    },
  },
  407: {
    class_type: "LazySwitchKJ",
    inputs: {
      on_false: ["11", 0],
      on_true: ["403", 0],
      switch: ["400", 0],
    },
  },
  408: {
    class_type: "LazySwitchKJ",
    inputs: {
      on_false: ["11", 1],
      on_true: ["403", 1],
      switch: ["400", 0],
    },
  },
  409: {
    class_type: "PrimitiveStringMultiline",
    inputs: {
      value: "",
    },
  },
  20: {
    class_type: "ResolutionSelector",
    inputs: {
      aspect_ratio: "16:9 (Widescreen)",
      megapixels: 1,
      multiple: 32,
    },
  },
  1121: {
    class_type: "VAEDecodeAudio",
    inputs: {
      vae: ["4", 0],
      samples: ["1125", 0],
    },
  },
  250: {
    class_type: "ModelAttentionBackend",
    inputs: {
      attention: "comfy kitchen attention",
      model: ["148", 0],
    },
  },
  1115: {
    class_type: "ResolutionSelector",
    inputs: {
      aspect_ratio: "16:9 (Widescreen)",
      megapixels: 0.4,
      multiple: 32,
    },
  },
  218: {
    class_type: "BlockSparseAttention",
    inputs: {
      selection: "sol-attn",
      extra_tokens: 256,
      "selection.tau": 1.3,
      dense_blocks: "",
      start_percent: 0.2,
      model: ["250", 0],
      end_percent: 0.9000000000000001,
      sink_conditioning: "exact_kv_and_rows",
      min_tokens: 12288,
      verbose: false,
    },
  },
  30: {
    class_type: "UNETLoader",
    inputs: {
      weight_dtype: "default",
      unet_name: "Minimax-h3_Singularity_ref2va_v2_int8.safetensors",
    },
  },
  1119: {
    class_type: "VAELoader",
    inputs: {
      vae_name: "minimax_h3_video_vae_fp16.safetensors",
    },
  },
  1131: {
    class_type: "ComfyMathExpression",
    inputs: {
      expression: "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
      "values.a": ["17", 0],
    },
  },
  1129: {
    class_type: "RandomNoise",
    inputs: {
      noise_seed: 0,
    },
  },
  1128: {
    class_type: "CLIPLoader",
    inputs: {
      clip_name: "qwen3vl_32b_h3_ultra_uncensored_heretic_int8_convrot.safetensors",
      type: "minimax",
      device: "default",
    },
  },
  1403: {
    class_type: "MiniMaxH3ImageToVideo",
    inputs: {
      width: ["1115", 0],
      length: ["1131", 1],
      vae: ["1119", 0],
      prompt: ["409", 0],
      clip: ["1128", 0],
      height: ["1115", 1],
    },
  },
  420: {
    class_type: "PrimitiveBoolean",
    inputs: {
      value: false,
    },
  },
  1127: {
    class_type: "UNETLoader",
    inputs: {
      weight_dtype: "default",
      unet_name: "Minimax-h3_Singularity_ref2va-v2_int8.safetensors",
    },
  },
  421: {
    class_type: "LazySwitchKJ",
    inputs: {
      on_false: ["1122", 0],
      on_true: ["244", 0],
      switch: ["420", 0],
    },
  },
  1126: {
    class_type: "BasicGuider",
    inputs: {
      conditioning: ["1407", 0],
      model: ["1142", 0],
    },
  },
  422: {
    class_type: "LazySwitchKJ",
    inputs: {
      on_false: ["1121", 0],
      on_true: ["245", 0],
      switch: ["420", 0],
    },
  },
  1125: {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      guider: ["1126", 0],
      latent_image: ["1408", 0],
      noise: ["1129", 0],
      sigmas: ["1124", 0],
      sampler: ["1123", 0],
    },
  },
  148: {
    class_type: "MiniMaxH3MemoryEfficientSageAttentionPatch",
    inputs: {
      model: ["406", 0],
    },
  },
  1124: {
    class_type: "BasicScheduler",
    inputs: {
      scheduler: "simple",
      denoise: 1,
      model: ["1142", 0],
      steps: 35,
    },
  },
  1123: {
    class_type: "KSamplerSelect",
    inputs: {
      sampler_name: "res_multistep",
    },
  },
  1122: {
    class_type: "VAEDecode",
    inputs: {
      vae: ["1119", 0],
      samples: ["1125", 0],
    },
  },
  1408: {
    class_type: "LazySwitchKJ",
    inputs: {
      on_false: ["1136", 1],
      on_true: ["1403", 1],
      switch: ["400", 0],
    },
  },
  1407: {
    class_type: "LazySwitchKJ",
    inputs: {
      on_false: ["1136", 0],
      on_true: ["1403", 0],
      switch: ["400", 0],
    },
  },
  1406: {
    class_type: "LazySwitchKJ",
    inputs: {
      on_false: ["1127", 0],
      on_true: ["401", 0],
      switch: ["400", 0],
    },
  },
};
// API snapshot of Flash workflow 2118783699809558529; media loaders are added per request.
const FLASH_WORKFLOW = {
  "115": {
    "inputs": {
      "aspect_ratio": "16:9 (Widescreen)",
      "megapixels": 1,
      "multiple": 32
    },
    "class_type": "ResolutionSelector"
  },
  "119": {
    "inputs": {
      "vae_name": "minimax_h3_video_vae_fp16.safetensors"
    },
    "class_type": "VAELoader"
  },
  "120": {
    "inputs": {
      "vae_name": "minimax_h3_audio_vae_fp32.safetensors"
    },
    "class_type": "VAELoader"
  },
  "121": {
    "inputs": {
      "samples": [
        "125",
        0
      ],
      "vae": [
        "120",
        0
      ]
    },
    "class_type": "VAEDecodeAudio"
  },
  "122": {
    "inputs": {
      "samples": [
        "125",
        0
      ],
      "vae": [
        "119",
        0
      ]
    },
    "class_type": "VAEDecode"
  },
  "123": {
    "inputs": {
      "sampler_name": "euler"
    },
    "class_type": "KSamplerSelect"
  },
  "124": {
    "inputs": {
      "scheduler": "simple",
      "steps": 8,
      "denoise": 1,
      "model": [
        "146",
        0
      ]
    },
    "class_type": "BasicScheduler"
  },
  "125": {
    "inputs": {
      "noise": [
        "129",
        0
      ],
      "guider": [
        "126",
        0
      ],
      "sampler": [
        "123",
        0
      ],
      "sigmas": [
        "149",
        0
      ],
      "latent_image": [
        "136",
        1
      ]
    },
    "class_type": "SamplerCustomAdvanced"
  },
  "126": {
    "inputs": {
      "model": [
        "146",
        0
      ],
      "conditioning": [
        "136",
        0
      ]
    },
    "class_type": "BasicGuider"
  },
  "127": {
    "inputs": {
      "unet_name": "singularityV2X10eros_prism.safetensors",
      "weight_dtype": "default"
    },
    "class_type": "UNETLoader"
  },
  "128": {
    "inputs": {
      "clip_name": "qwen3vl_32b_h3_ultra_uncensored_heretic_int8_convrot.safetensors",
      "type": "minimax",
      "device": "default"
    },
    "class_type": "CLIPLoader"
  },
  "129": {
    "inputs": {
      "noise_seed": 471523005978424
    },
    "class_type": "RandomNoise"
  },
  "130": {
    "inputs": {
      "fps": 24,
      "bit_depth": 8,
      "color_space": "sRGB",
      "codec": "none",
      "images": [
        "122",
        0
      ],
      "audio": [
        "121",
        0
      ]
    },
    "class_type": "CreateVideo"
  },
  "131": {
    "inputs": {
      "expression": "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17",
      "values.a": [
        "132",
        0
      ]
    },
    "class_type": "ComfyMathExpression"
  },
  "132": {
    "inputs": {
      "value": 10
    },
    "class_type": "PrimitiveFloat"
  },
  "136": {
    "inputs": {
      "prompt": [
        "138",
        0
      ],
      "width": [
        "115",
        0
      ],
      "height": [
        "115",
        1
      ],
      "length": [
        "131",
        1
      ],
      "ref_image_size": "match",
      "clip": [
        "128",
        0
      ],
      "vae": [
        "119",
        0
      ],
      "audio_vae": [
        "120",
        0
      ]
    },
    "class_type": "MiniMaxH3ReferenceToVideo"
  },
  "138": {
    "inputs": {
      "value": ""
    },
    "class_type": "PrimitiveStringMultiline"
  },
  "145": {
    "inputs": {
      "filename_prefix": "video/ComfyUI",
      "format": "auto",
      "format.codec": "auto",
      "codec": "auto",
      "fw_video_preview": "",
      "video-preview": "",
      "video": [
        "130",
        0
      ]
    },
    "class_type": "SaveVideo"
  },
  "146": {
    "inputs": {
      "selection": "sol-attn",
      "selection.tau": 1,
      "start_percent": 0.2,
      "end_percent": 1,
      "dense_blocks": "",
      "min_tokens": 12288,
      "extra_tokens": 256,
      "sink_conditioning": "exact_kv_and_rows",
      "verbose": false,
      "model": [
        "147",
        0
      ]
    },
    "class_type": "BlockSparseAttention"
  },
  "147": {
    "inputs": {
      "attention": "comfy kitchen attention",
      "model": [
        "152",
        0
      ]
    },
    "class_type": "ModelAttentionBackend"
  },
  "148": {
    "inputs": {
      "lora_name": "minimax_h3_ref2v_turbo_8step_v1.1_768p_comfyui_bf16.safetensors",
      "strength_model": 1,
      "model": [
        "127",
        0
      ]
    },
    "class_type": "LoraLoaderModelOnly"
  },
  "149": {
    "inputs": {
      "steps": 3,
      "start_at_sigma": 0.65,
      "end_at_sigma": 0,
      "spacing": "linear",
      "sigmas": [
        "124",
        0
      ]
    },
    "class_type": "ExtendIntermediateSigmas"
  },
  "152": {
    "inputs": {
      "lora_name": "MysticXXX_MMH3-V5-ref2va.safetensors",
      "strength_model": 0.5,
      "model": [
        "148",
        0
      ]
    },
    "class_type": "LoraLoaderModelOnly"
  }
};
