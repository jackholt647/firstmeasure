import type { JsonObject } from "../platform/storage.js";
import { env } from "../src/config/env.js";


function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function providerError(body: JsonObject) {
  const error = asObject(body.error);
  return cleanText(error.message) || cleanText(body.error) || cleanText(body.message);
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function fetchJson(url: URL) {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return {
      response: { ok: false, status: 0 } as Response,
      body: { error: error instanceof Error ? error.message : "fetch_failed" }
    };
  }
  let body: JsonObject = {};
  try {
    body = await response.json() as JsonObject;
  } catch {
    body = {};
  }
  return { response, body };
}

async function fetchBinary(url: URL) {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "image/tiff,application/octet-stream,*/*" } });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

function mediaUrl(rawUrl: unknown, key: string) {
  const url = new URL(cleanText(rawUrl));
  url.searchParams.set("key", key);
  url.searchParams.set("alt", "media");
  return url;
}

async function geocodeAddress(address: string, key: string) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", key);
  const { response, body } = await fetchJson(url);
  const first = asObject(asArray(body.results)[0]);
  const location = asObject(asObject(first.geometry).location);
  const latitude = numberValue(location.lat);
  const longitude = numberValue(location.lng);
  if (!response.ok || latitude === null || longitude === null) {
    return { ok: false, status: "geocode_failed", provider_status: cleanText(body.status), error: cleanText(body.error_message) };
  }
  return {
    ok: true,
    latitude,
    longitude,
    formatted_address: cleanText(first.formatted_address),
    location_type: cleanText(asObject(first.geometry).location_type)
  };
}

function roofAreaMeters2(insights: JsonObject) {
  const solarPotential = asObject(insights.solarPotential);
  const wholeRoofStats = asObject(solarPotential.wholeRoofStats);
  const wholeRoofArea = numberValue(wholeRoofStats.areaMeters2);
  if (wholeRoofArea && wholeRoofArea > 0) return wholeRoofArea;
  return asArray(solarPotential.roofSegmentStats)
    .map((segment) => {
      const item = asObject(segment);
      return numberValue(item.areaMeters2) ?? numberValue(asObject(item.stats).areaMeters2) ?? 0;
    })
    .reduce((sum, value) => sum + Math.max(0, value), 0);
}

export async function measureSolarRoof(input: { address?: string; latitude?: unknown; longitude?: unknown }) {
  const key = cleanText(env.googleSolarApiKey);
  const geocodeKey = cleanText(env.googleMapsApiKey);
  if (!key || !geocodeKey) return { ok: false, status: "unavailable", error: "missing_google_server_api_key" };

  let latitude = numberValue(input.latitude);
  let longitude = numberValue(input.longitude);
  let formattedAddress = cleanText(input.address);
  if ((latitude === null || longitude === null) && formattedAddress) {
    const geocoded = await geocodeAddress(formattedAddress, geocodeKey);
    if (!geocoded.ok) return geocoded;
    latitude = numberValue(geocoded.latitude);
    longitude = numberValue(geocoded.longitude);
    formattedAddress = geocoded.formatted_address || formattedAddress;
  }

  if (latitude === null || longitude === null) {
    return { ok: false, status: "missing_location", error: "address_or_coordinates_required" };
  }

  const url = new URL("https://solar.googleapis.com/v1/buildingInsights:findClosest");
  url.searchParams.set("location.latitude", String(latitude));
  url.searchParams.set("location.longitude", String(longitude));
  url.searchParams.set("requiredQuality", "HIGH");
  url.searchParams.set("key", key);
  const { response, body } = await fetchJson(url);
  if (!response.ok) {
    return {
      ok: false,
      status: "solar_api_failed",
      http: response.status,
      error: cleanText(body.error || asObject(body.error).message || body.message)
    };
  }

  const areaMeters2 = roofAreaMeters2(body);
  if (!areaMeters2) {
    return {
      ok: false,
      status: "no_roof_area",
      latitude,
      longitude,
      formatted_address: formattedAddress,
      imagery_quality: cleanText(body.imageryQuality)
    };
  }

  return {
    ok: true,
    status: "measured",
    source: "google_solar",
    latitude,
    longitude,
    formatted_address: formattedAddress || cleanText(body.name),
    roof_area_m2: Math.round(areaMeters2 * 10) / 10,
    roof_area_sqft: Math.round(areaMeters2 * 10.7639104167),
    imagery_quality: cleanText(body.imageryQuality),
    imagery_date: asObject(body.imageryDate),
    building_name: cleanText(body.name)
  };
}

