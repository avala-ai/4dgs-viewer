/**
 * The viewer page itself, in a real browser, against the built site.
 *
 * Everything here is a claim that cannot be checked in Node: what is drawn on the canvas,
 * what the transport does, what happens to a page whose browser has no WebGL2, and what the
 * device's texture limit does to a large scene. The site under test is `website/build`, so
 * these run against the bundle that ships, minifier and all.
 *
 * Requires a built site and a Chrome. Both are hard failures rather than skips under CI.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";

import { findChrome, launchChrome, requireBuiltSite, serveSite } from "./support/browser.mjs";

const chromePath = findChrome();
const available = chromePath !== null;
if (available) requireBuiltSite();

const VALID = "TenWindows-UseChunkIndex-UseCrc.4dgs";
const MULTI_CHUNK = "TenWindows-UseChunkIndex-UseChunks-UseCrc.4dgs";
const INVALID = "invalid/UnknownTemporalModel.4dgs";
const ONE = "OneGaussian-UseChunkIndex-UseCrc.4dgs";

/** Read the page's whole visible state in one round trip. */
function readState() {
  const rows = {};
  for (const dt of document.querySelectorAll("dt")) {
    rows[dt.textContent] = dt.nextElementSibling ? dt.nextElementSibling.textContent : "";
  }
  const buttons = [...document.querySelectorAll("button")];
  const play = buttons.find((b) => b.textContent === "Play" || b.textContent === "Pause");
  const scrub = document.querySelector('input[type="range"]');
  return {
    rows,
    notes: [...document.querySelectorAll("li")].map((li) => li.textContent),
    refusalTitle: document.querySelector("h3") ? document.querySelector("h3").textContent : null,
    refusalBody: document.querySelector("pre") ? document.querySelector("pre").textContent : null,
    sources: [...document.querySelectorAll("p")].map((p) => p.textContent),
    playLabel: play ? play.textContent : null,
    playDisabled: play ? play.disabled : null,
    scrubDisabled: scrub ? scrub.disabled : null,
    scrubValue: scrub ? Number(scrub.value) : null,
    fileDisabled: document.querySelector('input[type="file"]').disabled,
    clock: [...document.querySelectorAll("span")]
      .map((s) => s.textContent)
      .find((text) => / s$/.test(text)),
  };
}

/** Hand the page a corpus file through its own file input, fetched in-page. */
function pickFile(url) {
  return fetch(url)
    .then((response) => response.arrayBuffer())
    .then((bytes) => {
      const file = new File([bytes], url.split("/").pop(), { type: "application/octet-stream" });
      const input = document.querySelector('input[type="file"]');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.value;
    });
}

