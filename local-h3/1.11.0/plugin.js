const WORKFLOWS = {
  "h3-nsfw": {images: Array(9), audio: Array(3), videos: Array(3), aspectRatio: "16:9", resolution: "480", v2: true, graph: true},
  "h3-nsfw-opt": {images: Array(9), audio: Array(3), videos: Array(3), aspectRatio: "16:9", resolution: "480", v2: true, graph: true},
};
const ASPECT_RATIOS = {
  "9:16": "9:16 (Portrait Widescreen)",
  "16:9": "16:9 (Widescreen)",
};

export const meta = {
  apiVersion: 1,
  key: "local-h3",
  name: "Local MiniMax H3",
  icon: "text:H3",
  version: "1.11.0",
  author: { name: "new-api" },
  description: { en: "MiniMax H3 video generation", zh: "生成 MiniMax H3 视频" },
  
  models: Object.keys(WORKFLOWS),
  fetchMode: "per_task",
  auth: "api_key",
  upstreams: ["vendor", "new_api"],
  // Reference media is a public URL the vendor fetches itself, so this plugin
  // has no upload surface and owns no asset handles.
  routes: [
    {method: "POST", path: "/v1/videos/:task_id/continue", type: "submit", decode: "continuation", render: "created"},
    {method: "POST", path: "/v1/videos/:task_id/second-sampling", type: "submit", decode: "secondSampling", render: "created"},
  ],
  protocols: ["openai_video"],
  usageSchema: {
    seconds: { type: "number", unit: "second", description: { en: "Video generation unit price", zh: "视频生成单价" } },
  },
  usageProfiles: [{
    models: ["h3-nsfw", "h3-nsfw-opt"],
    schema: {
      seconds: { type: "number", unit: "second", description: { en: "Video generation unit price", zh: "视频生成单价" } },
      resolution: { enum: ["480P", "720P", "768P", "1080P"], description: { en: "Output video resolution", zh: "输出视频分辨率" } },
    },
    examples: [
      { label: "480P", facts: { seconds: 5, resolution: "480P" } },
      { label: "768P", facts: { seconds: 5, resolution: "768P" } },
    ],
  }],
};

function numberField(value, fallback, name, min, max) {
  const number = value === undefined ? fallback : typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(name + " is outside the supported range");
  return number;
}

// Reference media must be a public http(s) URL. Callers upload once through the
// platform file API (/v1/files), read the URL back, and pass it here; the vendor
// downloads that URL while running the workflow. Nothing is stored under a
// vendor account, so a reference is not tied to the channel or key that will
// submit the video.
function mediaURLs(value, max, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(name + " must be an array with at most " + max + " URLs");
  return value.map(function (url) {
    if (typeof url !== "string") throw new Error(name + " must contain public http(s) URLs");
    const trimmed = url.trim();
    if (trimmed.length > 2048 || !/^https?:\/\/\S+$/.test(trimmed)) throw new Error(name + " must contain public http(s) URLs");
    return trimmed;
  });
}

// H3 native clients send the prompt and media inside a `content` array with
// `duration` and `ratio`. Only reference roles map onto these workflows; frame
// roles would silently become references, so they are rejected by name.
function nativeContent(content) {
  if (!Array.isArray(content) || content.length === 0) throw new Error("content must be a non-empty array");
  const texts = [];
  const images = [];
  const audios = [];
  const videos = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("content items must be objects");
    const role = item.role === undefined ? "" : item.role;
    if (typeof role !== "string") throw new Error("content role must be a string");
    if (item.type === "text") {
      if (typeof item.text !== "string" || !item.text.trim()) throw new Error("content text must not be empty");
      texts.push(item.text);
      continue;
    }
    let field;
    let expectedRole;
    let urls;
    if (item.type === "image_url") {
      field = "image_url";
      expectedRole = "reference_image";
      urls = images;
    } else if (item.type === "video_url") {
      field = "video_url";
      expectedRole = "reference_video";
      urls = videos;
    } else if (item.type === "audio_url") {
      field = "audio_url";
      expectedRole = "reference_audio";
      urls = audios;
    } else {
      throw new Error("Unsupported content type: " + String(item.type));
    }
    if (role !== "" && role !== expectedRole) throw new Error("content " + item.type + " role must be " + expectedRole);
    const media = item[field];
    if (!media || typeof media !== "object" || typeof media.url !== "string") throw new Error("content " + item.type + " must contain url");
    urls.push(media.url);
  }
  return { prompt: texts.join("\n"), images: images, audios: audios, videos: videos };
}

