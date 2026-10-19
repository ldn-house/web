import { type Point, treeFrame } from '../lib/tree';

/** Matches the stage's `bg-night`, so the canvas and the SVG under it agree. */
const NIGHT = [5 / 255, 7 / 255, 12 / 255] as const;

const VERTEX = `
attribute vec4 a_pos;
attribute vec3 a_col;
uniform vec2 u_turn;
uniform vec2 u_scale;
uniform float u_radius;
uniform float u_size;
varying vec3 v_col;
varying float v_lit;
void main() {
  if (a_pos.w < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float x = a_pos.x * u_turn.x - a_pos.z * u_turn.y;
  float z = a_pos.x * u_turn.y + a_pos.z * u_turn.x;
  float near = 0.6 + 0.4 * (z / u_radius + 1.0) * 0.5;
  // Raw effect output is linear PWM at full scale: encode for the screen and
  // leave headroom, since overlapping glows add up.
  vec3 c = pow(a_col, vec3(1.0 / 2.2));
  v_lit = step(0.02, max(c.r, max(c.g, c.b)));
  v_col = c * near * 0.7;
  gl_Position = vec4(x * u_scale.x, (a_pos.y - 0.5) * u_scale.y, 0.0, 1.0);
  gl_PointSize = u_size * (0.8 + 0.3 * near);
}`;

const FRAGMENT = `
precision mediump float;
varying vec3 v_col;
varying float v_lit;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 90.0);
  float halo = exp(-r2 * 9.0) * 0.4 + exp(-r2 * 3.0) * 0.08;
  float peak = max(v_col.r, max(v_col.g, v_col.b));
  vec3 lit = v_col * (core * 1.2 + halo) + vec3(core * 0.3 * peak);
  vec3 dark = vec3(0.09, 0.1, 0.12) * exp(-r2 * 140.0);
  gl_FragColor = vec4(mix(dark, lit, v_lit), 1.0);
}`;

export type TreePlayer = {
  /** Shows an effect from `start`, playing unless paused. */
  show(frames: Uint8Array, count: number, start?: number): void;
  setPaused(paused: boolean): void;
  /** Stops drawing while the panel is off screen. */
  setVisible(visible: boolean): void;
  turn(radians: number): void;
  destroy(): void;
};

export type PlayerOptions = {
  coords: readonly (Point | null)[];
  fps: number;
  /** Called each time the loop wraps back to its first frame. */
  onLoop?: () => void;
  onLost?: () => void;
  reducedMotion: () => boolean;
};

/** Frames ship gzipped; see scripts/fetch-tree-export.ts. */
export async function loadFrames(url: string, bytes: number): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  let data = new Uint8Array(await response.arrayBuffer());
  // A server that labels the file Content-Encoding: gzip has already inflated it.
  if (data[0] === 0x1f && data[1] === 0x8b) {
    const inflated = new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    data = new Uint8Array(await new Response(inflated).arrayBuffer());
  }
  if (data.length !== bytes)
    throw new Error(`${url}: ${data.length} bytes, expected ${bytes}`);
  return data;
}

