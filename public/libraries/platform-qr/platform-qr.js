/* public/libraries/platform-qr/platform-qr.js
 * QR codes made in the browser, with no network request: the text never leaves the page.
 *
 * The encoder is the self-contained one the document widgets use (doc-widgets/firstmate-doc-widgets.js: byte mode,
 * error correction level M, versions 1-10, best of the 8 masks by the standard penalty rules, Reed-Solomon over
 * GF(256)); it holds about 213 bytes. This file adds drawing to a canvas and a PNG.
 *
 *   PlatformQR.encode(text)            -> { size, modules, version, mask }, or null when the text is too long
 *   PlatformQR.svg(text, options)      -> SVG markup
 *   PlatformQR.canvas(text, options)   -> <canvas>, options { size, quiet, color, background }
 *   PlatformQR.pngBlob(text, options)  -> Promise<Blob|null> (image/png)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PlatformQR = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const QR = (function () {
    // GF(256) log/antilog tables.
    const EXP = new Array(512);
    const LOG = new Array(256);
    (function () {
      let x = 1;
      for (let i = 0; i < 255; i += 1) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
      for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
    })();

    function gmul(a, b) {
      if (a === 0 || b === 0) return 0;
      return EXP[LOG[a] + LOG[b]];
    }

    // Product (x - a^0)(x - a^1)...(x - a^(degree-1)), leading coefficient dropped.
    function rsDivisor(degree) {
      const result = [];
      for (let i = 0; i < degree - 1; i += 1) result.push(0);
      result.push(1);
      let rootPow = 1;
      for (let i = 0; i < degree; i += 1) {
        for (let j = 0; j < result.length; j += 1) {
          result[j] = gmul(result[j], rootPow);
          if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        rootPow = gmul(rootPow, 0x02);
      }
      return result;
    }

    // Polynomial remainder of data * x^degree divided by the generator.
    function rsRemainder(data, divisor) {
      const result = divisor.map(() => 0);
      for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        for (let i = 0; i < divisor.length; i += 1) result[i] ^= gmul(divisor[i], factor);
      }
      return result;
    }

    // EC level M block structure per version: [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]
    const EC_M = {
      1: [10, [[1, 16]]],
      2: [16, [[1, 28]]],
      3: [26, [[1, 44]]],
      4: [18, [[2, 32]]],
      5: [24, [[2, 43]]],
      6: [16, [[4, 27]]],
      7: [18, [[4, 31]]],
      8: [22, [[2, 38], [2, 39]]],
      9: [22, [[3, 36], [2, 37]]],
      10: [26, [[4, 43], [1, 44]]]
    };

    const ALIGNMENT = {
      1: [],
      2: [6, 18],
      3: [6, 22],
      4: [6, 26],
      5: [6, 30],
      6: [6, 34],
      7: [6, 22, 38],
      8: [6, 24, 42],
      9: [6, 26, 46],
      10: [6, 28, 50]
    };

    function dataCodewords(version) {
      const spec = EC_M[version];
      let total = 0;
      for (const [count, per] of spec[1]) total += count * per;
      return total;
    }

    function byteCapacity(version) {
      // Header: 4-bit mode + character count (8 bits for v1-9, 16 bits for v10).
      return dataCodewords(version) - (version <= 9 ? 2 : 3);
    }

    function utf8Bytes(text) {
      const out = [];
      for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
      return out;
    }

    function pickVersion(byteLength) {
      for (let v = 1; v <= 10; v += 1) {
        if (byteLength <= byteCapacity(v)) return v;
      }
      return null;
    }

    /** Build the final interleaved codeword stream (data + ECC). */
    function buildCodewords(bytes, version) {
      const capacityBits = dataCodewords(version) * 8;
      const bits = [];
      const push = (value, count) => {
        for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
      };
      push(0b0100, 4); // byte mode
      push(bytes.length, version <= 9 ? 8 : 16);
      for (const b of bytes) push(b, 8);
      // Terminator + pad to byte boundary + alternating pad codewords.
      push(0, Math.min(4, capacityBits - bits.length));
      while (bits.length % 8 !== 0) bits.push(0);
      const padBytes = [0xec, 0x11];
      let padIndex = 0;
      while (bits.length < capacityBits) {
        push(padBytes[padIndex % 2], 8);
        padIndex += 1;
      }
      const data = [];
      for (let i = 0; i < bits.length; i += 8) {
        let value = 0;
        for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
        data.push(value);
      }

      // Split into blocks, compute ECC, interleave.
      const [ecPerBlock, groups] = EC_M[version];
      const divisor = rsDivisor(ecPerBlock);
      const blocks = [];
      let offset = 0;
      for (const [count, per] of groups) {
        for (let b = 0; b < count; b += 1) {
          const blockData = data.slice(offset, offset + per);
          offset += per;
          blocks.push({ data: blockData, ecc: rsRemainder(blockData, divisor) });
        }
      }
      const out = [];
      const maxData = Math.max(...blocks.map((b) => b.data.length));
      for (let i = 0; i < maxData; i += 1) {
        for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
      }
      for (let i = 0; i < ecPerBlock; i += 1) {
        for (const block of blocks) out.push(block.ecc[i]);
      }
      return { codewords: out, blocks, ecPerBlock };
    }

    /** BCH(15,5) format bits for a (ecBits, mask) pair. EC level M => ecBits 0b00. */
    function formatBits(ecBits, mask) {
      const data = (ecBits << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      return ((data << 10) | rem) ^ 0x5412;
    }

    /** BCH(18,6) version information bits (only versions >= 7 carry them). */
    function versionBits(version) {
      let rem = version;
      for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      return (version << 12) | rem;
    }

    const EC_BITS_M = 0b00;

    /** Mask condition for pattern 0-7 at module (x, y): invert when true. */
    function maskAt(mask, x, y) {
      switch (mask) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
        case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
        case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        default: return false;
      }
    }

    // Finder-like sequences for penalty rule N3 (1011101 flanked by 0000).
    const N3_A = [true, false, true, true, true, false, true, false, false, false, false];
    const N3_B = [false, false, false, false, true, false, true, true, true, false, true];

    function lineHasPatternAt(line, at, pattern) {
      for (let i = 0; i < pattern.length; i += 1) {
        if (line[at + i] !== pattern[i]) return false;
      }
      return true;
    }

    /** Standard mask penalty score (rules N1-N4). Lower is better. */
    function penaltyScore(modules, size) {
      let score = 0;
      // N1: runs of >= 5 same-color modules in rows and columns.
      for (let pass = 0; pass < 2; pass += 1) {
        for (let a = 0; a < size; a += 1) {
          let runColor = pass === 0 ? modules[a][0] : modules[0][a];
          let runLen = 1;
          for (let b = 1; b < size; b += 1) {
            const color = pass === 0 ? modules[a][b] : modules[b][a];
            if (color === runColor) {
              runLen += 1;
            } else {
              if (runLen >= 5) score += 3 + (runLen - 5);
              runColor = color;
              runLen = 1;
            }
          }
          if (runLen >= 5) score += 3 + (runLen - 5);
        }
      }
      // N2: 2x2 blocks of one color.
      for (let y = 0; y < size - 1; y += 1) {
        for (let x = 0; x < size - 1; x += 1) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
        }
      }
      // N3: finder-like patterns in rows and columns.
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x <= size - 11; x += 1) {
          if (lineHasPatternAt(modules[y], x, N3_A) || lineHasPatternAt(modules[y], x, N3_B)) score += 40;
        }
      }
      const column = new Array(size);
      for (let x = 0; x < size; x += 1) {
        for (let y = 0; y < size; y += 1) column[y] = modules[y][x];
        for (let y = 0; y <= size - 11; y += 1) {
          if (lineHasPatternAt(column, y, N3_A) || lineHasPatternAt(column, y, N3_B)) score += 40;
        }
      }
      // N4: dark proportion deviation from 50% in 5% steps.
      let dark = 0;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) if (modules[y][x]) dark += 1;
      }
      score += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
      return score;
    }

    /** Encode text -> { version, size, modules, isFunction, codewords }. Returns null when too long. */
    function encode(text) {
      const bytes = utf8Bytes(text);
      const version = pickVersion(bytes.length);
      if (!version) return null;
      const size = 17 + version * 4;
      const modules = [];
      const isFunction = [];
      for (let y = 0; y < size; y += 1) {
        modules.push(new Array(size).fill(false));
        isFunction.push(new Array(size).fill(false));
      }
      const set = (x, y, dark) => {
        modules[y][x] = !!dark;
        isFunction[y][x] = true;
      };
      const getBit = (value, i) => ((value >>> i) & 1) !== 0;

      // Timing patterns.
      for (let i = 0; i < size; i += 1) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
      }
      // Finder patterns + separators (3x, clamped 9x9 stamps).
      const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy += 1) {
          for (let dx = -4; dx <= 4; dx += 1) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            const x = cx + dx;
            const y = cy + dy;
            if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
          }
        }
      };
      finder(3, 3);
      finder(size - 4, 3);
      finder(3, size - 4);
      // Alignment patterns (skip the three finder corners).
      const positions = ALIGNMENT[version];
      for (let i = 0; i < positions.length; i += 1) {
        for (let j = 0; j < positions.length; j += 1) {
          const cx = positions[i];
          const cy = positions[j];
          const inFinder = (cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8);
          if (inFinder) continue;
          for (let dy = -2; dy <= 2; dy += 1) {
            for (let dx = -2; dx <= 2; dx += 1) {
              set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
          }
        }
      }
      // Format information. Drawn with mask 0 first to reserve the modules;
      // redrawn for each candidate mask during selection below.
      const drawFormat = (mask) => {
        const fmt = formatBits(EC_BITS_M, mask);
        for (let i = 0; i <= 5; i += 1) set(8, i, getBit(fmt, i));
        set(8, 7, getBit(fmt, 6));
        set(8, 8, getBit(fmt, 7));
        set(7, 8, getBit(fmt, 8));
        for (let i = 9; i < 15; i += 1) set(14 - i, 8, getBit(fmt, i));
        for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, getBit(fmt, i));
        for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, getBit(fmt, i));
        set(8, size - 8, true); // dark module
      };
      drawFormat(0);
      // Version information for versions 7+.
      if (version >= 7) {
        const vbits = versionBits(version);
        for (let i = 0; i < 18; i += 1) {
          const bit = getBit(vbits, i);
          const a = size - 11 + (i % 3);
          const b = Math.floor(i / 3);
          set(a, b, bit);
          set(b, a, bit);
        }
      }

      // Codeword placement: zigzag upward/downward in 2-module columns.
      const built = buildCodewords(bytes, version);
      const cw = built.codewords;
      let bitIndex = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert += 1) {
          for (let j = 0; j < 2; j += 1) {
            const x = right - j;
            const upward = ((right + 1) & 2) === 0;
            const y = upward ? size - 1 - vert : vert;
            if (!isFunction[y][x] && bitIndex < cw.length * 8) {
              modules[y][x] = getBit(cw[bitIndex >> 3], 7 - (bitIndex & 7));
              bitIndex += 1;
            }
          }
        }
      }
      // Evaluate all 8 masks over data modules and keep the lowest penalty.
      const applyMask = (mask) => {
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            if (!isFunction[y][x] && maskAt(mask, x, y)) modules[y][x] = !modules[y][x];
          }
        }
      };
      let bestMask = 0;
      let bestScore = Infinity;
      for (let mask = 0; mask < 8; mask += 1) {
        applyMask(mask);
        drawFormat(mask);
        const score = penaltyScore(modules, size);
        if (score < bestScore) {
          bestScore = score;
          bestMask = mask;
        }
        applyMask(mask); // XOR toggle undoes the candidate mask
      }
      applyMask(bestMask);
      drawFormat(bestMask);
      return { version, size, modules, isFunction, mask: bestMask, codewords: cw, blocks: built.blocks, ecPerBlock: built.ecPerBlock };
    }

    /** Render an encoded matrix as an SVG string (quiet zone included). */
    function svg(text, options) {
      const opts = options || {};
      const encoded = encode(text);
      if (!encoded) return null;
      const quiet = opts.quiet === undefined ? 4 : Math.max(0, Number(opts.quiet) || 0);
      const dim = encoded.size + quiet * 2;
      let path = "";
      for (let y = 0; y < encoded.size; y += 1) {
        for (let x = 0; x < encoded.size; x += 1) {
          if (encoded.modules[y][x]) path += "M" + (x + quiet) + " " + (y + quiet) + "h1v1h-1z";
        }
      }
      const fg = opts.color || "#111111";
      const bg = opts.background === undefined ? "#ffffff" : opts.background;
      return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
        (bg ? '<rect width="' + dim + '" height="' + dim + '" fill="' + bg + '"/>' : "") +
        '<path d="' + path + '" fill="' + fg + '"/></svg>'
      );
    }

    return {
      encode,
      svg,
      formatBits,
      versionBits,
      byteCapacity,
      dataCodewords,
      utf8Bytes,
      gf: { EXP, LOG, gmul, rsDivisor, rsRemainder },
      maskAt,
      EC_BITS_M
    };
  })();

  function encode(text) {
    const encoded = QR.encode(text);
    if (!encoded) return null;
    return { size: encoded.size, modules: encoded.modules, version: encoded.version, mask: encoded.mask };
  }

  /** Draw the code on a canvas: whole pixels per module, a quiet zone of `quiet` modules, about `size` pixels wide. */
  function canvas(text, options) {
    const opts = options || {};
    const encoded = encode(text);
    if (!encoded || typeof document === "undefined") return null;
    const quiet = opts.quiet === undefined ? 4 : Math.max(0, Number(opts.quiet) || 0);
    const modulesWide = encoded.size + quiet * 2;
    const scale = Math.max(1, Math.floor((Number(opts.size) || 640) / modulesWide));
    const dim = modulesWide * scale;
    const element = document.createElement("canvas");
    element.width = dim;
    element.height = dim;
    const context = element.getContext("2d");
    if (!context) return null;
    context.fillStyle = opts.background || "#ffffff";
    context.fillRect(0, 0, dim, dim);
    context.fillStyle = opts.color || "#111111";
    for (let y = 0; y < encoded.size; y += 1) {
      for (let x = 0; x < encoded.size; x += 1) {
        if (encoded.modules[y][x]) context.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
    return element;
  }

  function pngBlob(text, options) {
    const element = canvas(text, options);
    if (!element) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (typeof element.toBlob === "function") element.toBlob((blob) => resolve(blob || null), "image/png");
      else resolve(null);
    });
  }

  return { encode, svg: QR.svg, canvas, pngBlob };
});
