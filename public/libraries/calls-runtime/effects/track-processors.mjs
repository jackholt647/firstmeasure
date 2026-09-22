// src/utils.ts
var supportsOffscreenCanvas = () => typeof OffscreenCanvas !== "undefined";
async function sleep(time) {
  return new Promise((resolve) => setTimeout(resolve, time));
}
async function waitForTrackResolution(track) {
  const timeout = 500;
  await sleep(10);
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const { width, height } = track.getSettings();
    if (width && height) {
      return { width, height };
    }
    await sleep(50);
  }
  return { width: void 0, height: void 0 };
}
function createCanvas(width, height) {
  if (supportsOffscreenCanvas()) {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// src/logger.ts
import { getLogger as clientGetLogger } from "./logger.mjs";
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["trace"] = 0] = "trace";
  LogLevel2[LogLevel2["debug"] = 1] = "debug";
  LogLevel2[LogLevel2["info"] = 2] = "info";
  LogLevel2[LogLevel2["warn"] = 3] = "warn";
  LogLevel2[LogLevel2["error"] = 4] = "error";
  LogLevel2[LogLevel2["silent"] = 5] = "silent";
  return LogLevel2;
})(LogLevel || {});
var LoggerNames = /* @__PURE__ */ ((LoggerNames2) => {
  LoggerNames2["ProcessorWrapper"] = "livekit-processor-wrapper";
  LoggerNames2["BackgroundProcessor"] = "livekit-background-processor";
  LoggerNames2["WebGl"] = "livekit-track-processor-web-gl";
  return LoggerNames2;
})(LoggerNames || {});
var livekitLogger = getLogger("livekit");
var livekitLoggers = Object.values(LoggerNames).map((name) => getLogger(name));
livekitLogger.setDefaultLevel(2 /* info */);
function getLogger(name) {
  return clientGetLogger(name);
}
function setLogLevel(level, loggerName) {
  if (loggerName) {
    getLogger(loggerName).setLevel(level);
  } else {
    for (const logger of livekitLoggers) {
      logger.setLevel(level);
    }
  }
}
function setLogExtension(extension, logger) {
  const loggers = logger ? [logger] : livekitLoggers;
  loggers.forEach((logR) => {
    const originalFactory = logR.methodFactory;
    logR.methodFactory = (methodName, configLevel, loggerName) => {
      const rawMethod = originalFactory(methodName, configLevel, loggerName);
      const logLevel = LogLevel[methodName];
      const needLog = logLevel >= configLevel && logLevel < 5 /* silent */;
      return (msg, context) => {
        if (context)
          rawMethod(msg, context);
        else
          rawMethod(msg);
        if (needLog) {
          extension(logLevel, msg, context);
        }
      };
    };
    logR.setLevel(logR.getLevel());
  });
}