export async function previewSolarProperty(input: {
  address?: string;
  latitude?: unknown;
  longitude?: unknown;
  tint?: string;
  imageSource?: "solar" | "maps";
}) {
  const key = cleanText(env.googleSolarApiKey);
  const geocodeKey = cleanText(env.googleMapsApiKey);
  const staticMapsKey = cleanText(env.googleMapsStaticApiKey);
  if (!key || !geocodeKey) return { ok: false, status: "unavailable", error: "missing_google_server_api_key" };

  let latitude = numberValue(input.latitude);
  let longitude = numberValue(input.longitude);
  let formattedAddress = cleanText(input.address);
  if (formattedAddress) {
    const geocoded = await geocodeAddress(formattedAddress, geocodeKey);
    if (geocoded.ok) {
      latitude = numberValue(geocoded.latitude);
      longitude = numberValue(geocoded.longitude);
      formattedAddress = geocoded.formatted_address || formattedAddress;
    } else if (latitude === null || longitude === null) {
      return geocoded;
    }
  }

  if (latitude === null || longitude === null) {
    return { ok: false, status: "missing_location", error: "address_or_coordinates_required" };
  }

  if (input.imageSource === "maps") {
    const mapsPreview = await renderMapsSatellitePreview(latitude, longitude, staticMapsKey);
    if (mapsPreview.ok) {
      return {
        ok: true,
        status: "ready",
        source: "google_maps_static_satellite",
        latitude,
        longitude,
        formatted_address: formattedAddress,
        imagery_quality: "",
        imagery_date: null,
        image: mapsPreview.image,
        mask: null
      };
    }
  }

  const defaultLayerAttempt = { radiusMeters: "100", pixelSizeMeters: "0.25" };
  const layerAttempts = [
    defaultLayerAttempt,
    { radiusMeters: "60", pixelSizeMeters: "0.25" }
  ];
  let response: Response | null = null;
  let body: JsonObject = {};
  let selectedAttempt = defaultLayerAttempt;
  for (const attempt of layerAttempts) {
    const layersUrl = new URL("https://solar.googleapis.com/v1/dataLayers:get");
    layersUrl.searchParams.set("location.latitude", String(latitude));
    layersUrl.searchParams.set("location.longitude", String(longitude));
    layersUrl.searchParams.set("radius_meters", attempt.radiusMeters);
    layersUrl.searchParams.set("view", "IMAGERY_AND_ANNUAL_FLUX_LAYERS");
    layersUrl.searchParams.set("requiredQuality", "LOW");
    layersUrl.searchParams.set("pixelSizeMeters", attempt.pixelSizeMeters);
    layersUrl.searchParams.set("key", key);
    const result = await fetchJson(layersUrl);
    response = result.response;
    body = result.body;
    if (response.ok) {
      selectedAttempt = attempt;
      break;
    }
  }
  if (!response?.ok) {
    return {
      ok: false,
      status: "solar_layers_failed",
      http: response?.status ?? 0,
      error: providerError(body)
    };
  }

  const rgbUrl = cleanText(body.rgbUrl);
  const maskUrl = cleanText(body.maskUrl);
  if (!rgbUrl || !maskUrl) {
    return { ok: false, status: "missing_layers", error: "solar_preview_layers_missing" };
  }

  const [rgbBytes, maskBytes, buildingInsights] = await Promise.all([
    fetchBinary(mediaUrl(rgbUrl, key)),
    fetchBinary(mediaUrl(maskUrl, key)),
    fetchSolarBuildingInsights(latitude, longitude, key)
  ]);
  if (!rgbBytes || !maskBytes) {
    return { ok: false, status: "layer_download_failed", error: "solar_preview_download_failed" };
  }

  try {
    const sharp = (await import("sharp")).default;
    const rgb = await sharp(rgbBytes, { failOn: "none" })
      .resize({ width: 1400, withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    const width = rgb.info.width;
    const height = rgb.info.height;
    const alpha = await sharp(maskBytes, { failOn: "none" })
      .resize(width, height, { fit: "fill" })
      .greyscale()
      .normalise()
      .threshold(1)
      .raw()
      .toBuffer();
    const crop =
      cropAroundBuilding(buildingInsights, latitude, longitude, width, height, Number(selectedAttempt.radiusMeters)) ??
      cropAroundMask(alpha, width, height);
    const croppedRgb = await sharp(rgb.data)
      .extract(crop)
      .png()
      .toBuffer({ resolveWithObject: true });
    const croppedAlpha = await sharp(alpha, { raw: { width, height, channels: 1 } })
      .extract(crop)
      .raw()
      .toBuffer();
    const tint = /^#[0-9a-f]{6}$/i.test(cleanText(input.tint)) ? cleanText(input.tint) : "#14b8a6";
    const overlay = await sharp({
      create: {
        width: crop.width,
        height: crop.height,
        channels: 3,
        background: tint
      }
    })
      .joinChannel(croppedAlpha, { raw: { width: crop.width, height: crop.height, channels: 1 } })
      .png()
      .toBuffer();
    return {
      ok: true,
      status: "ready",
      source: "google_solar_data_layers",
      latitude,
      longitude,
      formatted_address: formattedAddress,
      imagery_quality: cleanText(body.imageryQuality),
      imagery_date: asObject(body.imageryDate),
      image: `data:image/png;base64,${croppedRgb.data.toString("base64")}`,
      mask: `data:image/png;base64,${overlay.toString("base64")}`
    };
  } catch (error) {
    return {
      ok: false,
      status: "render_failed",
      error: error instanceof Error ? error.message : "solar_preview_render_failed"
    };
  }
}

async function renderMapsSatellitePreview(latitude: number, longitude: number, key: string) {
  const url = new URL("https://maps.googleapis.com/maps/api/staticmap");
  url.searchParams.set("center", `${latitude},${longitude}`);
  url.searchParams.set("zoom", "20");
  url.searchParams.set("size", "640x596");
  url.searchParams.set("scale", "2");
  url.searchParams.set("maptype", "satellite");
  url.searchParams.set("key", key);
  const bytes = await fetchBinary(url);
  if (!bytes) return { ok: false, error: "maps_static_download_failed" };
  try {
    const sharp = (await import("sharp")).default;
    const rendered = await sharp(bytes, { failOn: "none" })
      .resize({ width: 1400, withoutEnlargement: true })
      .png()
      .toBuffer();
    return { ok: true, image: `data:image/png;base64,${rendered.toString("base64")}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "maps_static_render_failed" };
  }
}

async function fetchSolarBuildingInsights(latitude: number, longitude: number, key: string) {
  const url = new URL("https://solar.googleapis.com/v1/buildingInsights:findClosest");
  url.searchParams.set("location.latitude", String(latitude));
  url.searchParams.set("location.longitude", String(longitude));
  url.searchParams.set("requiredQuality", "HIGH");
  url.searchParams.set("key", key);
  const { response, body } = await fetchJson(url);
  return response.ok ? body : null;
}

function cropAroundBuilding(
  insights: JsonObject | null,
  requestLatitude: number,
  requestLongitude: number,
  width: number,
  height: number,
  radiusMeters: number
) {
  if (!insights || !Number.isFinite(radiusMeters) || radiusMeters <= 0) return null;
  const center = geoPoint(asObject(insights.center));
  if (!center) return null;

  const pixel = geoPointToPixel(center.latitude, center.longitude, requestLatitude, requestLongitude, width, height, radiusMeters);
  if (!pixel) return null;

  const boundingBox = asObject(insights.boundingBox);
  const sw = geoPoint(asObject(boundingBox.sw));
  const ne = geoPoint(asObject(boundingBox.ne));
  const buildingWidthMeters = sw && ne ? longitudeMeters(ne.longitude - sw.longitude, requestLatitude) : 0;
  const buildingHeightMeters = sw && ne ? latitudeMeters(ne.latitude - sw.latitude) : 0;
  const metersPerPixel = (radiusMeters * 2) / Math.min(width, height);
  const buildingMaxMeters = Math.max(
    Math.abs(buildingWidthMeters),
    Math.abs(buildingHeightMeters),
    18
  );
  const cropMeters = Math.min(radiusMeters * 2, Math.max(132, buildingMaxMeters * 6));
  const targetAspect = 1.08;
  let cropWidth = Math.min(width, Math.round(cropMeters / metersPerPixel));
  let cropHeight = Math.min(height, Math.round(cropWidth / targetAspect));
  if (cropHeight > height) {
    cropHeight = height;
    cropWidth = Math.min(width, Math.round(cropHeight * targetAspect));
  }
  cropWidth = Math.max(1, cropWidth);
  cropHeight = Math.max(1, cropHeight);
  return {
    left: clamp(Math.round(pixel.x - cropWidth / 2), 0, width - cropWidth),
    top: clamp(Math.round(pixel.y - cropHeight / 2), 0, height - cropHeight),
    width: cropWidth,
    height: cropHeight
  };
}

function cropAroundMask(alpha: Buffer, width: number, height: number) {
  const bounds = maskBounds(alpha, width, height);
  if (!bounds) return { left: 0, top: 0, width, height };
  const boxWidth = bounds.right - bounds.left + 1;
  const boxHeight = bounds.bottom - bounds.top + 1;
  const targetAspect = 1.08;
  const paddingFactor = 3.8;
  let cropWidth = Math.max(boxWidth * paddingFactor, 520);
  let cropHeight = cropWidth / targetAspect;
  const minHeight = Math.max(boxHeight * paddingFactor, 520);
  if (cropHeight < minHeight) {
    cropHeight = minHeight;
    cropWidth = cropHeight * targetAspect;
  }
  cropWidth = Math.min(width, Math.ceil(cropWidth));
  cropHeight = Math.min(height, Math.ceil(cropHeight));
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const roundedWidth = Math.max(1, Math.round(cropWidth));
  const roundedHeight = Math.max(1, Math.round(cropHeight));
  const left = clamp(Math.round(centerX - roundedWidth / 2), 0, width - roundedWidth);
  const top = clamp(Math.round(centerY - roundedHeight / 2), 0, height - roundedHeight);
  return {
    left,
    top,
    width: roundedWidth,
    height: roundedHeight
  };
}

function geoPoint(value: JsonObject) {
  const latitude = numberValue(value.latitude);
  const longitude = numberValue(value.longitude);
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

function geoPointToPixel(
  latitude: number,
  longitude: number,
  originLatitude: number,
  originLongitude: number,
  width: number,
  height: number,
  radiusMeters: number
) {
  const metersPerPixel = (radiusMeters * 2) / Math.min(width, height);
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) return null;
  const eastMeters = longitudeMeters(longitude - originLongitude, originLatitude);
  const northMeters = latitudeMeters(latitude - originLatitude);
  return {
    x: width / 2 + eastMeters / metersPerPixel,
    y: height / 2 - northMeters / metersPerPixel
  };
}

function latitudeMeters(deltaDegrees: number) {
  return deltaDegrees * 111_320;
}

function longitudeMeters(deltaDegrees: number, latitude: number) {
  return deltaDegrees * 111_320 * Math.cos((latitude * Math.PI) / 180);
}

function maskBounds(alpha: Buffer, width: number, height: number) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((alpha[y * width + x] ?? 0) <= 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right >= left && bottom >= top ? { left, right, top, bottom } : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
