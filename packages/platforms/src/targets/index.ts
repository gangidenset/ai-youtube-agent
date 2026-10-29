import type { PlatformTargetDefinition } from "../types";
import { facebookReels } from "./facebook-reels";
import { instagramReels } from "./instagram-reels";
import { tiktok } from "./tiktok";
import { xVideo } from "./x-video";
import { youtubeShorts } from "./youtube-shorts";
import { youtubeVideo } from "./youtube-video";

/**
 * 組み込みの出力先一覧（UI の表示順）。
 * 新しい SNS を追加するときは、targets/ に定義ファイルを作り、ここに 1 行追加するだけでよい。
 */
export const builtinTargets: readonly PlatformTargetDefinition[] = [
  tiktok,
  instagramReels,
  youtubeShorts,
  youtubeVideo,
  xVideo,
  facebookReels,
];
