import { requestExternal } from "./transport.js";
export async function findLogo(baseUrl: string) {
  try {
    const origin = new URL(baseUrl).origin;
    const response = await requestExternal(origin + "/favicon.ico", {
      maxBytes: 250000,
    });
    if (response.status !== 200) return "";
    const sharp = (await import("sharp")).default;
    const png = await sharp(response.bytes, { limitInputPixels: 4_000_000 })
      .resize(128, 128, { fit: "inside" })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return "";
  }
}
