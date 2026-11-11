export const meta = {
  apiVersion: 1,
  key: "muse-video",
  name: "Muse Video",
  icon: "text:Muse",
  version: "1.0.1",
  author: { name: "new-api" },
  description: { en: "Muse text and image to video", zh: "Muse 文生视频和图生视频" },
  models: ["muse-video"],
  fetchMode: "per_task",
  auth: "api_key",
  protocols: ["openai_video"],
  usageSchema: {
    video_count: { type: "number", unit: "count", description: { en: "Video generation unit price", zh: "视频生成单价" } },
  },
};

function requestValues(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON object required");
  const allowed = ["model", "prompt", "seconds", "duration", "size", "aspect_ratio", "ratio", "resolution", "input_reference", "image", "image_url", "reference_image", "images"];
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new Error("Unsupported field: " + key);
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("prompt is required");
  if (body.seconds !== undefined && body.duration !== undefined && Number(body.seconds) !== Number(body.duration)) throw new Error("seconds and duration must match");
  const seconds = body.seconds === undefined ? body.duration : body.seconds;
  if (seconds !== undefined && ((typeof seconds !== "number" && typeof seconds !== "string") || String(seconds).trim() === "" || !Number.isInteger(Number(seconds)) || Number(seconds) < 1 || Number(seconds) > 3600)) throw new Error("seconds must be an integer between 1 and 3600");
  if (body.aspect_ratio !== undefined && body.ratio !== undefined && body.aspect_ratio !== body.ratio) throw new Error("aspect_ratio and ratio must match");
  const request = { prompt: body.prompt };
  if (seconds !== undefined) request.duration = Number(seconds);
  for (const field of ["size", "resolution"]) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "string" || !body[field].trim()) throw new Error(field + " must be a non-empty string");
      request[field] = body[field];
    }
  }
  const ratio = body.aspect_ratio === undefined ? body.ratio : body.aspect_ratio;
  if (ratio !== undefined) {
    if (typeof ratio !== "string" || !ratio.trim()) throw new Error("aspect_ratio must be a non-empty string");
    request.aspect_ratio = ratio;
  }
  const refs = [body.input_reference, body.image, body.image_url, body.reference_image].filter(function (value) { return value !== undefined; });
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) throw new Error("images must be an array");
    refs.push(...body.images);
  }
  for (const ref of refs) {
    const value = ref && typeof ref === "object" && !Array.isArray(ref) ? ref.url : ref;
    if (typeof value !== "string" || !/^(https?:\/\/|data:image\/)/i.test(value)) throw new Error("reference images must be URLs or image data URLs");
  }
  if (refs.length) request.images = refs;
  return request;
}

export function buildSubmitRequest(ctx) {
  const body = Object.assign({}, ctx.requestBody, { model: ctx.upstreamModel || ctx.model });
  return { url: ctx.baseUrl.replace(/\/+$/, "") + "/v1/videos", method: "POST", headers: { Authorization: "Bearer " + ctx.apiKey, "Content-Type": "application/json" }, body };
}
export function parseSubmitResponse(_ctx, response) {
  const body = response.body || {};
  const taskId = body.id || body.task_id;
  if (typeof taskId !== "string" || !taskId) throw new Error("Video submission did not return a task ID");
  return { taskId, taskData: body };
}
export function buildQueryRequest(ctx) {
  return { url: ctx.baseUrl.replace(/\/+$/, "") + "/v1/videos/" + encodeURIComponent(ctx.taskId), method: "GET", headers: { Authorization: "Bearer " + ctx.apiKey } };
}
export function parseTaskResult(_ctx, body) {
  const statuses = { queued: "QUEUED", pending: "QUEUED", processing: "IN_PROGRESS", completed: "SUCCESS", failed: "FAILURE" };
  const status = statuses[(body || {}).status] || "UNKNOWN";
  const result = { status };
  if (status === "FAILURE") result.reason = typeof body.error === "string" ? body.error : "Video generation failed";
  const progress = Number((body || {}).progress);
  if (Number.isFinite(progress) && progress >= 0 && progress <= 100) result.progress = String(progress) + "%";
  return result;
}
export function extractUsage() { return { video_count: 1 }; }
export function listArtifacts(task) { return task.status === "SUCCESS" && task.data && task.data.result && task.data.result.filename ? [{ key: "video", type: "video", mimeType: "video/mp4" }] : []; }
export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const filename = ctx.data && ctx.data.result && ctx.data.result.filename;
  if (typeof filename !== "string" || !/^[A-Za-z0-9_-]+\.mp4$/.test(filename)) throw new Error("artifact_not_found");
  return { url: ctx.baseUrl.replace(/\/+$/, "") + "/v1/media/" + filename, method: "GET", headers: { Authorization: "Bearer " + ctx.apiKey } };
}
export const protocols = { openai_video: {
  decodeRequest(ctx) {
    if (!ctx.body || !["json", "multipart"].includes(ctx.body.kind)) throw new Error("JSON or multipart body required");
    let body;
    let file;
    if (ctx.body.kind === "json") body = ctx.body.value;
    else {
      body = {};
      for (const name of Object.keys(ctx.body.fields || {})) {
        const values = ctx.body.fields[name];
        if (values.length !== 1) throw new Error(name + " must be provided once");
        body[name] = values[0];
      }
      for (const item of ctx.body.files || []) {
        if (item.field !== "input_reference" || file) throw new Error("Only one input_reference file is supported");
        if (!String(item.mimeType || "").startsWith("image/")) throw new Error("input_reference must be an image");
        file = item;
      }
    }
    const request = requestValues(body);
    if (file) {
      if (request.images) throw new Error("Use either input_reference file or image URLs");
      request.images = [{ __fileRef: file.ref, encoding: "dataUrl", maxBytes: 20971520 }];
    }
    return { kind: "submit", model: ctx.model, action: request.images ? "image_to_video" : "text_to_video", requestBody: request };
  },
  render(_ctx, task) {
    const result = { object: "video" };
    if (task.status === "SUCCESS") result.video_url = "/v1/videos/" + task.task_id + "/content";
    if (task.status === "FAILURE") result.error = { code: "video_generation_failed", message: task.fail_reason || "Video generation failed" };
    return result;
  },
} };
