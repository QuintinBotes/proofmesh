// The Terrain's symbols as one sigma custom layer (FR1404, NFR005): every point's position and colour in two buffers, drawn in one
// call, so showing an area's points or a search's matches rewrites bytes instead of adding graph nodes one by one. A point hidden
// has alpha 0 and no size.

const VS = `#version 300 es
in vec2 a_pos;
in vec4 a_color;
in float a_match;
uniform mat3 u_matrix;
uniform vec4 u_frame;
uniform float u_size;
uniform float u_matchSize;
out vec4 v_color;
void main() {
  vec2 p = a_pos * u_frame.xy + u_frame.zw;
  gl_Position = vec4((u_matrix * vec3(p, 1.0)).xy, 0.0, 1.0);
  gl_PointSize = a_color.a > 0.0 ? (a_match > 0.5 ? max(u_size, u_matchSize) : u_size) : 0.0;
  v_color = a_color;
}`
const FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = v_color.a * smoothstep(0.5, 0.4, d);
  o = vec4(v_color.rgb * a, a);
}`

export type Points = {
  /** Layout units to sigma's framed graph, and point diameters in device pixels, for the next frame. */
  frame: (f: [number, number, number, number], size: number, matchSize: number) => void
  /** Rewrites which points show, in what colour, and which are matches; the buffers upload on the next frame. */
  paint: (show: (i: number) => boolean, colour: (i: number) => [number, number, number], match: (i: number) => boolean) => void
  shown: Uint8Array
  program: (gl: WebGL2RenderingContext) => { render: (params: { matrix: Float32Array }) => void; kill: () => void }
}

/** x, y per point in graph units (sigma's, y up), n points. */
export function points(pos: Float32Array, n: number): Points {
  const colours = new Uint8Array(n * 4), match = new Uint8Array(n), shown = new Uint8Array(n)
  let dirty = true, frame: [number, number, number, number] = [1, 1, 0, 0], size = 1, matchSize = 1
  return {
    shown,
    frame: (f, s, m) => { frame = f; size = s; matchSize = m },
    paint: (show, colour, isMatch) => {
      for (let i = 0; i < n; i++) {
        const on = show(i)
        shown[i] = on ? 1 : 0
        match[i] = on && isMatch(i) ? 1 : 0
        if (on) { const [r, g, b] = colour(i); colours[i * 4] = r; colours[i * 4 + 1] = g; colours[i * 4 + 2] = b; colours[i * 4 + 3] = 255 } else colours[i * 4 + 3] = 0
      }
      dirty = true
    },
    program: (gl) => {
      const compile = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader'); return s }
      const prog = gl.createProgram()!
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'program')
      const vao = gl.createVertexArray()!, posBuf = gl.createBuffer()!, colBuf = gl.createBuffer()!, matchBuf = gl.createBuffer()!
      gl.bindVertexArray(vao)
      const attr = (name: string, buf: WebGLBuffer, data: ArrayBufferView, size: number, type: number, normalized: boolean) => {
        const loc = gl.getAttribLocation(prog, name)
        gl.bindBuffer(gl.ARRAY_BUFFER, buf)
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
        gl.enableVertexAttribArray(loc)
        gl.vertexAttribPointer(loc, size, type, normalized, 0, 0)
      }
      attr('a_pos', posBuf, pos, 2, gl.FLOAT, false)
      attr('a_color', colBuf, colours, 4, gl.UNSIGNED_BYTE, true)
      attr('a_match', matchBuf, match, 1, gl.UNSIGNED_BYTE, false)
      gl.bindVertexArray(null)
      const u = (name: string) => gl.getUniformLocation(prog, name)
      const uMatrix = u('u_matrix'), uFrame = u('u_frame'), uSize = u('u_size'), uMatch = u('u_matchSize')
      return {
        render: ({ matrix }) => {
          if (!n) return
          gl.useProgram(prog)
          gl.bindVertexArray(vao)
          if (dirty) {
            gl.bindBuffer(gl.ARRAY_BUFFER, colBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, colours)
            gl.bindBuffer(gl.ARRAY_BUFFER, matchBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, match)
            dirty = false
          }
          gl.uniformMatrix3fv(uMatrix, false, matrix)
          gl.uniform4f(uFrame, ...frame)
          gl.uniform1f(uSize, size)
          gl.uniform1f(uMatch, matchSize)
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
          gl.drawArrays(gl.POINTS, 0, n)
          gl.bindVertexArray(null)
        },
        kill: () => { gl.deleteBuffer(posBuf); gl.deleteBuffer(colBuf); gl.deleteBuffer(matchBuf); gl.deleteVertexArray(vao); gl.deleteProgram(prog) },
      }
    },
  }
}

/** A grid over the points, for finding the one under the pointer without a picking pass: cell side `step` in the same units. */
export function grid(pos: Float32Array, n: number, step: number): (x: number, y: number, r: number, ok: (i: number) => boolean) => number {
  const cells = new Map<number, number[]>()
  const key = (cx: number, cy: number) => cx * 1_000_003 + cy
  for (let i = 0; i < n; i++) { const k = key(Math.floor(pos[i * 2]! / step), Math.floor(pos[i * 2 + 1]! / step)); let c = cells.get(k); if (!c) cells.set(k, (c = [])); c.push(i) }
  return (x, y, r, ok) => {
    let best = -1, bestD = r * r
    const cx = Math.floor(x / step), cy = Math.floor(y / step), span = Math.max(1, Math.ceil(r / step))
    for (let dx = -span; dx <= span; dx++) for (let dy = -span; dy <= span; dy++) for (const i of cells.get(key(cx + dx, cy + dy)) ?? []) {
      if (!ok(i)) continue
      const d = (pos[i * 2]! - x) ** 2 + (pos[i * 2 + 1]! - y) ** 2
      if (d <= bestD) { bestD = d; best = i }
    }
    return best
  }
}
