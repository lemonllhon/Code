export type ScenePoint = [number, number];
export type ScenePath = ScenePoint[];

// noUncheckedIndexedAccess 揭示了像素/中间缓冲越界会把 undefined 传成 NaN；
// 统一验证读取边界，不用默认 0 或非空断言掩盖损坏输入与算法索引错误。
function readSample(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Scene sample index out of bounds: ${index}`);
  return value;
}

/** Sobel + 非极大值抑制 + 连通追踪；保留连续结构，避免旧低分辨率横线替代轮廓。 */
export function extractSceneContours(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): ScenePath[] {
  const count = width * height;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 0 ||
    height < 0 ||
    !Number.isSafeInteger(count * 4) ||
    pixels.length !== count * 4
  )
    throw new RangeError("Scene contours require complete RGBA pixels and integer dimensions");
  if (width < 5 || height < 5) return [];
  const gray = new Float32Array(count),
    smooth = new Float32Array(count);
  for (let i = 0; i < count; i++)
    gray[i] =
      readSample(pixels, i * 4) * 0.299 +
      readSample(pixels, i * 4 + 1) * 0.587 +
      readSample(pixels, i * 4 + 2) * 0.114;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      smooth[i] =
        (readSample(gray, i - width - 1) +
          2 * readSample(gray, i - width) +
          readSample(gray, i - width + 1) +
          2 * readSample(gray, i - 1) +
          4 * readSample(gray, i) +
          2 * readSample(gray, i + 1) +
          readSample(gray, i + width - 1) +
          2 * readSample(gray, i + width) +
          readSample(gray, i + width + 1)) /
        16;
    }
  const magnitude = new Float32Array(count),
    direction = new Uint8Array(count);
  for (let y = 2; y < height - 2; y++)
    for (let x = 2; x < width - 2; x++) {
      const i = y * width + x;
      const gx =
        -readSample(smooth, i - width - 1) +
        readSample(smooth, i - width + 1) -
        2 * readSample(smooth, i - 1) +
        2 * readSample(smooth, i + 1) -
        readSample(smooth, i + width - 1) +
        readSample(smooth, i + width + 1);
      const gy =
        -readSample(smooth, i - width - 1) -
        2 * readSample(smooth, i - width) -
        readSample(smooth, i - width + 1) +
        readSample(smooth, i + width - 1) +
        2 * readSample(smooth, i + width) +
        readSample(smooth, i + width + 1);
      magnitude[i] = Math.hypot(gx, gy);
      direction[i] = Math.round((Math.atan2(gy, gx) + Math.PI) / (Math.PI / 4)) % 4;
    }
  const thin = new Float32Array(count),
    histogram = new Uint32Array(1024);
  const offsets = [1, width + 1, width, width - 1];
  let visible = 0;
  for (let i = width * 2; i < count - width * 2; i++) {
    const value = readSample(magnitude, i),
      offset = readSample(offsets, readSample(direction, i));
    if (
      value > 12 &&
      value >= readSample(magnitude, i - offset) &&
      value >= readSample(magnitude, i + offset)
    ) {
      thin[i] = value;
      const bin = Math.min(1023, Math.round(value));
      histogram[bin] = readSample(histogram, bin) + 1;
      visible++;
    }
  }
  if (!visible) return [];
  let accumulated = 0,
    high = 20;
  for (let i = 0; i < histogram.length; i++) {
    accumulated += readSample(histogram, i);
    if (accumulated >= visible * 0.7) {
      high = Math.max(20, i);
      break;
    }
  }
  const edge = new Uint8Array(count),
    queue: number[] = [];
  for (let i = 0; i < count; i++)
    if (readSample(thin, i) >= high) {
      edge[i] = 1;
      queue.push(i);
    }
  const neighbors = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
  // 扁平索引相邻不一定是像素相邻；同一边界同时用于阈值扩展与连通追踪。
  const isNeighbor = (from: number, to: number) =>
    to >= 0 && to < count && Math.abs((from % width) - (to % width)) <= 1;
  for (const current of queue)
    for (const offset of neighbors) {
      const next = current + offset;
      if (isNeighbor(current, next) && !edge[next] && readSample(thin, next) >= high * 0.4) {
        edge[next] = 1;
        queue.push(next);
      }
    }
  const paths: ScenePath[] = [];
  for (const seed of queue) {
    if (!edge[seed]) continue;
    const chain: number[] = [];
    let current = seed,
      previous = seed;
    while (edge[current]) {
      edge[current] = 0;
      chain.push(current);
      const dx = (current % width) - (previous % width),
        dy = Math.floor(current / width) - Math.floor(previous / width);
      let next = -1,
        score = -Infinity;
      for (const offset of neighbors) {
        const candidate = current + offset;
        if (!isNeighbor(current, candidate) || !edge[candidate]) continue;
        const nx = (candidate % width) - (current % width),
          ny = Math.floor(candidate / width) - Math.floor(current / width);
        const rank = (dx * nx + dy * ny) / Math.hypot(nx, ny) + readSample(thin, candidate) / 4096;
        if (rank > score) {
          score = rank;
          next = candidate;
        }
      }
      if (next < 0) break;
      previous = current;
      current = next;
    }
    if (chain.length < 6) continue;
    const path: ScenePath = [];
    for (const [index, pixel] of chain.entries())
      if (index % 2 === 0)
        path.push([((pixel % width) * 1536) / width, (Math.floor(pixel / width) * 1024) / height]);
    paths.push(path);
  }
  return paths;
}

export function createSceneFragments(paths: ScenePath[]) {
  return paths
    .flatMap((path, index) => {
      const result: {
        points: ScenePath;
        x: number;
        y: number;
        angle: number;
        sx: number;
        sy: number;
      }[] = [];
      for (let i = 0; i < path.length - 1; i += 3) {
        const points = path.slice(i, i + 4);
        const [start] = points;
        if (!start) continue;
        const [x, y] = start;
        const seed = index * 19 + i * 7;
        result.push({
          points,
          x,
          y,
          angle: Math.sin(seed) * Math.PI,
          sx: 768 + Math.sin(seed * 1.7) * 850,
          sy: 512 + Math.cos(seed * 0.9) * 580,
        });
      }
      return result;
    })
    .filter((_, index, items) => index % Math.max(1, Math.ceil(items.length / 6000)) === 0);
}

export function sampleSceneContours(
  photo: HTMLImageElement | HTMLVideoElement,
  width: number,
  height: number,
  background: string,
): ScenePath[] {
  const sample = document.createElement("canvas");
  sample.width = 768;
  sample.height = 512;
  const g = sample.getContext("2d")!;
  const scale = Math.max(768 / width, 512 / height);
  g.fillStyle = background;
  g.fillRect(0, 0, 768, 512);
  g.drawImage(
    photo,
    (768 - width * scale) / 2,
    (512 - height * scale) / 2,
    width * scale,
    height * scale,
  );
  return extractSceneContours(g.getImageData(0, 0, 768, 512).data, 768, 512);
}
