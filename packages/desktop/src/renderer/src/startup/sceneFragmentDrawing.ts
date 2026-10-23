import { sceneFragmentArrival, type StartupSceneSettings } from "@lcode/shared/startup-animation";
import { createSceneFragments, type ScenePath } from "./sceneContours.js";

/** 几何由同一批片段派生；汇聚完成后复用路径，保留透明资源下的原线稿。 */
export function createSceneFragmentDrawing(paths: ScenePath[]) {
  const pieces = createSceneFragments(paths);
  const assembledPath = new Path2D();
  for (const piece of pieces)
    piece.points.forEach(([x, y], index) => {
      if (index) assembledPath.lineTo(x, y);
      else assembledPath.moveTo(x, y);
    });
  return {
    draw(
      ctx: CanvasRenderingContext2D,
      easing: StartupSceneSettings["easing"],
      spread: number,
      assembled: number,
      complete: boolean,
    ) {
      // 原来在彩色展示期间仍逐帧重算数千片段的三角函数；此时几何已不再变化。
      if (complete) {
        ctx.stroke(assembledPath);
        return;
      }
      ctx.beginPath();
      for (const piece of pieces) {
        const arrival = sceneFragmentArrival(easing, assembled, piece.x / 1536);
        const startX = 768 + (piece.sx - 768) * spread,
          startY = 512 + (piece.sy - 512) * spread;
        const x = startX + (piece.x - startX) * arrival,
          y = startY + (piece.y - startY) * arrival;
        const angle = piece.angle * (1 - arrival),
          size = 0.2 + 0.8 * arrival,
          cs = Math.cos(angle) * size,
          sn = Math.sin(angle) * size;
        piece.points.forEach(([px, py], i) => {
          const nx = x + (px - piece.x) * cs - (py - piece.y) * sn,
            ny = y + (px - piece.x) * sn + (py - piece.y) * cs;
          if (i) ctx.lineTo(nx, ny);
          else ctx.moveTo(nx, ny);
        });
      }
      ctx.stroke();
    },
  };
}