// Accept both the workflow preset ("480"/"768") and the H3 native unit suffix
// ("480P"/"768P"). The unified document also calls this "size".
function videoResolution(value) {
  const resolution = typeof value === "string" ? value.trim().replace(/[Pp]$/, "") : value;
  if (!["480", "768"].includes(resolution)) {
    if (resolution === "1080") throw new Error("resolution 1080P is not supported by these workflows; use 480P or 768P");
    throw new Error("resolution must be 480 or 768");
  }
  return resolution;
}

// The unified document carries reference media and frame hints under
// `metadata`, uses `size` for resolution and `images` for reference images.
// These workflows only run reference media (no first/last-frame nodes), so
// frame hints are rejected by name instead of being silently dropped.
function documentMetadata(body) {
  const metadata = body.metadata;
  if (metadata === undefined) return {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("metadata must be an object");
  if (metadata.first_frame_image !== undefined || metadata.last_frame_image !== undefined)
    throw new Error("first and last frame images are not supported by these workflows; use reference images, video, or audio");
  for (const key of Object.keys(metadata)) {
    if (!["reference_video", "reference_audio"].includes(key)) throw new Error("Unsupported H3 metadata field: " + key);
  }
  return metadata;
}

function videoRequest(body, model) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON object required");
  const modelName = model || body.model || "minimax-h3-standard";
  if (!Object.hasOwn(WORKFLOWS, modelName)) throw new Error("Unsupported H3 model");
  const workflow = WORKFLOWS[modelName];
  const fields = ["enable_continuation", "model", "prompt", "seconds", "duration", "resolution", "aspect_ratio", "ratio", "content", "reference_images", "reference_audio", "reference_video", "size", "images", "metadata"];
  if (workflow.v2) {
    fields.push("reference_videos");
  }
  for (const key of Object.keys(body)) {
    if (!fields.includes(key)) throw new Error("Unsupported H3 field: " + key);
  }
  // Unified-document aliases: size -> resolution, images -> reference_images,
  // metadata.reference_video/reference_audio -> reference fields. Same-meaning
  // fields must not be mixed across the two styles.
  const metadata = documentMetadata(body);
  if (body.size !== undefined && body.resolution !== undefined) throw new Error("Use size or resolution, not both");
  if (body.images !== undefined && body.reference_images !== undefined) throw new Error("Use images or reference_images, not both");
  if (metadata.reference_video !== undefined && body.reference_video !== undefined) throw new Error("Use metadata.reference_video or reference_video, not both");
  if (metadata.reference_audio !== undefined && body.reference_audio !== undefined) throw new Error("Use metadata.reference_audio or reference_audio, not both");
  const content = body.content === undefined ? null : nativeContent(body.content);
  if (content) {
    for (const key of ["reference_images", "images", "reference_audio", "reference_video", "reference_videos", "metadata"]) {
      if (body[key] !== undefined) throw new Error("Use content or " + key + ", not both");
    }
    if (content.prompt && body.prompt !== undefined && String(body.prompt).trim() !== content.prompt.trim())
      throw new Error("Use prompt or content text, not both");
    if (!workflow.v2 && content.videos.length > 1) throw new Error("This model accepts one reference video");
  }
  const prompt = content && content.prompt ? content.prompt : body.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt is required");
  // Both workflows support 4–15 seconds; validate before usage reservation.
  if (body.seconds !== undefined && body.duration !== undefined && Number(body.seconds) !== Number(body.duration))
    throw new Error("Use seconds or duration, not both");
  const seconds = numberField(body.seconds === undefined ? body.duration : body.seconds, 10, "seconds", 4, 15);
  if (!Number.isInteger(seconds)) throw new Error("seconds must be an integer");
  if (body.aspect_ratio !== undefined && body.ratio !== undefined && body.aspect_ratio !== body.ratio)
    throw new Error("Use aspect_ratio or ratio, not both");
  const aspectRatio = body.aspect_ratio !== undefined ? body.aspect_ratio : body.ratio === undefined ? workflow.aspectRatio : body.ratio;
  if (typeof aspectRatio !== "string" || !Object.hasOwn(ASPECT_RATIOS, aspectRatio)) throw new Error("aspect_ratio must be 16:9 or 9:16");
  // Flat reference_video is a single URL; metadata.reference_video is an array.
  // Normalize both into one list while enforcing each workflow's video limit.
  const videoList = metadata.reference_video !== undefined
    ? mediaURLs(metadata.reference_video, workflow.videos.length, "metadata.reference_video")
    : body.reference_video === undefined || body.reference_video === ""
      ? []
      : mediaURLs([body.reference_video], 1, "reference_video");
  const referenceImages = content ? content.images : body.images !== undefined ? body.images : body.reference_images;
  const referenceAudio = content ? content.audios : body.reference_audio !== undefined ? body.reference_audio : metadata.reference_audio;
  const request = {
    model: modelName,
    enable_continuation: body.enable_continuation !== false,
    prompt: prompt,
    seconds: seconds,
    resolution: modelName === "minimax-h3-flash" ? "480" : videoResolution(body.resolution === undefined ? body.size === undefined ? workflow.resolution : body.size : body.resolution),
    aspect_ratio: aspectRatio,
    reference_images: mediaURLs(referenceImages, workflow.images.length, "reference_images"),
    reference_audio: mediaURLs(referenceAudio, 3, "reference_audio"),
    // Clear unused nodes so the workflow's example images cannot leak into
    // a caller's generation. RunningHub uses None for optional media inputs.
    reference_video: videoList[0] || "",
  };
  if (!workflow.v2) {
    if (content && content.videos.length) request.reference_video = mediaURLs(content.videos, 1, "reference_video")[0];
    return request;
  }
  if (videoList.length && body.reference_videos !== undefined) throw new Error("Use reference_video or reference_videos, not both");
  request.reference_videos = content && content.videos.length
    ? mediaURLs(content.videos, 3, "reference_videos")
    : mediaURLs(body.reference_videos === undefined ? videoList : body.reference_videos, 3, "reference_videos");
  delete request.reference_video;
  return request;
}

