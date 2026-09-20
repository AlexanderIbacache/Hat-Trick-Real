import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { InferenceClient } from "@huggingface/inference";
import { GENERATED_DIR } from "./generatedDir.js";

/**
 * Prompt-based image edit using Hugging Face Inference Providers.
 * This avoids a paid OpenAI/Gemini dependency for the competition prototype.
 * Free-tier provider credits are limited, so the UI surfaces that limitation.
 */
export async function editBuildingImage({ base64, mimeType = "image/png", prompt }) {
  const [result] = await editBuildingImages({ images: [{ base64, mimeType }], prompt });
  return result;
}

/**
 * Generates a matching remix for every supplied reference view. Each image is
 * preserved as its own camera view, rather than combining unrelated camera
 * angles into one distorted source image.
 */
export async function editBuildingImages({ images, prompt }) {
  if (!Array.isArray(images) || images.length < 1 || images.length > 4) {
    throw new Error("Provide between one and four reference images.");
  }
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error("HF_TOKEN is not set. Create a free Hugging Face token and add it to backend/.env.");

  const client = new InferenceClient(token);
  const model = process.env.HF_IMAGE_MODEL || "black-forest-labs/FLUX.2-klein-9B";
  const provider = process.env.HF_IMAGE_PROVIDER || "auto";
  const enhancedPrompt = [
    "Edit the provided building photograph while preserving the exact building silhouette, camera angle, perspective, and surrounding context.",
    prompt.trim(),
    "Produce a realistic architectural visualization. Do not add text, logos, people, or unrelated structures. Keep doors, windows, and major facade proportions plausible.",
  ].join(" ");

  // Run sequentially so a four-view request remains reliable on providers with
  // modest concurrency limits.
  const results = [];
  for (const image of images) {
    results.push(await editOneBuildingImage({ ...image, client, model, provider, enhancedPrompt }));
  }
  return results;
}

async function editOneBuildingImage({ base64, mimeType = "image/png", client, model, provider, enhancedPrompt }) {
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw new Error("Uploaded image is empty.");
  if (buffer.length > 12 * 1024 * 1024) throw new Error("Image must be under 12 MB.");
  // The auto-selected fal-ai adapter in @huggingface/inference v4 handles an
  // ArrayBuffer reliably in Node. A Node Blob reaches that adapter as an
  // incompatible object despite exposing arrayBuffer() locally.
  const image = new Blob([buffer], { type: mimeType });
  if (typeof image.arrayBuffer !== "function") {
    throw new Error("The server could not construct a valid image Blob.");
  }
  const imageBytes = await image.arrayBuffer();

  const output = await client.imageToImage({
    model,
    provider,
    inputs: imageBytes,
    parameters: { prompt: enhancedPrompt },
  });

  const outBuffer = Buffer.from(await output.arrayBuffer());
  const id = crypto.randomUUID();
  const ext = (output.type || "image/png").includes("jpeg") ? "jpg" : "png";
  const filename = `preview-${id}.${ext}`;
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  await fs.writeFile(path.join(GENERATED_DIR, filename), outBuffer);

  return {
    imageUrl: `/generated/${filename}`,
    mimeType: output.type || "image/png",
    provider: `Hugging Face / ${provider}`,
    model,
  };
}