/** Fill the URL input the way a visitor does and submit it. */
function openUrl(url) {
  const input = document.querySelector('input[type="url"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, url);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent === "Open URL")
    .click();
  return true;
}

/** How much of the canvas is not the clear colour: zero means nothing is drawn. */
function countDrawnPixels() {
  const canvas = document.querySelector("canvas");
  const gl = canvas.getContext("webgl2");
  const w = canvas.width;
  const h = canvas.height;
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let hash = 0;
  let drawn = 0;
  for (let i = 0; i < w * h; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    if (Math.abs(r - pixels[0]) > 2 || Math.abs(g - pixels[1]) > 2 || Math.abs(b - pixels[2]) > 2) {
      drawn++;
      hash = (hash * 31 + i * 7 + r * 3 + g * 5 + b) % 2147483647;
    }
  }
  return { drawn, total: w * h, hash };
}

/**
 * `preserveDrawingBuffer`, so `readPixels` can see what was composited.
 *
 * The page deliberately does not ask for it — it costs a copy per frame — so a test that
 * wants to look at the picture has to ask on its behalf.
 */
const PRESERVE_BUFFER = `
  (() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, attributes) {
      if (kind === "webgl2") {
        return real.call(this, kind, Object.assign({}, attributes || {}, {
          preserveDrawingBuffer: true,
        }));
      }
      return real.call(this, kind, attributes);
    };
  })();
`;

/** Make the device's WebGL2 texture limit whatever a test needs it to be. */
const forceTextureLimit = (limit) => `
  (() => {
    const real = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (name) {
      if (name === this.MAX_TEXTURE_SIZE) return ${limit};
      return real.call(this, name);
    };
  })();
`;

/** Make `count` requested texture images report WebGL OUT_OF_MEMORY, then recover. */
const failTextureAllocationCalls = (count) => `
  (() => {
    const realImage = WebGL2RenderingContext.prototype.texImage2D;
    const realError = WebGL2RenderingContext.prototype.getError;
    globalThis.__viewerTextureFailuresLeft = ${count};
    globalThis.__viewerTextureAllocations = [];
    let error = 0;
    WebGL2RenderingContext.prototype.texImage2D = function (...args) {
      globalThis.__viewerTextureAllocations.push({
        width: args[3],
        height: args[4],
        format: args[2],
      });
      if (globalThis.__viewerTextureFailuresLeft > 0) {
        globalThis.__viewerTextureFailuresLeft -= 1;
        error = this.OUT_OF_MEMORY;
        return;
      }
      return realImage.apply(this, args);
    };
    WebGL2RenderingContext.prototype.getError = function () {
      if (error !== 0) {
        const result = error;
        error = 0;
        return result;
      }
      return realError.call(this);
    };
  })();
`;

/** Advertise a small viewport ceiling and record any call that violates it. */
const forceViewportLimit = (width, height) => `
  (() => {
    const realParameter = WebGL2RenderingContext.prototype.getParameter;
    const realViewport = WebGL2RenderingContext.prototype.viewport;
    globalThis.__viewerViewportOverflow = false;
    globalThis.__viewerViewports = [];
    WebGL2RenderingContext.prototype.getParameter = function (name) {
      if (name === this.MAX_VIEWPORT_DIMS) return new Int32Array([${width}, ${height}]);
      return realParameter.call(this, name);
    };
    WebGL2RenderingContext.prototype.viewport = function (x, y, w, h) {
      globalThis.__viewerViewports.push([x, y, w, h]);
      if (w > ${width} || h > ${height}) globalThis.__viewerViewportOverflow = true;
      return realViewport.call(this, x, y, w, h);
    };
  })();
`;

/** Hold one local-file slice until the test rejects it. */
const CONTROL_BLOB_READ = `
  (() => {
    const real = Blob.prototype.arrayBuffer;
    globalThis.__holdViewerBlobRead = false;
    globalThis.__viewerBlobReadHeld = 0;
    globalThis.__rejectViewerBlobRead = null;
    Blob.prototype.arrayBuffer = function () {
      if (!globalThis.__holdViewerBlobRead) return real.call(this);
      globalThis.__holdViewerBlobRead = false;
      globalThis.__viewerBlobReadHeld += 1;
      return new Promise((resolve, reject) => {
        globalThis.__rejectViewerBlobRead = () => {
          globalThis.__rejectViewerBlobRead = null;
          reject(new Error("the held local-file read failed for the test"));
        };
      });
    };
  })();
`;

/** Let context loss happen but keep the renderer unavailable until the page closes. */
const KEEP_CONTEXT_LOST = `
  (() => {
    const real = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function (name) {
      const extension = real.call(this, name);
      if (name !== "WEBGL_lose_context" || extension === null) return extension;
      return {
        loseContext: () => extension.loseContext(),
        restoreContext: () => {},
      };
    };
  })();
`;

/** Make URL metadata discovery wait until its AbortSignal is cancelled. */
const HANG_REMOTE_SIZE = `
  (() => {
    const real = globalThis.fetch.bind(globalThis);
    globalThis.__viewerSizeAborts = 0;
    globalThis.fetch = function (input, init = {}) {
      if (init.method !== "HEAD") return real(input, init);
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          globalThis.__viewerSizeAborts += 1;
          reject(init.signal.reason);
        }, { once: true });
      });
    };
  })();
`;

/** Let a test turn otherwise valid URL range reads into transport failures. */
const FAIL_RANGES_ON_DEMAND = `
  (() => {
    const real = globalThis.fetch.bind(globalThis);
    globalThis.__failViewerRanges = false;
    globalThis.fetch = function (input, init) {
      const range = new Headers(init && init.headers).get("range");
      if (globalThis.__failViewerRanges && range !== null) {
        return Promise.resolve(new Response("test range failure", { status: 503 }));
      }
      return real(input, init);
    };
  })();
`;

/** Let a test hold or permanently strand exactly one URL range read. */
const CONTROL_NEXT_RANGE = `
  (() => {
    const real = globalThis.fetch.bind(globalThis);
    globalThis.__nextViewerRange = "pass";
    globalThis.__viewerRangeHeld = 0;
    globalThis.__viewerRangeHung = 0;
    globalThis.__hangAllViewerRanges = false;
    globalThis.__releaseViewerRange = null;
    globalThis.fetch = function (input, init) {
      const range = new Headers(init && init.headers).get("range");
      const mode = globalThis.__nextViewerRange;
      if (range === null) return real(input, init);
      if (globalThis.__hangAllViewerRanges) {
        globalThis.__viewerRangeHung += 1;
        return new Promise(() => {});
      }
      if (mode === "pass") return real(input, init);
      globalThis.__nextViewerRange = "pass";
      if (mode === "hang") {
        globalThis.__viewerRangeHung += 1;
        return new Promise(() => {});
      }
      if (mode === "hold") {
        globalThis.__viewerRangeHeld += 1;
        return new Promise((resolve, reject) => {
          globalThis.__releaseViewerRange = () => {
            globalThis.__releaseViewerRange = null;
            real(input, init).then(resolve, reject);
          };
        });
      }
      return real(input, init);
    };
  })();
`;

/** Observe frame publication and let a replay advance without waiting scene-time seconds. */
const TRACK_UPLOADS_AND_FAST_CLOCK = `
  (() => {
    const realUpload = WebGL2RenderingContext.prototype.texSubImage2D;
    globalThis.__viewerFrameUploads = 0;
    WebGL2RenderingContext.prototype.texSubImage2D = function (...args) {
      globalThis.__viewerFrameUploads += 1;
      return realUpload.apply(this, args);
    };

    const realAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis);
    let syntheticNow = performance.now();
    globalThis.__fastViewerClock = false;
    globalThis.requestAnimationFrame = function (callback) {
      return realAnimationFrame((now) => {
        if (globalThis.__fastViewerClock) {
          syntheticNow = Math.max(syntheticNow, now) + 250;
          callback(syntheticNow);
        } else {
          syntheticNow = now;
          callback(now);
        }
      });
    };
  })();
`;

/** Keep the production bound visible in the error while making the browser test immediate. */
const SHORTEN_FRAME_TIMEOUT = `
  (() => {
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    globalThis.__shortenViewerFrameTimeout = false;
    globalThis.setTimeout = function (callback, delay, ...args) {
      return realSetTimeout(
        callback,
        globalThis.__shortenViewerFrameTimeout && delay === 15000 ? 75 : delay,
        ...args,
      );
    };
  })();
`;

/** Seek to a fraction of the file's duration through the viewer's real control. */
function seekFraction(fraction) {
  const scrub = document.querySelector('input[type="range"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(scrub, String(Number(scrub.max) * fraction));
  scrub.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** Lose WebGL2 and retain the extension's restore operation for the test. */
function loseContext() {
  const gl = document.querySelector("canvas").getContext("webgl2");
  const extension = gl.getExtension("WEBGL_lose_context");
  if (extension === null) throw new Error("WEBGL_lose_context is unavailable");
  window.__restoreWebglForTest = () => extension.restoreContext();
  extension.loseContext();
  return true;
}

describe("the viewer in a browser", { skip: available ? false : "no Chrome found" }, () => {
  let chrome;
  let site;

  before(async () => {
    site = await serveSite();
    chrome = await launchChrome(chromePath);
  });

  after(async () => {
    await chrome?.close();
    await site?.close();
  });

  /** A viewer page with the given scripts installed before anything runs. */
  async function viewer(...scripts) {
    const page = await chrome.newPage();
    for (const script of scripts) await page.onNewDocument(script);
    await page.goto(`${site.base}/`);
    return page;
  }

  const opened = () => {
    const live = [...document.querySelectorAll("dt")].find(
      (entry) => entry.textContent === "Live at this instant",
    );
    return (
      live !== undefined &&
      Number(live.nextElementSibling?.textContent.replace(/,/g, "")) > 0 &&
      [...document.querySelectorAll("button")].some((b) => b.textContent === "Play" && !b.disabled)
    );
  };
  const refused = () => document.querySelector("h3") !== null;

  it("kills Chrome and removes its profile when endpoint discovery times out", async () => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    let killedWith = null;
    let profile = null;
    child.kill = (signal) => {
      killedWith = signal;
      return true;
    };
    await assert.rejects(
      () =>
        launchChrome("unused", {
          endpointTimeoutMs: 10,
          spawnImpl(_executable, args) {
            profile = args
              .find((argument) => argument.startsWith("--user-data-dir="))
              .slice("--user-data-dir=".length);
            return child;
          },
        }),
      /did not report a port/,
    );
    assert.equal(killedWith, "SIGKILL");
    assert.equal(existsSync(profile), false, `temporary profile survived at ${profile}`);
  });

  it("kills Chrome and removes its profile when the DevTools socket stalls", async () => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    let killedWith = null;
    let profile = null;
    child.kill = (signal) => {
      killedWith = signal;
      return true;
    };
    class StalledSocket extends EventTarget {}
    await assert.rejects(
      () =>
        launchChrome("unused", {
          endpointTimeoutMs: 100,
          socketTimeoutMs: 10,
          WebSocketImpl: StalledSocket,
          spawnImpl(_executable, args) {
            profile = args
              .find((argument) => argument.startsWith("--user-data-dir="))
              .slice("--user-data-dir=".length);
            queueMicrotask(() => child.stderr.write("DevTools listening on ws://test/devtools\n"));
            return child;
          },
        }),
      /WebSocket did not connect in time/,
    );
    assert.equal(killedWith, "SIGKILL");
    assert.equal(existsSync(profile), false, `temporary profile survived at ${profile}`);
  });

  it("opens a corpus file and shows the file's own facts", async () => {
    const page = await viewer();
    await page.waitFor(
      () => {
        const input = document.querySelector('input[type="file"]');
        return input !== null && !input.disabled;
      },
      { what: "the renderer to survive browser startup" },
    );
    const pickerValue = await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    assert.equal(pickerValue, "", "the same path must be selectable again");
    await page.waitFor(opened, { what: "a scene with an enabled transport" });
    const state = await page.evaluate(readState);
    assert.equal(state.rows["Temporal model"], "gaussian-birth");
    assert.match(state.rows["Read path"], /^indexed/);
    assert.ok(Number(state.rows["Live at this instant"].replace(/,/g, "")) > 0);
    assert.equal(state.refusalTitle, null);
    await page.close();
  });

  it("prints the decoder's own refusal for an invalid file", async () => {
    const page = await viewer();
    await page.evaluate(pickFile, `${site.base}/corpus/${INVALID}`);
    await page.waitFor(refused, { what: "a refusal panel" });
    const state = await page.evaluate(readState);
    // The type survives minification, which is why it is recovered with `instanceof`.
    assert.equal(state.refusalTitle, "UnsupportedCodec");
    assert.match(state.refusalBody, /temporal model 'frame-sequence'/);
    assert.equal(state.playDisabled, true);
    await page.close();
  });

  it("keeps a WebGL2 failure across an attempt to open a file", async () => {
    const page = await viewer(`
      (() => {
        const real = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, attributes) {
          if (kind === "webgl2") return null;
          return real.call(this, kind, attributes);
        };
      })();
    `);
    await page.waitFor(refused, { what: "the WebGL2 refusal" });
    const before = await page.evaluate(readState);
    assert.match(before.refusalBody, /WebGL2/);
    assert.equal(before.fileDisabled, true);

    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = await page.evaluate(readState);
    assert.equal(after.refusalBody, before.refusalBody, "the capability failure must survive");
    assert.equal(after.fileDisabled, true);
    assert.equal(
      Object.keys(after.rows).length,
      0,
      "no scene may be accepted into a page with no render loop",
    );
    await page.close();
  });

  it("clears the canvas when a replacement file is refused", async () => {
    const page = await viewer(PRESERVE_BUFFER);
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(opened);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const drawn = await page.evaluate(countDrawnPixels);
    assert.ok(drawn.drawn > 0, "the first file must actually draw something");

    await page.evaluate(pickFile, `${site.base}/corpus/${INVALID}`);
    await page.waitFor(refused);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await page.evaluate(countDrawnPixels);
    assert.equal(after.drawn, 0, "the previous file's geometry must not survive the refusal");
    await page.close();
  });

  it("does not freeze a new file behind a read left in flight on the old one", async () => {
    const page = await viewer();
    await page.waitFor(() => document.querySelector('input[type="url"]') !== null, {
      what: "the URL control to mount",
    });
    await page.evaluate((href) => {
      const input = document.querySelector('input[type="url"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, href);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Open URL").click();
      return true;
    }, `${site.base}/slow/${VALID}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });

    // From here the origin answers nothing, and a seek into an unread chunk hangs forever.
    await fetch(`${site.base}/hangnow`);
    await page.evaluate(() => {
      const scrub = document.querySelector('input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(scrub, String(Number(scrub.max) * 0.6));
      scrub.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(
      () =>
        [...document.querySelectorAll("p")].some((p) =>
          p.textContent.includes("read in this page"),
        ) &&
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent === "Play" && !b.disabled,
        ),
      { what: "the local file, open and playable" },
    );
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Play").click();
      return true;
    });

    const seen = new Set();
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const state = await page.evaluate(readState);
      seen.add(state.rows["Live at this instant"]);
    }
    assert.ok(
      seen.size > 1,
      `the live count never changed (${[...seen].join(", ")}): the replacement is not being framed`,
    );
    await page.close();
  });

  it("cancels a remote size probe that never settles", async () => {
    const page = await viewer(HANG_REMOTE_SIZE, SHORTEN_FRAME_TIMEOUT);
    await page.evaluate(() => {
      globalThis.__shortenViewerFrameTimeout = true;
      return true;
    });
    await page.evaluate(openUrl, `${site.base}/range/${VALID}`);
    await page.waitFor(refused, { what: "the bounded remote-opening refusal" });
    const state = await page.evaluate(readState);
    assert.equal(state.refusalTitle, "ViewerLimitError");
    assert.match(state.refusalBody, /opening did not settle within 15 seconds/);
    assert.equal(await page.evaluate(() => globalThis.__viewerSizeAborts), 1);
    await page.close();
  });

  it("publishes replacement facts with its landing-frame readout", async () => {
    const page = await viewer();
    await page.evaluate(pickFile, `${site.base}/corpus/${MULTI_CHUNK}`);
    await page.waitFor(opened);
    await page.evaluate(seekFraction, 0.75);
    await page.waitFor(
      () => Number(document.querySelector('input[type="range"]')?.value) > 0,
      { what: "the first scene at a nonzero instant" },
    );
    // Stop the animation loop after its already queued callback. The replacement open
    // must initialize facts itself rather than depending on a later throttled tick.
    await page.evaluate(() => {
      globalThis.requestAnimationFrame = () => 0;
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.evaluate(pickFile, `${site.base}/corpus/${ONE}`);
    await page.waitFor(opened, { what: "the replacement one-gaussian scene" });
    const state = await page.evaluate(readState);
    assert.equal(state.rows["Gaussians in the file"], "1");
    assert.equal(state.rows["Live at this instant"], "1");
    assert.equal(state.scrubValue, 0);
    assert.equal(state.clock?.split(" / ")[0], "0.000");
    await page.close();
  });

  it("plays again when Play is pressed at the end of a scene", async () => {
    const page = await viewer();
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(opened);
    // Stop looping, seek to the last instant the timeline contains, and press Play.
    await page.evaluate(() => {
      const loop = document.querySelector('input[type="checkbox"]');
      if (loop.checked) loop.click();
      const scrub = document.querySelector('input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(scrub, scrub.max);
      scrub.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const atEnd = await page.evaluate(readState);
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Play").click();
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const playing = await page.evaluate(readState);
    assert.equal(playing.playLabel, "Pause", "Play at the end must start playing");
    assert.ok(
      playing.scrubValue < atEnd.scrubValue,
      `the clock did not restart: ${atEnd.clock} then ${playing.clock}`,
    );
    await page.close();
  });

  it("accumulates repeated keyboard-style scrubs before the readout catches up", async () => {
    const page = await viewer();
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(opened);

    // Freeze the animation loop after the scene has opened, leaving the throttled readout
    // deliberately stale. `stepUp` plus `change` is the range input's ArrowRight default
    // action and React event; yielding lets each controlled-value render complete.
    await page.evaluate(() => {
      globalThis.requestAnimationFrame = () => 0;
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const values = await page.evaluate(async () => {
      const scrub = document.querySelector('input[type="range"]');
      const seen = [];
      for (let i = 0; i < 4; i++) {
        scrub.stepUp();
        scrub.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        seen.push(Number(scrub.value));
      }
      return seen;
    });
    assert.ok(
      values.every((value, index) => index === 0 || value > values[index - 1]),
      `keyboard scrubs did not accumulate: ${values.join(", ")}`,
    );
    await page.close();
  });

  it("draws the same picture when the device forces a narrower texture", async () => {
    const wide = await viewer(PRESERVE_BUFFER);
    await wide.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await wide.waitFor(opened);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const reference = await wide.evaluate(countDrawnPixels);
    await wide.close();

    const narrow = await viewer(PRESERVE_BUFFER, forceTextureLimit(128));
    await narrow.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await narrow.waitFor(opened);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const limited = await narrow.evaluate(countDrawnPixels);
    assert.ok(reference.drawn > 0);
    assert.equal(limited.drawn, reference.drawn, "a narrower texture must not change the picture");
    assert.equal(limited.hash, reference.hash);
    await narrow.close();
  });

  it("refuses a scene past the device's texture limit, naming the count and the limit", async () => {
    // Two texels each way holds one gaussian; any real scene is past it.
    const page = await viewer(forceTextureLimit(2));
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(refused, { what: "the texture-limit refusal" });
    const state = await page.evaluate(readState);
    assert.equal(state.refusalTitle, "RendererCapabilityError");
    assert.match(state.refusalBody, /MAX_TEXTURE_SIZE of 2/);
    assert.match(state.refusalBody, /gaussians alive at one instant/);
    assert.match(state.refusalBody, /The file is fine/);
    await page.close();
  });

  it("retries a failed speculative texture growth at the requested capacity", async () => {
    const page = await viewer(failTextureAllocationCalls(1));
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(opened, { what: "the scene after exact-capacity retry" });
    const state = await page.evaluate(readState);
    const allocations = await page.evaluate(() => globalThis.__viewerTextureAllocations);
    assert.equal(state.refusalTitle, null);
    assert.equal(allocations.length, 4, "one failed pair must be followed by one retry pair");
    assert.ok(
      allocations[2].height < allocations[0].height,
      `retry did not shed speculative capacity: ${JSON.stringify(allocations)}`,
    );
    await page.close();
  });

  it("refuses a failed GPU texture allocation without committing its capacity", async () => {
    // Two images per attempt: fail both the speculative allocation and its exact retry.
    const page = await viewer(failTextureAllocationCalls(4));
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(refused, { what: "the texture-allocation refusal" });
    const failed = await page.evaluate(readState);
    assert.equal(failed.refusalTitle, "RendererCapabilityError");
    assert.match(failed.refusalBody, /OUT_OF_MEMORY/);
    assert.equal(failed.fileDisabled, false);
    assert.equal(failed.playDisabled, true);

    // The failed size was not committed. Selecting the same file retries both real
    // allocations and reaches a playable scene instead of skipping ensureCapacity.
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(opened, { what: "the scene after retrying texture allocation" });
    const retried = await page.evaluate(readState);
    assert.equal(retried.refusalTitle, null);
    await page.close();
  });

  it("keeps the drawing buffer and viewport within the device limit", async () => {
    const maximum = { width: 128, height: 64 };
    const page = await viewer(
      PRESERVE_BUFFER,
      forceViewportLimit(maximum.width, maximum.height),
    );
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(opened);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const result = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return {
        width: canvas.width,
        height: canvas.height,
        overflow: globalThis.__viewerViewportOverflow,
        calls: globalThis.__viewerViewports,
      };
    });
    const pixels = await page.evaluate(countDrawnPixels);
    assert.ok(result.width <= maximum.width, `${result.width} > ${maximum.width}`);
    assert.ok(result.height <= maximum.height, `${result.height} > ${maximum.height}`);
    assert.equal(result.overflow, false, JSON.stringify(result.calls));
    assert.ok(pixels.drawn > 0, "the bounded buffer must still draw the scene");
    await page.close();
  });

  it("owns the canvas wheel gesture instead of scrolling the document", async () => {
    const page = await viewer();
    await page.waitFor(
      () => {
        const event = new WheelEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true });
        document.querySelector("canvas")?.dispatchEvent(event);
        return event.defaultPrevented;
      },
      { what: "the non-passive canvas wheel listener" },
    );
    const prevented = await page.evaluate(() => {
      const event = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
      document.querySelector("canvas").dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(prevented, true);
    await page.close();
  });

  it("surfaces WebGL context loss and rebuilds after restoration", async () => {
    const page = await viewer();
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(opened);
    const canRestore = await page.evaluate(loseContext);
    assert.equal(canRestore, true);
    await page.waitFor(refused, { what: "the WebGL context-loss refusal" });
    const lost = await page.evaluate(readState);
    assert.equal(lost.refusalTitle, "ViewerCapabilityError");
    assert.match(lost.refusalBody, /WebGL2 context was lost/);
    assert.equal(lost.fileDisabled, true);
    assert.equal(lost.playDisabled, true);
    assert.equal(lost.scrubDisabled, true);

    await page.evaluate(() => window.__restoreWebglForTest());
    await page.waitFor(opened, { what: "the rebuilt renderer" });
    const after = await page.evaluate(readState);
    assert.equal(after.refusalTitle, null);
    assert.equal(after.playDisabled, false);
    await page.close();
  });

  it("keeps context loss visible when an in-flight open later refuses", async () => {
    const page = await viewer(CONTROL_BLOB_READ, KEEP_CONTEXT_LOST);
    await page.evaluate(() => {
      globalThis.__holdViewerBlobRead = true;
      return true;
    });
    await page.evaluate(pickFile, `${site.base}/corpus/${VALID}`);
    await page.waitFor(() => globalThis.__viewerBlobReadHeld === 1, {
      what: "the deliberately held local-file read",
    });
    await page.evaluate(loseContext);
    await page.waitFor(refused, { what: "the WebGL context-loss refusal" });
    const lost = await page.evaluate(readState);
    assert.equal(lost.refusalTitle, "ViewerCapabilityError");

    await page.evaluate(() => {
      globalThis.__rejectViewerBlobRead();
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterFileFailure = await page.evaluate(readState);
    assert.equal(afterFileFailure.refusalTitle, "ViewerCapabilityError");
    assert.match(afterFileFailure.refusalBody, /WebGL2 context was lost/);
    assert.doesNotMatch(afterFileFailure.refusalBody, /held local-file read failed/);
    assert.equal(afterFileFailure.fileDisabled, true);
    await page.close();
  });

  it("releases a never-settling frame read when WebGL is restored", async () => {
    const page = await viewer(CONTROL_NEXT_RANGE);
    await page.evaluate(openUrl, `${site.base}/range/${MULTI_CHUNK}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });

    // The first read of the 75% Chunk never settles. Context loss must invalidate both
    // its publication rights and its pending slot; restoration's independent read can
    // then recreate that instant on the new renderer.
    await page.evaluate(() => {
      globalThis.__nextViewerRange = "hang";
      return true;
    });
    await page.evaluate(seekFraction, 0.75);
    await page.waitFor(() => globalThis.__viewerRangeHung === 1, {
      what: "the intentionally stranded frame range",
    });
    await page.evaluate(loseContext);
    await page.waitFor(refused, { what: "the WebGL context-loss refusal" });
    await page.evaluate(() => window.__restoreWebglForTest());
    await page.waitFor(
      () => {
        const live = [...document.querySelectorAll("dt")].find(
          (entry) => entry.textContent === "Live at this instant",
        );
        return Number(live?.nextElementSibling?.textContent.replace(/,/g, "")) === 24;
      },
      { what: "the restored 75% frame" },
    );

    // A second seek has to pass the old promise that is still unresolved. Before the
    // generation guard, `pendingSerial` remained occupied forever and this stayed at 24.
    await page.evaluate(seekFraction, 0.25);
    await page.waitFor(
      () => {
        const live = [...document.querySelectorAll("dt")].find(
          (entry) => entry.textContent === "Live at this instant",
        );
        return Number(live?.nextElementSibling?.textContent.replace(/,/g, "")) === 19;
      },
      { what: "a later seek past the still-stranded read" },
    );
    await page.close();
  });

  it("releases a never-settling frame read when the visitor seeks again", async () => {
    const page = await viewer(CONTROL_NEXT_RANGE);
    await page.evaluate(openUrl, `${site.base}/range/${MULTI_CHUNK}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });

    await page.evaluate(() => {
      globalThis.__nextViewerRange = "hang";
      return true;
    });
    await page.evaluate(seekFraction, 0.75);
    await page.waitFor(() => globalThis.__viewerRangeHung === 1, {
      what: "the intentionally stranded frame range",
    });

    // No new file and no context loss changes the playback serial here. The explicit
    // second seek itself must revoke the old request and fetch its own Chunk.
    await page.evaluate(seekFraction, 0.25);
    await page.waitFor(
      () => {
        const live = [...document.querySelectorAll("dt")].find(
          (entry) => entry.textContent === "Live at this instant",
        );
        return Number(live?.nextElementSibling?.textContent.replace(/,/g, "")) === 19;
      },
      { what: "a second seek past the still-stranded read" },
    );
    await page.close();
  });

  it("coalesces a rapid scrub behind at most one superseded range", async () => {
    const page = await viewer(CONTROL_NEXT_RANGE);
    await page.evaluate(openUrl, `${site.base}/range/${MULTI_CHUNK}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });
    await page.evaluate(() => {
      globalThis.__hangAllViewerRanges = true;
      return true;
    });
    await page.evaluate(seekFraction, 0.75);
    await page.waitFor(() => globalThis.__viewerRangeHung === 1);
    await page.evaluate(seekFraction, 0.25);
    await page.waitFor(() => globalThis.__viewerRangeHung === 2);
    for (const fraction of [0.6, 0.1, 0.9, 0.4, 0.8, 0.2]) {
      await page.evaluate(seekFraction, fraction);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const hung = await page.evaluate(() => globalThis.__viewerRangeHung);
    assert.equal(hung, 2, "one active plus one superseded transport is the hard ceiling");
    await page.close();
  });

  it("releases a never-settling final frame when Play restarts the scene", async () => {
    const page = await viewer(CONTROL_NEXT_RANGE, TRACK_UPLOADS_AND_FAST_CLOCK);
    await page.evaluate(openUrl, `${site.base}/range/${MULTI_CHUNK}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });

    await page.evaluate(() => {
      globalThis.__nextViewerRange = "hang";
      return true;
    });
    await page.evaluate(seekFraction, 1);
    await page.waitFor(() => globalThis.__viewerRangeHung === 1, {
      what: "the intentionally stranded final-frame range",
    });

    await page.evaluate(() => {
      globalThis.__uploadsBeforeReplay = globalThis.__viewerFrameUploads;
      globalThis.__fastViewerClock = true;
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Play").click();
      return true;
    });
    await page.waitFor(
      () => globalThis.__viewerFrameUploads > globalThis.__uploadsBeforeReplay,
      { what: "a frame published after replay released the stranded final read" },
    );
    await page.close();
  });

  it("bounds a never-settling range started during ordinary playback", async () => {
    const page = await viewer(
      CONTROL_NEXT_RANGE,
      TRACK_UPLOADS_AND_FAST_CLOCK,
      SHORTEN_FRAME_TIMEOUT,
    );
    await page.evaluate(openUrl, `${site.base}/range/${MULTI_CHUNK}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });

    // The landing Chunk is cached. Advance rapidly until playback itself requests the
    // next Chunk, then prove that one stranded transport promise retires the playable
    // with a diagnosis instead of retaining the pending slot forever.
    await page.evaluate(() => {
      globalThis.__shortenViewerFrameTimeout = true;
      globalThis.__nextViewerRange = "hang";
      globalThis.__fastViewerClock = true;
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Play").click();
      return true;
    });
    await page.waitFor(() => globalThis.__viewerRangeHung === 1, {
      what: "the playback-driven range to become stranded",
    });
    await page.waitFor(
      () => document.querySelector("pre")?.textContent.includes("did not settle within 15 seconds"),
      { what: "the bounded frame-read refusal" },
    );
    const state = await page.evaluate(readState);
    assert.equal(state.refusalTitle, "ViewerLimitError");
    assert.equal(state.fileDisabled, false);
    assert.equal(state.playDisabled, true);
    assert.equal(state.scrubDisabled, true);
    await page.close();
  });

  it("keeps one stranded playback range authoritative instead of looping past it", async () => {
    const page = await viewer(CONTROL_NEXT_RANGE, TRACK_UPLOADS_AND_FAST_CLOCK);
    await page.evaluate(openUrl, `${site.base}/range/${MULTI_CHUNK}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });
    await page.evaluate(() => {
      globalThis.__hangAllViewerRanges = true;
      globalThis.__fastViewerClock = true;
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Play").click();
      return true;
    });
    await page.waitFor(() => globalThis.__viewerRangeHung === 1, {
      what: "the playback-driven range to become stranded",
    });
    // The synthetic clock can traverse this 20-second scene more than once in this
    // interval. It must buffer at the first missing frame instead of wrapping, revoking
    // that timeout, and starting another permanently hung transport promise each loop.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const hung = await page.evaluate(() => globalThis.__viewerRangeHung);
    assert.equal(hung, 1);
    await page.close();
  });

  it("holds playback time on the exact frame while its range read is pending", async () => {
    const page = await viewer(CONTROL_NEXT_RANGE, TRACK_UPLOADS_AND_FAST_CLOCK);
    await page.evaluate(openUrl, `${site.base}/range/${MULTI_CHUNK}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });
    await page.evaluate(() => {
      globalThis.__nextViewerRange = "hold";
      globalThis.__fastViewerClock = true;
      [...document.querySelectorAll("button")].find((button) => button.textContent === "Play").click();
      return true;
    });
    await page.waitFor(() => globalThis.__viewerRangeHeld === 1, {
      what: "ordinary playback waiting on a held range",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const before = await page.evaluate(readState);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const during = await page.evaluate(readState);
    assert.equal(during.scrubValue, before.scrubValue);
    assert.equal(during.clock, before.clock);

    await page.evaluate(() => {
      globalThis.__uploadsBeforeRelease = globalThis.__viewerFrameUploads;
      globalThis.__releaseViewerRange();
      return true;
    });
    await page.waitFor(
      () => globalThis.__viewerFrameUploads > globalThis.__uploadsBeforeRelease,
      { what: "the held instant to publish after its range settles" },
    );
    await page.close();
  });

  it("does not label a stale restoration frame with a newer seek", async () => {
    const page = await viewer(CONTROL_NEXT_RANGE);
    await page.evaluate(openUrl, `${site.base}/range/${MULTI_CHUNK}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });
    await page.evaluate(loseContext);
    await page.waitFor(refused, { what: "the WebGL context-loss refusal" });

    // Restoration captures 75% (24 live gaussians), then blocks in its real range read.
    // Seek to 25% (19 live) before releasing it. The 75% result is now stale: publishing
    // it while setting `rendered` to the newer playback time would suppress the real seek.
    await page.evaluate(() => {
      globalThis.__nextViewerRange = "hold";
      return true;
    });
    await page.evaluate(seekFraction, 0.75);
    await page.evaluate(() => window.__restoreWebglForTest());
    await page.waitFor(() => globalThis.__viewerRangeHeld === 1, {
      what: "restoration waiting on the 75% frame range",
    });
    await page.evaluate(seekFraction, 0.25);
    await page.evaluate(() => {
      globalThis.__releaseViewerRange();
      return true;
    });
    await page.waitFor(
      () => {
        const live = [...document.querySelectorAll("dt")].find(
          (entry) => entry.textContent === "Live at this instant",
        );
        return Number(live?.nextElementSibling?.textContent.replace(/,/g, "")) === 19;
      },
      { what: "the frame for the seek made during restoration" },
    );
    const state = await page.evaluate(readState);
    assert.equal(state.scrubValue, 5);
    assert.equal(state.rows["Live at this instant"], "19");
    await page.close();
  });

  it("keeps a decode failure during restoration separate from renderer capability", async () => {
    const page = await viewer(FAIL_RANGES_ON_DEMAND);
    await page.evaluate(openUrl, `${site.base}/range/${MULTI_CHUNK}`);
    await page.waitFor(opened, { what: "the URL-backed scene" });

    await page.evaluate(loseContext);
    await page.waitFor(refused, { what: "the WebGL context-loss refusal" });

    // While the context is lost no animation frame can start this seek. Restoration must
    // therefore be the operation that meets the failing, previously unread Chunk range.
    await page.evaluate(() => {
      window.__failViewerRanges = true;
      const scrub = document.querySelector('input[type="range"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(scrub, String(Number(scrub.max) * 0.75));
      scrub.dispatchEvent(new Event("change", { bubbles: true }));
      window.__restoreWebglForTest();
      return true;
    });
    await page.waitFor(
      () => {
        const title = document.querySelector("h3")?.textContent;
        const body = document.querySelector("pre")?.textContent;
        return title !== "ViewerCapabilityError" && body?.includes("503");
      },
      { what: "the range refusal after renderer restoration" },
    );

    const state = await page.evaluate(readState);
    assert.equal(state.refusalTitle, "Error");
    assert.match(state.refusalBody, /answered 503/);
    assert.equal(state.fileDisabled, false, "a file failure must not disable future opens");
    assert.equal(state.playDisabled, true, "the failed scene itself is retired");
    await page.close();
  });

  it("restores the prior file refusal after WebGL recovers", async () => {
    const page = await viewer();
    await page.evaluate(pickFile, `${site.base}/corpus/${INVALID}`);
    await page.waitFor(refused, { what: "the file refusal" });
    const before = await page.evaluate(readState);
    assert.equal(before.refusalTitle, "UnsupportedCodec");

    await page.evaluate(loseContext);
    await page.waitFor(
      () => document.querySelector("h3")?.textContent === "ViewerCapabilityError",
      { what: "the temporary WebGL refusal" },
    );
    await page.evaluate(() => window.__restoreWebglForTest());
    await page.waitFor(
      () => document.querySelector("h3")?.textContent === "UnsupportedCodec",
      { what: "the original file refusal after restoration" },
    );
    const after = await page.evaluate(readState);
    assert.equal(after.refusalBody, before.refusalBody);
    assert.equal(after.fileDisabled, false);
    assert.equal(after.playDisabled, true);
    await page.close();
  });
});