function originTask(ctx) {
  const tasks = ctx.originTasks || [];
  if (tasks.length !== 1 || !tasks[0].upstreamTaskId) throw new Error("A valid origin task is required");
  const task = tasks[0];
  if (task.status !== "SUCCESS") throw new Error("The origin task must have succeeded");
  if (task.model && task.model !== ctx.model) throw new Error("The model must match the origin task");
  return task;
}

function originUsage(ctx) {
  const task = originTask(ctx);
  let data = task.data && (task.data.task || task.data) || {};
  const facts = task.usageFacts || {};
  if ((data.duration === undefined && facts.seconds === undefined || !data.resolution && !facts.resolution) && (!ctx.upstream || ctx.upstream.kind !== "new_api")) {
    const response = utils.fetch({url: ctx.baseUrl.replace(/\/+$/, "") + "/v2/query/video_generation/" + encodeURIComponent(task.upstreamTaskId), method: "GET", headers: {Authorization: "Bearer " + ctx.apiKey}});
    if (response.status !== 200 || !response.body || !response.body.task) throw new Error("Could not verify origin task usage");
    data = response.body.task;
  }
  const seconds = Number(data.duration === undefined ? facts.seconds : data.duration);
  const resolution = data.resolution || facts.resolution;
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 30 || !["480P", "720P", "768P", "1080P"].includes(resolution))
    throw new Error("The origin task has no verified duration and resolution for billing");
  return {seconds, resolution};
}