// src/ProcessorWrapper.ts
var ProcessorWrapper = class _ProcessorWrapper {
  constructor(transformer, name, options = {}) {
    // For tracking whether we're using the stream API fallback
    this.useStreamFallback = false;
    this.processingEnabled = false;
    this.log = getLogger("livekit-processor-wrapper" /* ProcessorWrapper */);
    this.lifecycleState = "idle";
    var _a;
    this.name = name;
    this.transformer = transformer;
    this.maxFps = (_a = options.maxFps) != null ? _a : 30;
  }
  /**
   * Determines if the Processor is supported on the current browser
   */
  static get isSupported() {
    const hasStreamProcessor = typeof MediaStreamTrackGenerator !== "undefined" && typeof MediaStreamTrackProcessor !== "undefined";
    const hasFallbackSupport = typeof HTMLCanvasElement !== "undefined" && typeof VideoFrame !== "undefined" && "captureStream" in HTMLCanvasElement.prototype;
    return hasStreamProcessor || hasFallbackSupport;
  }
  /**
   * Determines if modern browser APIs are supported, which yield better performance
   */
  static get hasModernApiSupport() {
    return typeof MediaStreamTrackGenerator !== "undefined" && typeof MediaStreamTrackProcessor !== "undefined";
  }
  async setup(opts) {
    this.source = opts.track;
    const { width, height } = await waitForTrackResolution(this.source);
    this.sourceDummy = opts.element;
    if (!(this.sourceDummy instanceof HTMLVideoElement)) {
      throw TypeError("Currently only video transformers are supported");
    }
    if (this.sourceDummy instanceof HTMLVideoElement) {
      this.sourceDummy.height = height != null ? height : 300;
      this.sourceDummy.width = width != null ? width : 300;
    }
    this.useStreamFallback = !_ProcessorWrapper.hasModernApiSupport;
    if (this.useStreamFallback) {
      const existingCanvas = document.querySelector(
        'canvas[data-livekit-processor="' + this.name + '"]'
      );
      if (existingCanvas) {
        this.displayCanvas = existingCanvas;
        this.displayCanvas.width = width != null ? width : 300;
        this.displayCanvas.height = height != null ? height : 300;
      } else {
        this.displayCanvas = document.createElement("canvas");
        this.displayCanvas.width = width != null ? width : 300;
        this.displayCanvas.height = height != null ? height : 300;
        this.displayCanvas.style.display = "none";
        this.displayCanvas.dataset.livekitProcessor = this.name;
        document.body.appendChild(this.displayCanvas);
      }
      this.renderContext = this.displayCanvas.getContext("2d");
      this.capturedStream = this.displayCanvas.captureStream();
      this.canvas = createCanvas(width != null ? width : 300, height != null ? height : 300);
    } else {
      this.processor = new MediaStreamTrackProcessor({ track: this.source });
      this.trackGenerator = new MediaStreamTrackGenerator({
        kind: "video",
        signalTarget: this.source
      });
      this.canvas = createCanvas(width != null ? width : 300, height != null ? height : 300);
    }
  }
  async init(opts) {
    this.log.debug("Init called");
    this.lifecycleState = "initializing";
    await this.setup(opts);
    if (!this.canvas) {
      throw new TypeError("Expected canvas to be defined after setup");
    }
    await this.transformer.init({
      outputCanvas: this.canvas,
      inputElement: this.sourceDummy
    });
    if (this.useStreamFallback) {
      this.initFallbackPath();
    } else {
      this.initStreamProcessorPath();
    }
    this.lifecycleState = "running";
  }
  initStreamProcessorPath() {
    if (!this.processor || !this.trackGenerator) {
      throw new TypeError(
        "Expected processor and trackGenerator to be defined for stream processor path"
      );
    }
    const readableStream = this.processor.readable;
    const pipedStream = readableStream.pipeThrough(this.transformer.transformer);
    pipedStream.pipeTo(this.trackGenerator.writable).then(() => this.handleMediaExhausted()).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") {
        this.log.log("stream processor path aborted");
      } else if (e instanceof DOMException && e.name === "InvalidStateError" && e.message === "Stream closed") {
        this.log.log("stream processor underlying stream closed");
        this.handleMediaExhausted();
      } else {
        this.log.error("error when trying to pipe", e);
        this.destroy();
      }
    });
    this.processedTrack = this.trackGenerator;
  }
  initFallbackPath() {
    if (!this.capturedStream || !this.source || !this.canvas || !this.renderContext) {
      throw new TypeError("Missing required components for fallback implementation");
    }
    this.processedTrack = this.capturedStream.getVideoTracks()[0];
    this.processingEnabled = true;
    this.frameCallback = (frame) => {
      if (!this.processingEnabled || !frame) {
        frame.close();
        return;
      }
      const controller = {
        enqueue: (processedFrame) => {
          if (this.renderContext && this.displayCanvas) {
            this.renderContext.drawImage(
              processedFrame,
              0,
              0,
              this.displayCanvas.width,
              this.displayCanvas.height
            );
            processedFrame.close();
          }
        }
      };
      try {
        this.transformer.transform(frame, controller);
      } catch (e) {
        this.log.error("Error in transform:", e);
        frame.close();
      }
    };
    this.startRenderLoop();
  }
  startRenderLoop() {
    if (!this.sourceDummy || !(this.sourceDummy instanceof HTMLVideoElement)) {
      this.handleMediaExhausted();
      return;
    }
    let lastVideoTimestamp = -1;
    let lastFrameTime = 0;
    const videoElement = this.sourceDummy;
    const minFrameInterval = 1e3 / this.maxFps;
    let estimatedVideoFps = this.maxFps;
    let frameTimeHistory = [];
    let lastVideoTimeChange = 0;
    let frameCount = 0;
    let lastFpsLog = 0;
    const renderLoop = () => {
      if (!this.processingEnabled || !this.sourceDummy || !(this.sourceDummy instanceof HTMLVideoElement)) {
        this.handleMediaExhausted();
        return;
      }
      if (this.sourceDummy.paused) {
        this.log.warn("Video is paused, trying to play");
        this.sourceDummy.play().then(() => {
          this.animationFrameId = requestAnimationFrame(renderLoop);
        });
        return;
      }
      const videoTime = videoElement.currentTime;
      const now = performance.now();
      const timeSinceLastFrame = now - lastFrameTime;
      const hasNewFrame = videoTime !== lastVideoTimestamp;
      if (hasNewFrame) {
        if (lastVideoTimeChange > 0) {
          const timeBetweenFrames = now - lastVideoTimeChange;
          frameTimeHistory.push(timeBetweenFrames);
          if (frameTimeHistory.length > 10) {
            frameTimeHistory.shift();
          }
          if (frameTimeHistory.length > 2) {
            const avgFrameTime = frameTimeHistory.reduce((sum, time) => sum + time, 0) / frameTimeHistory.length;
            estimatedVideoFps = 1e3 / avgFrameTime;
            const isDevelopment = typeof window !== "undefined" && window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
            if (isDevelopment && now - lastFpsLog > 5e3) {
              this.log.debug(
                `[${this.name}] Estimated video FPS: ${estimatedVideoFps.toFixed(
                  1
                )}, Processing at: ${(frameCount / 5).toFixed(1)} FPS`
              );
              frameCount = 0;
              lastFpsLog = now;
            }
          }
        }
        lastVideoTimeChange = now;
      }
      const timeThresholdMet = timeSinceLastFrame >= minFrameInterval;
      if (hasNewFrame && timeThresholdMet) {
        lastVideoTimestamp = videoTime;
        lastFrameTime = now;
        frameCount++;
        try {
          if (videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const frame = new VideoFrame(videoElement);
            if (this.frameCallback) {
              this.frameCallback(frame);
            } else {
              frame.close();
            }
          }
        } catch (e) {
          this.log.error("Error in render loop:", e);
        }
      }
      this.animationFrameId = requestAnimationFrame(renderLoop);
    };
    this.animationFrameId = requestAnimationFrame(renderLoop);
  }
  async restart(opts) {
    this.log.debug("Restart called");
    await this.destroy({ willProcessorRestart: true });
    await this.init(opts);
  }
  async restartTransformer(...options) {
    await this.transformer.restart(options[0]);
  }
  async updateTransformerOptions(...options) {
    await this.transformer.update(options[0]);
  }
  /** Called if the media pipeline no longer can read frames to process from the source media */
  async handleMediaExhausted() {
    this.log.debug("Media was exhausted from source");
    if (this.lifecycleState !== "running") {
      return;
    }
    this.lifecycleState = "media-exhausted";
    await this.cleanup();
  }
  /** Tears down the media stack logic initialized in initStreamProcessorPath / initFallbackPath */
  async cleanup() {
    var _a, _b, _c, _d;
    if (this.useStreamFallback) {
      this.processingEnabled = false;
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = void 0;
      }
      if (this.displayCanvas && this.displayCanvas.parentNode) {
        this.displayCanvas.parentNode.removeChild(this.displayCanvas);
      }
      (_a = this.capturedStream) == null ? void 0 : _a.getTracks().forEach((track) => track.stop());
    } else {
      await ((_c = (_b = this.processor) == null ? void 0 : _b.writableControl) == null ? void 0 : _c.close());
      (_d = this.trackGenerator) == null ? void 0 : _d.stop();
    }
  }
  async destroy(transformerDestroyOptions = { willProcessorRestart: false }) {
    this.log.debug(`Destroy called - lifecycleState=${this.lifecycleState}, transformerDestroyOptions=${JSON.stringify(transformerDestroyOptions)}`);
    switch (this.lifecycleState) {
      case "running":
      case "media-exhausted":
        this.lifecycleState = "destroying";
        await this.cleanup();
        await this.transformer.destroy(transformerDestroyOptions);
        this.lifecycleState = "destroyed";
        break;
      default:
        break;
    }
  }
};

