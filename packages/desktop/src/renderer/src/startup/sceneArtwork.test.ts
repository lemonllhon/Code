import assert from "node:assert/strict";
import { test } from "node:test";
import { createSceneArtwork } from "./sceneArtwork.js";
import type { SceneResource } from "./sceneResource.js";
import { createSceneFragmentDrawing } from "./sceneFragmentDrawing.js";

test("静态背景复用同一纹理，进度、眨眼和资源切换失效；视频始终更新", (t) => {
  let paints = 0;
  const paint = {
    clearRect() {},
    drawImage() {
      paints++;
    },
    fillRect() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => paint };
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const artwork = createSceneArtwork();
  const target = { drawImage() {} } as unknown as CanvasRenderingContext2D;
  const image = {
    kind: "image",
    element: {},
    width: 1536,
    height: 1024,
    dispose() {},
  } as SceneResource;
  artwork.draw(target, image, undefined, 1, 0);
  artwork.draw(target, image, undefined, 1, 0);
  assert.equal(paints, 1);
  artwork.draw(target, image, undefined, 0.5, 0);
  artwork.draw(target, image, undefined, 0.5, 0);
  assert.equal(paints, 2);
  artwork.draw(target, image, undefined, 1, 0.5);
  assert.equal(paints, 3);
  artwork.draw(target, { ...image }, undefined, 1, 0.5);
  assert.equal(paints, 4);
  const video = { ...image, kind: "video", duration: 16 } as unknown as SceneResource;
  artwork.draw(target, video, undefined, 1, 0);
  artwork.draw(target, video, undefined, 1, 0);
  assert.equal(paints, 6);
  artwork.dispose();
  assert.equal(canvas.width * canvas.height, 1);
});

test("汇聚路径保留相同片段坐标，展示阶段只复用已编译路径", (t) => {
  class RecordedPath {
    commands: [string, number, number][] = [];
    moveTo(x: number, y: number) {
      this.commands.push(["move", x, y]);
    }
    lineTo(x: number, y: number) {
      this.commands.push(["line", x, y]);
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, "Path2D");
  Object.defineProperty(globalThis, "Path2D", { configurable: true, value: RecordedPath });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "Path2D", original);
    else Reflect.deleteProperty(globalThis, "Path2D");
  });
  const drawing = createSceneFragmentDrawing([
    [
      [0, 0],
      [10, 20],
      [20, 30],
      [30, 40],
      [40, 50],
    ],
  ]);
  const dynamic = new RecordedPath();
  const strokes: unknown[] = [];
  const ctx = {
    beginPath() {},
    moveTo: dynamic.moveTo.bind(dynamic),
    lineTo: dynamic.lineTo.bind(dynamic),
    stroke(path?: unknown) {
      strokes.push(path);
    },
  } as unknown as CanvasRenderingContext2D;
  drawing.draw(ctx, "linear", 1, 1, false);
  drawing.draw(ctx, "linear", 1, 1, true);
  const cached = strokes.at(-1) as RecordedPath;
  assert.equal(cached.commands.length, dynamic.commands.length);
  cached.commands.forEach(([op, x, y], i) => {
    const other = dynamic.commands[i]!;
    assert.equal(op, other[0]);
    assert.ok(Math.abs(x - other[1]) < 1e-9 && Math.abs(y - other[2]) < 1e-9);
  });
  const commands = dynamic.commands.length;
  drawing.draw(ctx, "linear", 1, 1, true);
  assert.equal(strokes.at(-1), cached);
  assert.equal(dynamic.commands.length, commands);
});
