import { fromArrayBuffer } from "geotiff";

type RasterBand = Float32Array | Float64Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;

const DEFAULT_SAMPLE_SIZE = 48;

export async function buildInstantRenderData(input: {
  heightMapContent: Uint8Array | Buffer | null;
  maskContent: Uint8Array | Buffer | null;
  sampleSize?: number;
}) {
  if (!input.heightMapContent || !input.maskContent) {
    return null;
  }

  const [heightRaster, maskRaster] = await Promise.all([
    readSingleBandRaster(input.heightMapContent),
    readSingleBandRaster(input.maskContent)
  ]);

  if (!heightRaster || !maskRaster) {
    return null;
  }

  const cols = clampSampleSize(input.sampleSize ?? DEFAULT_SAMPLE_SIZE, heightRaster.width);
  const rows = clampSampleSize(input.sampleSize ?? DEFAULT_SAMPLE_SIZE, heightRaster.height);
  const rawHeights = new Array<number>(cols * rows);
  const masks = new Array<number>(cols * rows);
  const groundCandidates: number[] = [];
  const allCandidates: number[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const maskValue = sampleRasterBlock(maskRaster, col, row, cols, rows);
      const heightValue = sampleRasterBlock(heightRaster, col, row, cols, rows);
      const index = (row * cols) + col;
      rawHeights[index] = heightValue;
      masks[index] = roundNumber(clamp01(maskValue), 3);
      if (Number.isFinite(heightValue)) {
        allCandidates.push(heightValue);
        if (maskValue < 0.15) {
          groundCandidates.push(heightValue);
        }
      }
    }
  }

  if (!allCandidates.length) {
    return null;
  }

  const groundReference = percentile(groundCandidates.length ? groundCandidates : allCandidates, 0.18);
  const heights = new Array<number>(rawHeights.length);
  let minHeight = Number.POSITIVE_INFINITY;
  let maxHeight = 0;
  let maskMinX = cols;
  let maskMinY = rows;
  let maskMaxX = -1;
  let maskMaxY = -1;

  for (let index = 0; index < rawHeights.length; index += 1) {
    const maskValue = masks[index] ?? 0;
    const rawHeight = rawHeights[index] ?? 0;
    const relativeHeight = maskValue > 0.05
      ? Math.max(0, rawHeight - groundReference)
      : 0;
    const roundedHeight = roundNumber(relativeHeight, 2);
    heights[index] = roundedHeight;
    if (maskValue > 0.05 && roundedHeight > 0) {
      minHeight = Math.min(minHeight, roundedHeight);
      maxHeight = Math.max(maxHeight, roundedHeight);
      const row = Math.floor(index / cols);
      const col = index % cols;
      maskMinX = Math.min(maskMinX, col);
      maskMinY = Math.min(maskMinY, row);
      maskMaxX = Math.max(maskMaxX, col);
      maskMaxY = Math.max(maskMaxY, row);
    }
  }

  const hasMask = maskMaxX >= maskMinX && maskMaxY >= maskMinY;

  return {
    cols,
    rows,
    sample_source: {
      width: heightRaster.width,
      height: heightRaster.height
    },
    ground_reference_meters: roundNumber(groundReference, 2),
    min_height_meters: Number.isFinite(minHeight) ? roundNumber(minHeight, 2) : 0,
    max_height_meters: roundNumber(maxHeight, 2),
    mask_bounds: hasMask
      ? {
          left: roundNumber(maskMinX / Math.max(1, cols - 1), 4),
          right: roundNumber(maskMaxX / Math.max(1, cols - 1), 4),
          top: roundNumber(maskMinY / Math.max(1, rows - 1), 4),
          bottom: roundNumber(maskMaxY / Math.max(1, rows - 1), 4)
        }
      : null,
    heights_meters: heights,
    mask: masks
  };
}

async function readSingleBandRaster(content: Uint8Array | Buffer) {
  const tiff = await fromArrayBuffer(toArrayBuffer(content));
  const image = await tiff.getImage();
  const rasters = await image.readRasters({ interleave: false });
  const firstBand = Array.isArray(rasters) ? rasters[0] : rasters;
  if (!firstBand) {
    return null;
  }
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    data: firstBand as RasterBand
  };
}

function sampleRasterBlock(
  raster: { width: number; height: number; data: RasterBand },
  col: number,
  row: number,
  cols: number,
  rows: number
) {
  const x0 = Math.floor((col / cols) * raster.width);
  const x1 = Math.max(x0 + 1, Math.ceil(((col + 1) / cols) * raster.width));
  const y0 = Math.floor((row / rows) * raster.height);
  const y1 = Math.max(y0 + 1, Math.ceil(((row + 1) / rows) * raster.height));
  let sum = 0;
  let count = 0;

  const stepX = Math.max(1, Math.floor((x1 - x0) / 3));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 3));

  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const value = raster.data[(Math.min(raster.height - 1, y) * raster.width) + Math.min(raster.width - 1, x)];
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      sum += num;
      count += 1;
    }
  }

  if (!count) {
    const centerX = Math.min(raster.width - 1, Math.max(0, Math.round(((col + 0.5) / cols) * raster.width - 0.5)));
    const centerY = Math.min(raster.height - 1, Math.max(0, Math.round(((row + 0.5) / rows) * raster.height - 0.5)));
    return Number(raster.data[(centerY * raster.width) + centerX]) || 0;
  }

  return sum / count;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * ratio)));
  return sorted[index] ?? 0;
}

function toArrayBuffer(content: Uint8Array | Buffer) {
  const source = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
  if (source instanceof ArrayBuffer) {
    return source;
  }
  return new Uint8Array(content).buffer;
}

function clampSampleSize(value: number, sourceSize: number) {
  return Math.max(12, Math.min(sourceSize, Math.round(value)));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function roundNumber(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
