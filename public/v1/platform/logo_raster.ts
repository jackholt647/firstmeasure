import sharp from "sharp";

/**
 * Draws a website's SVG logo into a PNG whose longest side is at most 800 px, or returns null when it is not an SVG
 * that can be drawn. An SVG can carry script, so the portal never hands one to the browser: the onboarding wizard
 * reads the brand colors from these pixels and uploads the PNG as the organization's logo (GP-170).
 */
export async function rasterizeSvgLogo(svg: Buffer): Promise<Buffer | null> {
  try {
    const options = { failOn: "none" as const, limitInputPixels: 4096 * 4096 };
    const meta = await sharp(svg, options).metadata();
    if (meta.format !== "svg") return null;
    const longest = Math.max(meta.width || 0, meta.height || 0) || 300;
    const density = Math.max(18, Math.min(72 * 8, Math.round((72 * 800) / longest)));
    return await sharp(svg, { ...options, density }).resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch {
    return null;
  }
}