// src/transformers/BackgroundTransformer.ts
import * as vision from "./vision_bundle.mjs";

// package.json
var dependencies = {
  "@mediapipe/tasks-vision": "0.10.14"
};

// src/webgl/utils.ts
var log = getLogger("livekit-track-processor-web-gl" /* WebGl */);
function initTexture(gl, texIndex) {
  const texRef = gl.TEXTURE0 + texIndex;
  gl.activeTexture(texRef);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  return texture;
}
function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    log.error("Shader compile failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    throw new Error("Shader compile failed");
  }
  return shader;
}
function createProgram(gl, vs, fs) {
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    log.error("Program link failed:", gl.getProgramInfoLog(program));
    throw new Error("Program link failed");
  }
  return program;
}
function createFramebuffer(gl, texture, width, height) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Framebuffer not complete");
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return framebuffer;
}
function createVertexBuffer(gl) {
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, -1, 1, 1, 1, -1, -1, 1, 1, 1, -1]),
    gl.STATIC_DRAW
  );
  return vertexBuffer;
}
async function resizeImageToCover(image, targetWidth, targetHeight) {
  const imgAspect = image.width / image.height;
  const targetAspect = targetWidth / targetHeight;
  let sx = 0;
  let sy = 0;
  let sWidth = image.width;
  let sHeight = image.height;
  if (imgAspect > targetAspect) {
    sWidth = Math.round(image.height * targetAspect);
    sx = Math.round((image.width - sWidth) / 2);
  } else if (imgAspect < targetAspect) {
    sHeight = Math.round(image.width / targetAspect);
    sy = Math.round((image.height - sHeight) / 2);
  }
  return createImageBitmap(image, sx, sy, sWidth, sHeight, {
    resizeWidth: targetWidth,
    resizeHeight: targetHeight,
    resizeQuality: "medium"
  });
}
var emptyImageData;
function getEmptyImageData() {
  if (!emptyImageData) {
    emptyImageData = new ImageData(2, 2);
    emptyImageData.data[0] = 0;
    emptyImageData.data[1] = 0;
    emptyImageData.data[2] = 0;
    emptyImageData.data[3] = 0;
  }
  return emptyImageData;
}
var glsl = (source) => source;

// src/webgl/shader-programs/vertexShader.ts
var vertexShaderSource = (flipY = true) => `#version 300 es
  in vec2 position;
  out vec2 texCoords;

  void main() {
    texCoords = (position + 1.0) / 2.0;
    texCoords.y = ${flipY ? "1.0 - texCoords.y" : "texCoords.y"};
    gl_Position = vec4(position, 0, 1.0);
  }
`;

