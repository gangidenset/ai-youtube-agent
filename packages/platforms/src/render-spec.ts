import type {
  CropRect,
  MasterRenderInfo,
  PlatformTargetConfig,
  ReframeMode,
  RenderSpec,
  RenderWarning,
} from "./types";

/**
 * クロップした場合に残る面積の割合がこの値以上ならクロップ、未満ならぼかし背景で余白を埋める。
 * 例: 9:16 → 1:1 は 56% が残るのでクロップ、9:16 → 16:9 は 32% しか残らないのでぼかし背景。
 */
export const CROP_MIN_RETAINED_AREA = 0.5;

// FFmpeg（yuv420p）は偶数ピクセルが必要
const evenFloor = (n: number) => Math.floor(n / 2) * 2;
const evenSize = (n: number) => Math.max(2, evenFloor(n));

function planReframe(
  master: Pick<MasterRenderInfo, "width" | "height">,
  out: { width: number; height: number },
): { mode: ReframeMode; crop?: CropRect } {
  if (master.width === out.width && master.height === out.height) return { mode: "NONE" };

  const masterRatio = master.width / master.height;
  const targetRatio = out.width / out.height;
  if (Math.abs(masterRatio - targetRatio) < 0.01) return { mode: "SCALE" };

  // 出力のアスペクト比でマスターから切り出せる最大の中央矩形
  const cropWidth = targetRatio > masterRatio ? master.width : master.height * targetRatio;
  const cropHeight = targetRatio > masterRatio ? master.width / targetRatio : master.height;
  const retained = (cropWidth * cropHeight) / (master.width * master.height);
  if (retained < CROP_MIN_RETAINED_AREA) return { mode: "BLUR_PAD" };

  const width = evenSize(cropWidth);
  const height = evenSize(cropHeight);
  return {
    mode: "CENTER_CROP",
    crop: {
      x: evenFloor((master.width - width) / 2),
      y: evenFloor((master.height - height) / 2),
      width,
      height,
    },
  };
}

/** 尺の上限を超える場合は OPTIONAL シーンを後ろから省き、それでも超えれば切り詰める。 */
function planScenes(scenes: MasterRenderInfo["scenes"], maxSec: number) {
  const included = [...scenes];
  const dropped: number[] = [];
  const total = () => included.reduce((sum, s) => sum + s.durationSec, 0);

  for (let i = included.length - 1; i >= 0 && total() > maxSec; i--) {
    const scene = included[i];
    if (scene?.priority === "OPTIONAL") {
      dropped.unshift(scene.sceneNumber);
      included.splice(i, 1);
    }
  }
  return { included: included.map((s) => s.sceneNumber), dropped, durationSec: total() };
}

/** マスター動画から Target 用の出力をどう作るかを決める（純粋関数）。 */
export function planRender(config: PlatformTargetConfig, master: MasterRenderInfo): RenderSpec {
  const { video, style } = config;
  const warnings: RenderWarning[] = [];

  const scenes = planScenes(master.scenes, video.maxDurationSec);
  if (scenes.dropped.length > 0) warnings.push({ code: "OPTIONAL_SCENES_DROPPED", scenes: scenes.dropped });

  let durationSec = scenes.durationSec;
  if (durationSec > video.maxDurationSec) {
    warnings.push({ code: "TRUNCATED", fromSec: durationSec, toSec: video.maxDurationSec });
    durationSec = video.maxDurationSec;
  }

  const { min, max } = video.recommendedDurationSec;
  if (durationSec < min || durationSec > max) {
    warnings.push({ code: "OUTSIDE_RECOMMENDED_DURATION", durationSec, min, max });
  }

  return {
    targetId: config.id,
    specVersion: config.specVersion,
    output: {
      width: video.width,
      height: video.height,
      fps: video.fps,
      loudnessLufs: video.loudnessLufs,
      maxFileSizeMb: video.maxFileSizeMb,
    },
    reframe: planReframe(master, video),
    includedScenes: scenes.included,
    durationSec,
    subtitle: { style: style.subtitleStyle, safeArea: video.safeArea },
    hookMaxSec: style.hookMaxSec,
    warnings,
  };
}
