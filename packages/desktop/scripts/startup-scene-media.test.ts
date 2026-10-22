import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSceneFragments,
  extractSceneContours,
} from "../src/renderer/src/startup/sceneContours.js";

test("轮廓输入必须为完整 RGBA；空图与小图安全返回，损坏尺寸不能生成 NaN", () => {
  for (const [width, height] of [
    [0, 0],
    [1, 8],
    [4, 4],
    [8, 1],
  ] as const) {
    assert.deepEqual(
      extractSceneContours(new Uint8ClampedArray(width * height * 4), width, height),
      [],
    );
  }
  for (const [width, height, bytes] of [
    [-1, 8, 0],
    [1.5, 8, 48],
    [NaN, 8, 0],
    [Infinity, 8, 0],
    [8, 8, 255],
    [8, 8, 257],
    [Number.MAX_SAFE_INTEGER, 8, 0],
  ] as const) {
    assert.throws(
      () => extractSceneContours(new Uint8ClampedArray(bytes), width, height),
      RangeError,
    );
  }
});

test("片段构造处理空路径、单点与尾部短段，保持确定性与有限坐标", () => {
  assert.deepEqual(createSceneFragments([[], [[1, 2]]]), []);
  const path: [number, number][] = [
    [0, 0],
    [10, 20],
    [20, 40],
    [30, 60],
    [40, 80],
  ];
  const paths = [path];
  const fragments = createSceneFragments(paths);
  assert.deepEqual(
    fragments.map(({ points }) => points),
    [path.slice(0, 4), path.slice(3)],
  );
  assert.deepEqual(fragments, createSceneFragments(paths));
  assert.ok(
    fragments.every(({ x, y, angle, sx, sy }) => [x, y, angle, sx, sy].every(Number.isFinite)),
  );
});

test("轮廓连接出真实长折线并保留四周细节，平坦画面不产生噪声", () => {
  const width = 384,
    height = 256;
  const pixels = new Uint8ClampedArray(width * height * 4);
  assert.equal(extractSceneContours(pixels, width, height).length, 0);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const light =
        (x > 30 && x < 110 && y > 25 && y < 220) || (x > 220 && x < 350 && y > 60 && y < 190)
          ? 240
          : 15;
      pixels.set([light, light, light, 255], (y * width + x) * 4);
    }
  const paths = extractSceneContours(pixels, width, height);
  assert.ok(
    paths.some((path) => path.length > 8),
    "连续轮廓不能退化为两点横线",
  );
  const points = paths.flat();
  assert.ok(points.some(([x]) => x < 150));
  assert.ok(points.some(([x]) => x > 1350));
  assert.ok(points.some(([, y]) => y > 850));
  assert.ok(paths.every((path) => path.length >= 3));
  assert.deepEqual(paths, extractSceneContours(pixels, width, height));
  for (const path of paths) {
    assert.ok(
      path.every(
        ([x, y]) =>
          Number.isFinite(x) && x >= 0 && x < 1536 && Number.isFinite(y) && y >= 0 && y < 1024,
      ),
    );
    let previous: [number, number] | undefined;
    for (const [x, y] of path) {
      if (previous) {
        const [px, py] = previous;
        assert.ok(
          Math.abs(x - px) <= (1536 / width) * 2 && Math.abs(y - py) <= (1024 / height) * 2,
        );
      }
      previous = [x, y];
    }
  }
});