// src/webgl/shader-programs/blurShader.ts
var blurFragmentShader = glsl`#version 300 es
  precision mediump float;
  in vec2 texCoords;
  uniform sampler2D u_texture;
  uniform vec2 u_texelSize;
  uniform vec2 u_direction;
  uniform float u_radius;
  out vec4 fragColor;

  void main() {
    float sigma = u_radius;
    float twoSigmaSq = 2.0 * sigma * sigma;
    float totalWeight = 0.0;
    vec3 result = vec3(0.0);
    const int MAX_SAMPLES = 16;
    int radius = int(min(float(MAX_SAMPLES), ceil(u_radius)));

    for (int i = -MAX_SAMPLES; i <= MAX_SAMPLES; ++i) {
      float offset = float(i);
      if (abs(offset) > float(radius)) continue;
      float weight = exp(-(offset * offset) / twoSigmaSq);
      vec2 sampleCoord = texCoords + u_direction * u_texelSize * offset;
      result += texture(u_texture, sampleCoord).rgb * weight;
      totalWeight += weight;
    }

    fragColor = vec4(result / totalWeight, 1.0);
  }
`;
function createBlurProgram(gl) {
  const blurVertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource());
  const blurFrag = createShader(gl, gl.FRAGMENT_SHADER, blurFragmentShader);
  const blurProgram = createProgram(gl, blurVertexShader, blurFrag);
  const blurUniforms = {
    position: gl.getAttribLocation(blurProgram, "position"),
    texture: gl.getUniformLocation(blurProgram, "u_texture"),
    texelSize: gl.getUniformLocation(blurProgram, "u_texelSize"),
    direction: gl.getUniformLocation(blurProgram, "u_direction"),
    radius: gl.getUniformLocation(blurProgram, "u_radius")
  };
  return {
    program: blurProgram,
    shader: blurFrag,
    vertexShader: blurVertexShader,
    uniforms: blurUniforms
  };
}
function applyBlur(gl, sourceTexture, width, height, blurRadius, blurProgram, blurUniforms, vertexBuffer, processFramebuffers, processTextures) {
  gl.useProgram(blurProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.vertexAttribPointer(blurUniforms.position, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(blurUniforms.position);
  const texelWidth = 1 / width;
  const texelHeight = 1 / height;
  gl.bindFramebuffer(gl.FRAMEBUFFER, processFramebuffers[0]);
  gl.viewport(0, 0, width, height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
  gl.uniform1i(blurUniforms.texture, 0);
  gl.uniform2f(blurUniforms.texelSize, texelWidth, texelHeight);
  gl.uniform2f(blurUniforms.direction, 1, 0);
  gl.uniform1f(blurUniforms.radius, blurRadius);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindFramebuffer(gl.FRAMEBUFFER, processFramebuffers[1]);
  gl.viewport(0, 0, width, height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, processTextures[0]);
  gl.uniform1i(blurUniforms.texture, 0);
  gl.uniform2f(blurUniforms.direction, 0, 1);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return processTextures[1];
}

// src/webgl/shader-programs/boxBlurShader.ts
var boxBlurFragmentShader = glsl`#version 300 es
precision mediump float;

in vec2 texCoords;

uniform sampler2D u_texture;
uniform vec2 u_texelSize;    // 1.0 / texture size
uniform vec2 u_direction;    // (1.0, 0.0) for horizontal, (0.0, 1.0) for vertical
uniform float u_radius;      // blur radius in texels

out vec4 fragColor;

void main() {
    vec3 sum = vec3(0.0);
    float count = 0.0;

    // Limit radius to avoid excessive loop cost
    const int MAX_RADIUS = 16;
    int radius = int(min(float(MAX_RADIUS), u_radius));

    for (int i = -MAX_RADIUS; i <= MAX_RADIUS; ++i) {
        if (abs(i) > radius) continue;

        vec2 offset = u_direction * u_texelSize * float(i);
        sum += texture(u_texture, texCoords + offset).rgb;
        count += 1.0;
  }

  fragColor = vec4(sum / count, 1.0);
}
`;
function createBoxBlurProgram(gl) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource());
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, boxBlurFragmentShader);
  const program = createProgram(gl, vertexShader, fragmentShader);
  const uniforms = {
    position: gl.getAttribLocation(program, "position"),
    texture: gl.getUniformLocation(program, "u_texture"),
    texelSize: gl.getUniformLocation(program, "u_texelSize"),
    direction: gl.getUniformLocation(program, "u_direction"),
    radius: gl.getUniformLocation(program, "u_radius")
  };
  return {
    program,
    vertexShader,
    fragmentShader,
    uniforms
  };
}

// src/webgl/shader-programs/compositeShader.ts
var compositeFragmentShader = glsl`#version 300 es
  precision mediump float;
  in vec2 texCoords;
  uniform sampler2D background;
  uniform bool disableBackground;
  uniform sampler2D frame;
  uniform sampler2D mask;
  out vec4 fragColor;
  
  void main() {
    vec4 frameTex = texture(frame, texCoords);

    if (disableBackground) {
      fragColor = frameTex;
    } else {
      vec4 bgTex = texture(background, texCoords);

      float maskVal = texture(mask, texCoords).r;

      // Compute screen-space gradient to detect edge sharpness
      float grad = length(vec2(dFdx(maskVal), dFdy(maskVal)));

      float edgeSoftness = 2.0; // higher = softer

      // Create a smooth edge around binary transition
      float smoothAlpha = smoothstep(0.5 - grad * edgeSoftness, 0.5 + grad * edgeSoftness, maskVal);

      // Optional: preserve frame alpha, or override as fully opaque
      vec4 blended = mix(bgTex, vec4(frameTex.rgb, 1.0), 1.0 - smoothAlpha);
      fragColor = blended;
    }
  
  }
`;
function createCompositeProgram(gl) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource());
  const compositeShader = createShader(gl, gl.FRAGMENT_SHADER, compositeFragmentShader);
  const compositeProgram = createProgram(gl, vertexShader, compositeShader);
  const attribLocations = {
    position: gl.getAttribLocation(compositeProgram, "position")
  };
  const uniformLocations = {
    mask: gl.getUniformLocation(compositeProgram, "mask"),
    frame: gl.getUniformLocation(compositeProgram, "frame"),
    background: gl.getUniformLocation(compositeProgram, "background"),
    disableBackground: gl.getUniformLocation(compositeProgram, "disableBackground"),
    stepWidth: gl.getUniformLocation(compositeProgram, "u_stepWidth")
  };
  return {
    program: compositeProgram,
    vertexShader,
    fragmentShader: compositeShader,
    attribLocations,
    uniformLocations
  };
}