export const native = {
  continuation(ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const body = ctx.body.value || {};
    if (!Object.hasOwn(WORKFLOWS, body.model)) throw new Error("model is required");
    if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("prompt is required");
    const seconds = numberField(body.seconds, undefined, "seconds", 4, 30);
    if (!Number.isInteger(seconds)) throw new Error("seconds must be an integer");
    for (const key of Object.keys(body)) if (!["model", "prompt", "seconds", "images", "metadata", "reference_mode"].includes(key)) throw new Error("Unsupported continuation field: " + key);
    const metadata = documentMetadata(body);
    const images = mediaURLs(body.images, 9, "images");
    const videos = mediaURLs(metadata.reference_video, 3, "metadata.reference_video");
    const audio = mediaURLs(metadata.reference_audio, 3, "metadata.reference_audio");
    if (audio.length && !images.length && !videos.length) throw new Error("reference audio requires an image or video");
    const referenceMode = body.reference_mode === undefined ? "inherit" : body.reference_mode;
    if (!["inherit", "append", "replace"].includes(referenceMode)) throw new Error("Invalid reference_mode");
    return {kind: "submit", model: body.model, action: "continuation", requestBody: {model: body.model, prompt: body.prompt, seconds, images, metadata: {reference_video: videos, reference_audio: audio}, reference_mode: referenceMode}, originTaskIds: [ctx.params.task_id]};
  },
  secondSampling(ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    const body = ctx.body.value || {};
    if (!Object.hasOwn(WORKFLOWS, body.model)) throw new Error("model is required");
    for (const key of Object.keys(body)) if (!["model", "size", "dit_steps", "scale", "redraw"].includes(key)) throw new Error("Unsupported second-sampling field: " + key);
    if (body.size !== undefined && !["480P", "720P", "768P", "1080P"].includes(body.size)) throw new Error("Unsupported second-sampling size");
    const request = {model: body.model, size: body.size || "768P"};
    if (body.dit_steps !== undefined) {
      request.dit_steps = numberField(body.dit_steps, undefined, "dit_steps", 1, 8);
      if (!Number.isInteger(request.dit_steps)) throw new Error("dit_steps must be an integer");
    }
    if (body.scale !== undefined) request.scale = numberField(body.scale, undefined, "scale", 1, 4);
    if (body.redraw !== undefined) {
      if (!["保真", "标准"].includes(body.redraw)) throw new Error("Invalid redraw");
      request.redraw = body.redraw;
    }
    return {kind: "submit", model: body.model, action: "secondSampling", requestBody: request, originTaskIds: [ctx.params.task_id]};
  },
  created(_ctx, task) { return {id: task.task_id, object: "video", status: "queued"}; },
};