/** The frame with the most light, for a still under reduced motion. */
export function brightestFrame(frames: Uint8Array, count: number): number {
  const size = frames.length / count;
  let best = 0;
  let bestSum = -1;
  for (let f = 0; f < count; f++) {
    let sum = 0;
    for (let i = f * size; i < (f + 1) * size; i++) sum += frames[i]!;
    if (sum > bestSum) {
      best = f;
      bestSum = sum;
    }
  }
  return best;
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

export function createTreePlayer(
  canvas: HTMLCanvasElement,
  surface: HTMLElement,
  options: PlayerOptions,
): TreePlayer | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
  if (!gl) return null;

  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const leds = options.coords.length;
  const frame = treeFrame(options.coords);
  const positions = new Float32Array(leds * 4);
  options.coords.forEach((c, i) => {
    if (c) positions.set([c[0], c[1], c[2], 1], i * 4);
  });
  const posBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 4, gl.FLOAT, false, 0, 0);

  const colBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, colBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, leds * 3, gl.DYNAMIC_DRAW);
  const aCol = gl.getAttribLocation(program, 'a_col');
  gl.enableVertexAttribArray(aCol);
  gl.vertexAttribPointer(aCol, 3, gl.UNSIGNED_BYTE, true, 0, 0);

  const uTurn = gl.getUniformLocation(program, 'u_turn');
  const uScale = gl.getUniformLocation(program, 'u_scale');
  const uSize = gl.getUniformLocation(program, 'u_size');
  gl.uniform1f(gl.getUniformLocation(program, 'u_radius'), frame.radius);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.clearColor(NIGHT[0], NIGHT[1], NIGHT[2], 1);

  let frames: Uint8Array | undefined;
  let count = 1;
  let position = 0;
  let shown = -1;
  let paused = false;
  let visible = false;
  let angle = 0;
  let spin = 0;
  let dirty = true;
  let raf = 0;
  let last = 0;

  const resize = () => {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    // Same fit as the SVG's default preserveAspectRatio (xMidYMid meet).
    const scale = Math.min(width / frame.width, height / frame.height);
    gl.uniform2f(uScale, (2 * scale) / width, (2 * scale) / height);
    gl.uniform1f(uSize, scale * 0.13);
    dirty = true;
    schedule();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const draw = (index: number) => {
    if (frames && index !== shown) {
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        frames.subarray(index * leds * 3, (index + 1) * leds * 3),
      );
      shown = index;
    }
    gl.uniform2f(uTurn, Math.cos(angle), Math.sin(angle));
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (frames) gl.drawArrays(gl.POINTS, 0, leds);
    dirty = false;
  };

  const tick = (now: number) => {
    raf = 0;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    if (frames && !paused) {
      position += dt * options.fps;
      if (position >= count) {
        position %= count;
        options.onLoop?.();
      }
    }
    if (spin) {
      angle += spin * dt;
      spin *= Math.exp(-dt * 4);
      if (Math.abs(spin) < 0.02) spin = 0;
      dirty = true;
    }
    const index = Math.floor(position) % count;
    if (dirty || index !== shown) draw(index);
    schedule();
  };

  function schedule() {
    const animating = frames && !paused;
    if (raf || !visible || !(animating || spin || dirty)) {
      if (!raf) last = 0;
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  // Dragging turns the tree about its trunk; a flick keeps it turning briefly.
  let dragging: { id: number; x: number; t: number } | undefined;
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    dragging = { id: event.pointerId, x: event.clientX, t: event.timeStamp };
    spin = 0;
    surface.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    const radians = ((event.clientX - dragging.x) / surface.clientWidth) * Math.PI * 1.5;
    const seconds = Math.max(0.008, (event.timeStamp - dragging.t) / 1000);
    angle += radians;
    spin = options.reducedMotion() ? 0 : radians / seconds;
    dragging.x = event.clientX;
    dragging.t = event.timeStamp;
    dirty = true;
    schedule();
  };
  const onUp = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== dragging.id) return;
    // A pause before release means the user meant to stop it there.
    if (event.timeStamp - dragging.t > 80) spin = 0;
    dragging = undefined;
    schedule();
  };
  surface.addEventListener('pointerdown', onDown);
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onUp);

  const onLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(raf);
    raf = 0;
    visible = false;
    options.onLost?.();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    show(next, nextCount, start = 0) {
      frames = next;
      count = nextCount;
      position = start;
      shown = -1;
      dirty = true;
      schedule();
    },
    setPaused(next) {
      paused = next;
      schedule();
    },
    setVisible(next) {
      visible = next;
      if (!next) {
        cancelAnimationFrame(raf);
        raf = 0;
        last = 0;
      }
      schedule();
    },
    turn(radians) {
      angle += radians;
      dirty = true;
      schedule();
    },
    destroy() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', onUp);
      surface.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('webglcontextlost', onLost);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