// src/webgl/shader-programs/downSampler.ts
function createDownSampler(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const vertexSource = `
      attribute vec2 position;
      varying vec2 v_uv;
      void main() {
        v_uv = (position + 1.0) * 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;
  const fragmentSource = `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_texture;
      void main() {
        gl_FragColor = texture2D(u_texture, v_uv);
      }
    `;
  const vertShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = createProgram(gl, vertShader, fragShader);
  const uniforms = {
    texture: gl.getUniformLocation(program, "u_texture"),
    position: gl.getAttribLocation(program, "position")
  };
  return {
    framebuffer,
    texture,
    program,
    uniforms
  };
}
function applyDownsampling(gl, inputTexture, downSampler, vertexBuffer, width, height) {
  gl.useProgram(downSampler.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, downSampler.framebuffer);
  gl.viewport(0, 0, width, height);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.enableVertexAttribArray(downSampler.uniforms.position);
  gl.vertexAttribPointer(downSampler.uniforms.position, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, inputTexture);
  gl.uniform1i(downSampler.uniforms.texture, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return downSampler.texture;
}

// src/webgl/index.ts
var log2 = getLogger("livekit-track-processor-web-gl" /* WebGl */);
var setupWebGL = (canvas) => {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    premultipliedAlpha: true
  });
  let blurRadius = null;
  let maskBlurRadius = 8;
  const downsampleFactor = 4;
  if (!gl) {
    log2.error("Failed to create WebGL context");
    return void 0;
  }
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  const composite = createCompositeProgram(gl);
  const compositeProgram = composite.program;
  const positionLocation = composite.attribLocations.position;
  const {
    mask: maskTextureLocation,
    frame: frameTextureLocation,
    background: bgTextureLocation,
    disableBackground: disableBackgroundLocation
  } = composite.uniformLocations;
  const blur = createBlurProgram(gl);
  const blurProgram = blur.program;
  const blurUniforms = blur.uniforms;
  const boxBlur = createBoxBlurProgram(gl);
  const boxBlurProgram = boxBlur.program;
  const boxBlurUniforms = boxBlur.uniforms;
  const bgTexture = initTexture(gl, 0);
  const frameTexture = initTexture(gl, 1);
  const vertexBuffer = createVertexBuffer(gl);
  if (!vertexBuffer) {
    throw new Error("Failed to create vertex buffer");
  }
  let bgBlurTextures = [];
  let bgBlurFrameBuffers = [];
  let blurredMaskTexture = null;
  let finalMaskTextures = [];
  let readMaskIndex = 0;
  let writeMaskIndex = 1;
  bgBlurTextures.push(initTexture(gl, 3));
  bgBlurTextures.push(initTexture(gl, 4));
  const bgBlurTextureWidth = Math.floor(canvas.width / downsampleFactor);
  const bgBlurTextureHeight = Math.floor(canvas.height / downsampleFactor);
  const downSampler = createDownSampler(gl, bgBlurTextureWidth, bgBlurTextureHeight);
  bgBlurFrameBuffers.push(
    createFramebuffer(gl, bgBlurTextures[0], bgBlurTextureWidth, bgBlurTextureHeight)
  );
  bgBlurFrameBuffers.push(
    createFramebuffer(gl, bgBlurTextures[1], bgBlurTextureWidth, bgBlurTextureHeight)
  );
  const tempMaskTexture = initTexture(gl, 5);
  const tempMaskFrameBuffer = createFramebuffer(gl, tempMaskTexture, canvas.width, canvas.height);
  finalMaskTextures.push(initTexture(gl, 6));
  finalMaskTextures.push(initTexture(gl, 7));
  const finalMaskFrameBuffers = [
    createFramebuffer(gl, finalMaskTextures[0], canvas.width, canvas.height),
    createFramebuffer(gl, finalMaskTextures[1], canvas.width, canvas.height)
  ];
  let backgroundImageDisabled = false;
  gl.useProgram(compositeProgram);
  gl.uniform1i(disableBackgroundLocation, backgroundImageDisabled ? 1 : 0);
  gl.uniform1i(bgTextureLocation, 0);
  gl.uniform1i(frameTextureLocation, 1);
  gl.uniform1i(maskTextureLocation, 2);
  let customBackgroundImage = null;
  function renderFrame(frame) {
    if (frame.codedWidth === 0 || finalMaskTextures.length === 0) {
      return;
    }
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, frameTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    let backgroundTexture = bgTexture;
    if (blurRadius) {
      const downSampledFrameTexture = applyDownsampling(
        gl,
        frameTexture,
        downSampler,
        vertexBuffer,
        bgBlurTextureWidth,
        bgBlurTextureHeight
      );
      backgroundTexture = applyBlur(
        gl,
        downSampledFrameTexture,
        bgBlurTextureWidth,
        bgBlurTextureHeight,
        blurRadius,
        blurProgram,
        blurUniforms,
        vertexBuffer,
        bgBlurFrameBuffers,
        bgBlurTextures
      );
    } else if (customBackgroundImage) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bgTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, customBackgroundImage);
      backgroundTexture = bgTexture;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(compositeProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(positionLocation);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, backgroundTexture);
    gl.uniform1i(bgTextureLocation, 0);
    gl.uniform1i(disableBackgroundLocation, backgroundImageDisabled ? 1 : 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, frameTexture);
    gl.uniform1i(frameTextureLocation, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, finalMaskTextures[readMaskIndex]);
    gl.uniform1i(maskTextureLocation, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  async function setBackgroundImage(image) {
    customBackgroundImage = null;
    if (image) {
      customBackgroundImage = getEmptyImageData();
      try {
        const croppedImage = await resizeImageToCover(image, canvas.width, canvas.height);
        customBackgroundImage = croppedImage;
      } catch (error) {
        log2.error(
          "Error processing background image, falling back to black background:",
          error
        );
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, bgTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, customBackgroundImage);
    }
  }
  function setBlurRadius(radius) {
    blurRadius = radius ? Math.max(1, Math.floor(radius / downsampleFactor)) : null;
    setBackgroundImage(null);
  }
  function setBackgroundDisabled(disabled) {
    backgroundImageDisabled = disabled;
  }
  function updateMask(mask) {
    const tempFramebuffers = [tempMaskFrameBuffer, finalMaskFrameBuffers[writeMaskIndex]];
    const tempTextures = [tempMaskTexture, finalMaskTextures[writeMaskIndex]];
    applyBlur(
      gl,
      mask,
      canvas.width,
      canvas.height,
      maskBlurRadius || 1,
      boxBlurProgram,
      boxBlurUniforms,
      vertexBuffer,
      tempFramebuffers,
      tempTextures
    );
    readMaskIndex = writeMaskIndex;
    writeMaskIndex = 1 - writeMaskIndex;
  }
  function cleanup() {
    gl.deleteProgram(compositeProgram);
    gl.deleteProgram(blurProgram);
    gl.deleteProgram(boxBlurProgram);
    gl.deleteTexture(bgTexture);
    gl.deleteTexture(frameTexture);
    gl.deleteTexture(tempMaskTexture);
    gl.deleteFramebuffer(tempMaskFrameBuffer);
    for (const texture of bgBlurTextures) {
      gl.deleteTexture(texture);
    }
    for (const framebuffer of bgBlurFrameBuffers) {
      gl.deleteFramebuffer(framebuffer);
    }
    for (const texture of finalMaskTextures) {
      gl.deleteTexture(texture);
    }
    for (const framebuffer of finalMaskFrameBuffers) {
      gl.deleteFramebuffer(framebuffer);
    }
    gl.deleteBuffer(vertexBuffer);
    if (blurredMaskTexture) {
      gl.deleteTexture(blurredMaskTexture);
    }
    if (downSampler) {
      gl.deleteTexture(downSampler.texture);
      gl.deleteFramebuffer(downSampler.framebuffer);
      gl.deleteProgram(downSampler.program);
    }
    if (customBackgroundImage) {
      if (customBackgroundImage instanceof ImageBitmap) {
        customBackgroundImage.close();
      }
      customBackgroundImage = null;
    }
    bgBlurTextures = [];
    bgBlurFrameBuffers = [];
    finalMaskTextures = [];
  }
  return { renderFrame, updateMask, setBackgroundImage, setBlurRadius, setBackgroundDisabled, cleanup };
};

// src/transformers/VideoTransformer.ts
var VideoTransformer = class {
  constructor() {
    this.isDisabled = false;
  }
  async init({
    outputCanvas,
    inputElement: inputVideo
  }) {
    if (!(inputVideo instanceof HTMLVideoElement)) {
      throw TypeError("Video transformer needs a HTMLVideoElement as input");
    }
    this.transformer = new TransformStream({
      transform: (frame, controller) => this.transform(frame, controller)
    });
    this.canvas = outputCanvas || null;
    if (outputCanvas) {
      this.gl = setupWebGL(
        this.canvas || createCanvas(inputVideo.videoWidth, inputVideo.videoHeight)
      );
    }
    this.inputVideo = inputVideo;
    this.isDisabled = false;
  }
  async restart({ outputCanvas, inputElement: inputVideo }) {
    var _a;
    this.canvas = outputCanvas || null;
    (_a = this.gl) == null ? void 0 : _a.cleanup();
    this.gl = setupWebGL(
      this.canvas || createCanvas(inputVideo.videoWidth, inputVideo.videoHeight)
    );
    this.inputVideo = inputVideo;
    this.isDisabled = false;
  }
  async destroy() {
    var _a;
    this.isDisabled = true;
    this.canvas = void 0;
    (_a = this.gl) == null ? void 0 : _a.cleanup();
    this.gl = void 0;
  }
};

// src/transformers/BackgroundTransformer.ts
var BackgroundProcessor = class extends VideoTransformer {
  constructor(opts) {
    super();
    this.backgroundImageAndPath = null;
    this.segmentationTimeMs = 0;
    this.isFirstFrame = true;
    this.log = getLogger("livekit-processor-wrapper" /* ProcessorWrapper */);
    this.options = opts;
    this.update(opts);
  }
  static get isSupported() {
    return typeof OffscreenCanvas !== "undefined" && typeof VideoFrame !== "undefined" && typeof createImageBitmap !== "undefined" && !!document.createElement("canvas").getContext("webgl2");
  }
  async init({ outputCanvas, inputElement: inputVideo }) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    await super.init({ outputCanvas, inputElement: inputVideo });
    const fileSet = await vision.FilesetResolver.forVisionTasks(
      (_b = (_a = this.options.assetPaths) == null ? void 0 : _a.tasksVisionFileSet) != null ? _b : `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${dependencies["@mediapipe/tasks-vision"]}/wasm`
    );
    this.imageSegmenter = await vision.ImageSegmenter.createFromOptions(fileSet, {
      baseOptions: {
        modelAssetPath: (_d = (_c = this.options.assetPaths) == null ? void 0 : _c.modelAssetPath) != null ? _d : "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
        delegate: "GPU",
        ...this.options.segmenterOptions
      },
      canvas: this.canvas,
      runningMode: "VIDEO",
      outputCategoryMask: true,
      outputConfidenceMasks: false
    });
    if ((_e = this.options) == null ? void 0 : _e.imagePath) {
      await this.loadAndSetBackground(this.options.imagePath).catch(
        (err) => this.log.error("Error while loading processor background image: ", err)
      );
    }
    if (typeof this.options.blurRadius === "number") {
      (_f = this.gl) == null ? void 0 : _f.setBlurRadius(this.options.blurRadius);
    }
    (_h = this.gl) == null ? void 0 : _h.setBackgroundDisabled((_g = this.options.backgroundDisabled) != null ? _g : false);
  }
  async destroy(options) {
    var _a;
    await super.destroy();
    await ((_a = this.imageSegmenter) == null ? void 0 : _a.close());
    this.backgroundImageAndPath = null;
    if (!(options == null ? void 0 : options.willProcessorRestart)) {
      this.isFirstFrame = true;
    }
  }
  async loadAndSetBackground(path) {
    var _a, _b;
    if (!this.backgroundImageAndPath || ((_a = this.backgroundImageAndPath) == null ? void 0 : _a.path) !== path) {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.crossOrigin = "Anonymous";
        img.onload = () => resolve(img);
        img.onerror = (err) => reject(err);
        img.src = path;
      });
      const imageData = await createImageBitmap(img);
      this.backgroundImageAndPath = { imageData, path };
    }
    (_b = this.gl) == null ? void 0 : _b.setBackgroundImage(this.backgroundImageAndPath.imageData);
  }
  async transform(frame, controller) {
    var _a, _b, _c, _d;
    let enqueuedFrame = false;
    try {
      if (!(frame instanceof VideoFrame) || frame.codedWidth === 0 || frame.codedHeight === 0) {
        this.log.debug("empty frame detected, ignoring");
        return;
      }
      let skipProcessingFrame = (_b = (_a = this.isDisabled) != null ? _a : this.options.backgroundDisabled) != null ? _b : false;
      if (typeof this.options.blurRadius !== "number" && typeof this.options.imagePath !== "string") {
        skipProcessingFrame = true;
      }
      if (skipProcessingFrame) {
        controller.enqueue(frame);
        enqueuedFrame = true;
        return;
      }
      const frameTimeMs = Date.now();
      if (!this.canvas) {
        throw TypeError("Canvas needs to be initialized first");
      }
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      if (this.isFirstFrame) {
        controller.enqueue(frame.clone());
        if (this.inputVideo) {
          await new Promise((resolve) => {
            this.inputVideo.requestVideoFrameCallback((_now, e) => {
              const durationUntilFrameRenderedInMs = e.expectedDisplayTime - e.presentationTime;
              setTimeout(resolve, durationUntilFrameRenderedInMs);
            });
          });
        }
      }
      this.isFirstFrame = false;
      const filterStartTimeMs = performance.now();
      const segmentationPromise = new Promise((resolve, reject) => {
        var _a2;
        try {
          let segmentationStartTimeMs = performance.now();
          (_a2 = this.imageSegmenter) == null ? void 0 : _a2.segmentForVideo(frame, segmentationStartTimeMs, (result) => {
            this.segmentationTimeMs = performance.now() - segmentationStartTimeMs;
            this.segmentationResults = result;
            this.updateMask(result.categoryMask);
            result.close();
            resolve();
          });
        } catch (e) {
          reject(e);
        }
      });
      this.drawFrame(frame);
      if (this.canvas && this.canvas.width > 0 && this.canvas.height > 0) {
        const newFrame = new VideoFrame(this.canvas, {
          timestamp: frame.timestamp || frameTimeMs
        });
        controller.enqueue(newFrame);
        const filterTimeMs = performance.now() - filterStartTimeMs;
        const stats = {
          processingTimeMs: this.segmentationTimeMs + filterTimeMs,
          segmentationTimeMs: this.segmentationTimeMs,
          filterTimeMs
        };
        (_d = (_c = this.options).onFrameProcessed) == null ? void 0 : _d.call(_c, stats);
      } else {
        controller.enqueue(frame);
      }
      await segmentationPromise;
    } catch (e) {
      this.log.error("Error while processing frame: ", e);
    } finally {
      if (!enqueuedFrame) {
        frame.close();
      }
    }
  }
  async update(opts) {
    var _a, _b, _c, _d, _e;
    this.options = { ...this.options, ...opts };
    (_b = this.gl) == null ? void 0 : _b.setBlurRadius((_a = opts.blurRadius) != null ? _a : null);
    if (opts.imagePath) {
      await this.loadAndSetBackground(opts.imagePath);
    } else {
      (_c = this.gl) == null ? void 0 : _c.setBackgroundImage(null);
    }
    (_e = this.gl) == null ? void 0 : _e.setBackgroundDisabled((_d = opts.backgroundDisabled) != null ? _d : false);
  }
  async drawFrame(frame) {
    var _a;
    if (!this.gl)
      return;
    (_a = this.gl) == null ? void 0 : _a.renderFrame(frame);
  }
  async updateMask(mask) {
    var _a;
    if (!mask)
      return;
    (_a = this.gl) == null ? void 0 : _a.updateMask(mask.getAsWebGLTexture());
  }
};

// src/index.ts
var DEFAULT_BLUR_RADIUS = 10;
var supportsBackgroundProcessors = () => BackgroundProcessor.isSupported && ProcessorWrapper.isSupported;
var supportsModernBackgroundProcessors = () => BackgroundProcessor.isSupported && ProcessorWrapper.hasModernApiSupport;
var BackgroundProcessorWrapper = class extends ProcessorWrapper {
  get mode() {
    const options = this.transformer.options;
    if (options.backgroundDisabled) {
      return "disabled";
    }
    if (typeof options.imagePath === "string" && typeof options.blurRadius === "undefined") {
      return "virtual-background";
    }
    if (typeof options.imagePath === "undefined") {
      return "background-blur";
    }
    return "legacy";
  }
  async switchTo(options) {
    var _a;
    switch (options.mode) {
      case "background-blur":
        await this.updateTransformerOptions({
          imagePath: void 0,
          blurRadius: (_a = options.blurRadius) != null ? _a : DEFAULT_BLUR_RADIUS,
          backgroundDisabled: false
        });
        break;
      case "virtual-background":
        await this.updateTransformerOptions({
          imagePath: options.imagePath,
          blurRadius: void 0,
          backgroundDisabled: false
        });
        break;
      case "disabled":
        await this.updateTransformerOptions({ imagePath: void 0, backgroundDisabled: true });
        break;
    }
  }
};
var BackgroundProcessor2 = (options, name = "background-processor") => {
  const isTransformerSupported = BackgroundProcessor.isSupported;
  const isProcessorSupported = ProcessorWrapper.isSupported;
  if (!isTransformerSupported) {
    throw new Error("Background transformer is not supported in this browser");
  }
  if (!isProcessorSupported) {
    throw new Error(
      "Neither MediaStreamTrackProcessor nor canvas.captureStream() fallback is supported in this browser"
    );
  }
  let transformer, processorOpts;
  switch (options.mode) {
    case "background-blur": {
      const {
        // eslint-disable-next-line no-unused-vars
        mode,
        blurRadius = DEFAULT_BLUR_RADIUS,
        segmenterOptions,
        assetPaths,
        onFrameProcessed,
        ...rest
      } = options;
      processorOpts = rest;
      transformer = new BackgroundProcessor({
        blurRadius,
        segmenterOptions,
        assetPaths,
        onFrameProcessed
      });
      break;
    }
    case "virtual-background": {
      const {
        // eslint-disable-next-line no-unused-vars
        mode,
        imagePath,
        segmenterOptions,
        assetPaths,
        onFrameProcessed,
        ...rest
      } = options;
      processorOpts = rest;
      transformer = new BackgroundProcessor({
        imagePath,
        segmenterOptions,
        assetPaths,
        onFrameProcessed
      });
      break;
    }
    case "disabled": {
      const {
        segmenterOptions,
        assetPaths,
        onFrameProcessed,
        ...rest
      } = options;
      processorOpts = rest;
      transformer = new BackgroundProcessor({
        segmenterOptions,
        assetPaths,
        onFrameProcessed
      });
      break;
    }
    default: {
      const {
        blurRadius,
        imagePath,
        segmenterOptions,
        assetPaths,
        onFrameProcessed,
        ...rest
      } = options;
      processorOpts = rest;
      transformer = new BackgroundProcessor({
        blurRadius,
        imagePath,
        segmenterOptions,
        assetPaths,
        onFrameProcessed
      });
      break;
    }
  }
  const processor = new BackgroundProcessorWrapper(transformer, name, processorOpts);
  return processor;
};
var BackgroundBlur = (blurRadius = DEFAULT_BLUR_RADIUS, segmenterOptions, onFrameProcessed, processorOptions) => {
  return BackgroundProcessor2(
    {
      blurRadius,
      segmenterOptions,
      onFrameProcessed,
      ...processorOptions
    },
    "background-blur"
  );
};
var VirtualBackground = (imagePath, segmenterOptions, onFrameProcessed, processorOptions) => {
  return BackgroundProcessor2(
    {
      imagePath,
      segmenterOptions,
      onFrameProcessed,
      ...processorOptions
    },
    "virtual-background"
  );
};
export {
  BackgroundBlur,
  BackgroundProcessor2 as BackgroundProcessor,
  BackgroundProcessorWrapper,
  BackgroundProcessor as BackgroundTransformer,
  LogLevel,
  LoggerNames,
  ProcessorWrapper,
  VideoTransformer,
  VirtualBackground,
  getLogger,
  setLogExtension,
  setLogLevel,
  supportsBackgroundProcessors,
  supportsModernBackgroundProcessors
};
//# sourceMappingURL=index.mjs.map