export function buildSubmitRequest(ctx) {
  const root = ctx.baseUrl.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + ctx.apiKey };
  const req = ctx.requestBody || {};
  if (ctx.action === "continuation" || ctx.action === "secondSampling") {
    const origin = originTask(ctx);
    const suffix = ctx.action === "continuation" ? "continue" : "second-sampling";
    const gateway = ctx.upstream && ctx.upstream.kind === "new_api";
    let body;
    if (gateway) body = req;
    else if (ctx.action === "continuation") {
      const content = [{type: "text", text: req.prompt}];
      for (const url of req.images) content.push({type: "image_url", image_url: {url}, role: "reference_image"});
      for (const url of req.metadata.reference_video) content.push({type: "video_url", video_url: {url}, role: "reference_video"});
      for (const url of req.metadata.reference_audio) content.push({type: "audio_url", audio_url: {url}, role: "reference_audio"});
      body = {content, duration: req.seconds, reference_mode: req.reference_mode};
    } else {
      body = {target_resolution: req.size || "768P"};
      for (const key of ["dit_steps", "scale", "redraw"]) if (req[key] !== undefined) body[key] = req[key];
    }
    return {url: root + (gateway ? "/local-h3/v1/videos/" : "/v2/video_generation/") + encodeURIComponent(origin.upstreamTaskId) + "/" + suffix, method: "POST", headers, body};
  }
  const request = videoRequest(req, ctx.upstreamModel || ctx.model);
  const content = [{type:"text", text:request.prompt}];
  for (const url of request.reference_images) content.push({type:"image_url",image_url:{url},role:"reference_image"});
  for (const url of request.reference_videos) content.push({type:"video_url",video_url:{url},role:"reference_video"});
  for (const url of request.reference_audio) content.push({type:"audio_url",audio_url:{url},role:"reference_audio"});
  const gateway = ctx.upstream && ctx.upstream.kind === "new_api";
  return {url: root + (gateway ? "/v1/videos" : "/v2/video_generation"), method:"POST", headers, body:{model:!gateway && request.model === "h3-nsfw-opt" ? "h3-nsfw" : request.model,content,duration:request.seconds,resolution:request.resolution+"P",ratio:request.aspect_ratio,enable_continuation:request.enable_continuation}};
}
export function parseSubmitResponse(_ctx, response) {
  const body = response.body || {};
  const taskId = body.task_id || body.id;
  if (typeof taskId !== "string" || !taskId) throw new Error("Video submission did not return a task ID");
  return {taskId, taskData:body};
}
export function buildQueryRequest(ctx) {
  const path = ctx.upstream && ctx.upstream.kind === "new_api" ? "/v1/videos/" : "/v2/query/video_generation/";
  return {url:ctx.baseUrl.replace(/\/+$/, "") + path + encodeURIComponent(ctx.taskId),method:"GET",headers:{Authorization:"Bearer " + ctx.apiKey}};
}
export function parseTaskResult(ctx, body) {
  const t = ctx.upstream && ctx.upstream.kind === "new_api" ? body || {} : body && body.task || {};
  const status = {queued:"QUEUED",pending:"QUEUED",running:"IN_PROGRESS",processing:"IN_PROGRESS",in_progress:"IN_PROGRESS",succeeded:"SUCCESS",completed:"SUCCESS",failed:"FAILURE",cancelled:"FAILURE"}[t.status] || "UNKNOWN";
  const out = {status};
  if (status === "FAILURE") out.reason = t.status === "cancelled" ? "cancelled by user" : t.error && t.error.message || "Video generation failed";
  const percent = typeof t.progress === "number" ? t.progress : typeof t.progress === "string" && /^\d+(?:\.\d+)?%$/.test(t.progress) ? Number(t.progress.slice(0, -1)) : t.progress && t.progress.percent;
  if (typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100) out.progress = String(percent) + "%";
  return out;
}
export function listArtifacts(task) { return task.status === "SUCCESS" ? [{key:"video",type:"video",mimeType:"video/mp4"}] : []; }
export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const path = ctx.upstream && ctx.upstream.kind === "new_api" ? "/v1/videos/" : "/v2/video_generation/";
  return {url:ctx.baseUrl.replace(/\/+$/, "") + path + encodeURIComponent(ctx.upstreamTaskId) + "/content",method:ctx.clientRequest.method,headers:{Authorization:"Bearer " + ctx.apiKey}};
}
export function extractUsage(ctx) {
  const body = ctx.requestBody || {};
  if (ctx.action === "continuation" || ctx.action === "secondSampling") {
    const origin = originUsage(ctx);
    return {seconds: ctx.action === "continuation" ? body.seconds : origin.seconds, resolution: ctx.action === "continuation" ? origin.resolution : body.size || "768P"};
  }
  const model = ctx.upstreamModel || body.model || ctx.model;
  if (model === "h3-nsfw" || model === "h3-nsfw-opt") {
    const request = videoRequest(body, model);
    return {seconds: request.seconds, resolution: request.resolution + "P"};
  }
  const seconds = Number(body.seconds || body.duration || 4);
  return {seconds:Number.isFinite(seconds) && seconds > 0 ? seconds : 4};
}
export const protocols = {openai_video:{
  decodeRequest(ctx) {
    if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
    return {kind:"submit",model:ctx.model,action:"video_generation",requestBody:videoRequest(ctx.body.value,ctx.upstreamModel || ctx.model)};
  },
  render(_ctx,task) {
    const output={object:"video"};
    if (task.status === "SUCCESS") output.video_url="/v1/videos/"+task.task_id+"/content";
    if (task.status === "FAILURE") output.error={code:"video_generation_failed",message:task.fail_reason || "Video generation failed"};
    return output;
  }
}};
