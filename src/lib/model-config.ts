export const MODEL_CHUNK_SIZE = 8 * 1024 * 1024;
export const DEFAULT_MODEL_CDN_URL = "https://nobg-models.ordinity.com";

export type Tier = "best" | "balanced" | "light" | "basic";

export interface ModelSpec {
  key: string;
  id: string;
  revision: string;
  filename: string;
  size: number;
  sha256: string;
  dtype: "fp16" | "q8" | "fp32";
  inputSize: number;
  maxEdge: number;
  label: string;
  license: string;
}

export const MODELS = {
  ben2: {
    key: "ben2",
    id: "onnx-community/BEN2-ONNX",
    revision: "c552aa82688edce09f0ac9d2e31ad53d9d629010",
    filename: "onnx/model_fp16.onnx",
    size: 219_121_675,
    sha256: "dfdc25f421f32a0d1268e0f2ff2153d340e8f1d52d3dd16f5dc33c1ce85cedf1",
    dtype: "fp16",
    inputSize: 1024,
    maxEdge: 0,
    label: "Best",
    license: "MIT",
  },
  isnet: {
    key: "isnet",
    id: "xrds/isnet-general-onnx-int8",
    revision: "71eff2372ec9c8edbc6ca637ded591423d23b65a",
    filename: "onnx/model_quantized.onnx",
    size: 44_229_662,
    sha256: "3b21a6706dc8d6e4ba9f5b31ebc6940f6c785b58862e27bb25daa9dd4424b87f",
    dtype: "q8",
    inputSize: 1024,
    maxEdge: 1536,
    label: "Balanced",
    license: "MIT",
  },
  u2netp: {
    key: "u2netp",
    id: "BritishWerewolf/U-2-Netp",
    revision: "7112208dbac3a3642496c8d54e2f0f9bb3dc1dc8",
    filename: "onnx/model.onnx",
    size: 4_574_861,
    sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
    dtype: "fp32",
    inputSize: 320,
    maxEdge: 1024,
    label: "Basic",
    license: "Apache-2.0",
  },
} as const satisfies Record<string, ModelSpec>;

export const TIERS: Record<Tier, { model: keyof typeof MODELS; inputSize: number; maxEdge: number; label: string; description: string }> = {
  best: {
    model: "ben2",
    inputSize: 1024,
    maxEdge: 0,
    label: "Best",
    description: "Highest quality. Needs a capable GPU and ~220 MB download.",
  },
  balanced: {
    model: "isnet",
    inputSize: 1024,
    maxEdge: 1536,
    label: "Balanced",
    description: "Good quality on most devices. 44 MB download.",
  },
  light: {
    model: "isnet",
    inputSize: 512,
    maxEdge: 1024,
    label: "Light",
    description: "Same model at lower resolution for phones and low-memory laptops.",
  },
  basic: {
    model: "u2netp",
    inputSize: 320,
    maxEdge: 1024,
    label: "Basic",
    description: "Tiny 4.6 MB model for very old or low-memory devices. Softer edges.",
  },
};

export const TIER_ORDER: Tier[] = ["best", "balanced", "light", "basic"];

// Version the encoding and chunk boundaries as well as the original model.
export const assetPath = (m: ModelSpec) => `/models/${m.key}/${m.sha256}/gzip-8m-v1`;

// Kept for scripts that still refer to the desktop bundle by name.
export const DESKTOP_MODEL: ModelSpec = MODELS.ben2;
export const DESKTOP_ASSET_PATH = assetPath(MODELS.ben2);

// Transformers.js does not know the u2net model_type or its U2NetImageProcessor,
// and its native preprocessor pads (which would misalign the mask). These
// responses are served inline by createModelFetch instead of the pinned files.
export const MODEL_CONFIG_OVERRIDES: Partial<Record<keyof typeof MODELS, Record<string, unknown>>> = {
  u2netp: {
    // "isnet" maps to the generic PreTrainedModel via CUSTOM_ARCHITECTURES_MAPPING;
    // the image-segmentation pipeline maps the single non-pixel_values input.
    "config.json": {
      model_type: "isnet",
      "transformers.js_config": { dtype: "fp32" },
    },
    "preprocessor_config.json": {
      do_normalize: true,
      do_rescale: true,
      do_resize: true,
      do_pad: false,
      feature_extractor_type: "ViTFeatureExtractor",
      image_processor_type: "ViTFeatureExtractor",
      image_mean: [0.485, 0.456, 0.406],
      image_std: [0.229, 0.224, 0.225],
      resample: 2,
      rescale_factor: 0.00392156862745098,
      size: { height: 320, width: 320 },
    },
  },
};

export interface CompressedModelManifest {
  version: 1;
  sha256: string;
  size: number;
  chunkSize: number;
  parts: { size: number; compressedSize: number; sha256: string }[];
}
