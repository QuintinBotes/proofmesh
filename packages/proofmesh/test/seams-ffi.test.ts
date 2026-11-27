import { beforeAll, describe, expect, it } from 'vitest'
import { fixtureRepo, indexedDataDir, indexedRepo, rows, symbolId, tool, withSnapshot } from './helpers.js'

type Rel = { type: string; direction: string; resolution: string; origin: string; basis?: string; other: { qualified_name?: string; path?: string }; site: { path: string; start_line: number }; detail: Record<string, string> | null }
/** The id of the symbol of that qualified name in that file: a header and its source file name a C function alike. */
const idIn = (dataDir: string, qualified: string, file: string) => {
  const hit = (tool(dataDir, 'find_symbols', { text: qualified.split(/[:.]/).pop()!, path_prefix: file }).data.symbols as Array<{ id: string; qualified_name: string; path: string }>).find((s) => s.qualified_name === qualified && s.path === file)
  if (!hit) throw new Error(`symbol ${qualified} not found in ${file}`)
  return hit.id
}
const callsOf = (dataDir: string, id: string, direction: 'in' | 'out') => tool(dataDir, 'get_relationships', { subject_id: id, direction, types: ['calls'], include_external: true }).data.relationships as Rel[]
/** The calls rows the FFI pass wrote from a symbol, with their candidates as `name@path`. */
const ffiFrom = (dataDir: string, from: string) => withSnapshot(dataDir, (db) => rows(db, 'calls')).filter((r) => r.from === from && r.origin === 'contract_match').map((r) => ({ resolution: r.resolution, to: r.to, candidates: r.candidates, rule: r.detail?.rule, library: r.detail?.library, path: r.path, line: r.line }))

describe('FR460 to FR467 FFI seams: a call across a foreign-function interface is linked to the other side by its naming rule, labelled inferred', () => {
  let dataDir = ''
  beforeAll(async () => { dataDir = (await indexedDataDir(fixtureRepo('seams-ffi'))).dataDir }, 120000)

  it('FR460 scenario 1: the native method Native.add has one outbound calls candidate, Java_com_acme_Native_add in c/jni.c, rule jni, at its own declaration', () => {
    expect(ffiFrom(dataDir, 'com.acme.Native.add')).toEqual([
      { resolution: 'candidate', to: null, candidates: ['c/jni:Java_com_acme_Native_add@c/jni.c'], rule: 'jni', library: undefined, path: 'java/src/main/java/com/acme/Native.java', line: 8 },
    ])
    const out = callsOf(dataDir, symbolId(dataDir, 'com.acme.Native.add'), 'out')
    expect(out.map((r) => ({ resolution: r.resolution, basis: r.basis, rule: r.detail?.rule }))).toEqual([{ resolution: 'candidate', basis: 'inferred', rule: 'jni' }])
  })

  it('FR461 FR462 FR463 scenario 2: calc_add in c/calc.c has exactly three inbound calls, the P/Invoke declaration, the cgo call and the Rust extern call, each a candidate with basis inferred', () => {
    const inbound = callsOf(dataDir, idIn(dataDir, 'c/calc:calc_add', 'c/calc.c'), 'in')
    expect(inbound.map((r) => ({ from: r.other.qualified_name, path: r.site.path, line: r.site.start_line, resolution: r.resolution, basis: r.basis, rule: r.detail?.rule })).sort((a, b) => a.rule!.localeCompare(b.rule!))).toEqual([
      { from: 'go/calc:Sum', path: 'go/calc.go', line: 7, resolution: 'candidate', basis: 'inferred', rule: 'cgo' },
      { from: 'Calc.calc_add', path: 'cs/Calc.cs', line: 5, resolution: 'candidate', basis: 'inferred', rule: 'pinvoke' },
      { from: 'rust/lib:sum', path: 'rust/lib.rs', line: 6, resolution: 'candidate', basis: 'inferred', rule: 'rust_extern_c' },
    ])
    // The header only declares it: a definition is the target where the repository has one.
    expect(callsOf(dataDir, idIn(dataDir, 'c/calc:calc_add', 'c/calc.h'), 'in')).toEqual([])
  })

  it('FR464 scenario 3: calc.add(1, 2) in use is a candidate call to py_add in py/ext.c, rule python_c_extension', () => {
    expect(ffiFrom(dataDir, 'py/use:use')).toEqual([{ resolution: 'candidate', to: null, candidates: ['py/ext:py_add@py/ext.c'], rule: 'python_c_extension', library: undefined, path: 'py/use.py', line: 5 }])
    expect(callsOf(dataDir, idIn(dataDir, 'py/ext:py_add', 'py/ext.c'), 'in').map((r) => ({ from: r.other.qualified_name, basis: r.basis }))).toEqual([{ from: 'py/use:use', basis: 'inferred' }])
  })

  it('FR465 scenario 4: analyze_impact on calc_add with include_inferred lists the C#, Go and Rust callers as dependents, each inferred', () => {
    const impact = tool(dataDir, 'analyze_impact', { subject_ids: [idIn(dataDir, 'c/calc:calc_add', 'c/calc.c')], include_inferred: true }).data as { dependents: Array<{ qualified_name: string; depth: number; basis: string }> }
    for (const q of ['Calc.calc_add', 'go/calc:Sum', 'rust/lib:sum']) expect(impact.dependents.find((d) => d.qualified_name === q), q).toMatchObject({ depth: 1, basis: 'inferred' })
    // Not followed without include_inferred: a naming convention is no observed edge.
    const plain = tool(dataDir, 'analyze_impact', { subject_ids: [idIn(dataDir, 'c/calc:calc_add', 'c/calc.c')], include_inferred: false }).data as { dependents: Array<{ qualified_name: string }> }
    expect(plain.dependents.map((d) => d.qualified_name)).toEqual([])
  })

  it('FR467 scenario 5: the census reports the FFI seams found, per mechanism', () => {
    expect(tool(dataDir, 'workspace_status').data.ffi_seams).toEqual({ cgo: 1, jni: 1, pinvoke: 1, python_c_extension: 1, rust_extern_c: 1 })
  })
})

describe('FR460 to FR466 the FFI rules on their edge cases', () => {
  let dataDir = ''
  beforeAll(async () => {
    dataDir = (await indexedRepo({
      // JNI: an overloaded method's name carries its signature, and `_1` escapes an underscore in a Java name.
      'java/org/x/Codec.java': 'package org.x;\n\npublic class Codec {\n    static native int my_pack(int a, int b);\n    native void lonely();\n    static {\n        System.loadLibrary("codec");\n    }\n}\n',
      'c/codec.c': '#include <jni.h>\n\nJNIEXPORT jint JNICALL Java_org_x_Codec_my_1pack__II(JNIEnv* e, jclass c, jint a, jint b) {\n    return a;\n}\n',
      'kt/org/x/Kodec.kt': 'package org.x\n\nclass Kodec {\n    external fun twice(a: Int): Int\n}\n',
      'c/kodec.c': '#include <jni.h>\n\nJNIEXPORT jint JNICALL Java_org_x_Kodec_twice(JNIEnv* e, jobject o, jint a) {\n    return a * 2;\n}\n',
      // P/Invoke: EntryPoint names the C function; two definitions of one name are ambiguous; a system library is external.
      'cs/Native.cs': 'using System.Runtime.InteropServices;\n\npublic static partial class Native\n{\n    [DllImport("dup", EntryPoint = "twice")]\n    static extern int Twice(int a);\n\n    [LibraryImport("user32")]\n    private static partial int MessageBoxW(nint h);\n}\n',
      'c/one.c': 'int twice(int a) {\n    return a * 2;\n}\n',
      'c/two.c': 'int twice(int a) {\n    return a + a;\n}\n',
      // cgo both ways: a Go function `//export` marks is called from C; a C function the repository lacks is external, by its -l library.
      'go/bridge.go': 'package bridge\n\n// #cgo LDFLAGS: -lz\n// #include <zlib.h>\nimport "C"\n\n//export GoCallback\nfunc GoCallback() int {\n\treturn 1\n}\n\nfunc Version() *C.char {\n\treturn C.zlibVersion()\n}\n\nfunc Str() {\n\t_ = C.CString("x")\n}\n',
      'c/callback.c': 'extern int GoCallback(void);\nextern int rust_double(int);\n\nint call_back(void) {\n    return GoCallback() + rust_double(2);\n}\n',
      // Rust: a #[no_mangle] function C calls, and an extern block of a library outside the repository with a link_name.
      // Python: a function imported from an extension module by name.
      'py/fast.c': '#include <Python.h>\n\nstatic PyObject* fast_go(PyObject* self, PyObject* args) {\n    Py_RETURN_NONE;\n}\n\nstatic PyMethodDef Methods[] = {\n    {"go", (PyCFunction)fast_go, METH_NOARGS, NULL},\n    {NULL, NULL, 0, NULL}\n};\n\nPyMODINIT_FUNC PyInit_fast(void) {\n    return NULL;\n}\n',
      'py/run.py': 'from fast import go as start\n\n\ndef run():\n    return start()\n',
      'rust/ffi.rs': '#[no_mangle]\npub extern "C" fn rust_double(x: i32) -> i32 {\n    x * 2\n}\n\n#[link(name = "m")]\nextern "C" {\n    #[link_name = "cos"]\n    fn cosine(x: f64) -> f64;\n}\n\nfn angle() -> f64 {\n    unsafe { cosine(1.0) }\n}\n',
    })).dataDir
  }, 120000)

  it('FR460 a Kotlin external method is a JNI declaration too', () => {
    expect(ffiFrom(dataDir, 'org.x.Kodec.twice')).toEqual([{ resolution: 'candidate', to: null, candidates: ['c/kodec:Java_org_x_Kodec_twice@c/kodec.c'], rule: 'jni', library: undefined, path: 'kt/org/x/Kodec.kt', line: 4 }])
  })

  it('FR460 a JNI name with an overload signature and an escaped underscore is decoded to its method; a native method with no C side is resolved_external with the library loadLibrary names', () => {
    expect(ffiFrom(dataDir, 'org.x.Codec.my_pack')).toEqual([{ resolution: 'candidate', to: null, candidates: ['c/codec:Java_org_x_Codec_my_1pack__II@c/codec.c'], rule: 'jni', library: undefined, path: 'java/org/x/Codec.java', line: 4 }])
    expect(ffiFrom(dataDir, 'org.x.Codec.lonely')).toEqual([{ resolution: 'resolved_external', to: 'codec:Java_org_x_Codec_lonely', candidates: [], rule: 'jni', library: 'codec', path: 'java/org/x/Codec.java', line: 5 }])
  })

  it('FR461 a P/Invoke EntryPoint names the C function, ambiguous where several define it, and the library is matched to no build target', () => {
    expect(ffiFrom(dataDir, 'Native.Twice')).toEqual([{ resolution: 'ambiguous', to: null, candidates: ['c/one:twice@c/one.c', 'c/two:twice@c/two.c'], rule: 'pinvoke', library: undefined, path: 'cs/Native.cs', line: 5 }])
  })

  it('FR462 a C call of a Go function that //export marks is linked to it, rule cgo_export, and the cgo pseudo-functions are left as they were', () => {
    expect(ffiFrom(dataDir, 'c/callback:call_back').filter((r) => r.rule === 'cgo_export')).toEqual([{ resolution: 'candidate', to: null, candidates: ['go/bridge:GoCallback@go/bridge.go'], rule: 'cgo_export', library: undefined, path: 'c/callback.c', line: 5 }])
    expect(ffiFrom(dataDir, 'go/bridge:Str')).toEqual([])
  })

  it('FR463 a C call of a #[no_mangle] Rust function is linked to it, rule rust_no_mangle', () => {
    expect(ffiFrom(dataDir, 'c/callback:call_back').filter((r) => r.rule === 'rust_no_mangle')).toEqual([{ resolution: 'candidate', to: null, candidates: ['rust/ffi:rust_double@rust/ffi.rs'], rule: 'rust_no_mangle', library: undefined, path: 'c/callback.c', line: 5 }])
  })

  it('FR464 a function imported by name from an extension module, under an alias, is linked to the C function its PyMethodDef entry registers', () => {
    expect(ffiFrom(dataDir, 'py/run:run')).toEqual([{ resolution: 'candidate', to: null, candidates: ['py/fast:fast_go@py/fast.c'], rule: 'python_c_extension', library: undefined, path: 'py/run.py', line: 5 }])
  })

  it('FR466 a declaration whose counterpart is outside the repository is resolved_external with the library where the code writes it, never a guess', () => {
    expect(ffiFrom(dataDir, 'Native.MessageBoxW')).toEqual([{ resolution: 'resolved_external', to: 'user32:MessageBoxW', candidates: [], rule: 'pinvoke', library: 'user32', path: 'cs/Native.cs', line: 8 }])
    expect(ffiFrom(dataDir, 'go/bridge:Version')).toEqual([{ resolution: 'resolved_external', to: 'z:zlibVersion', candidates: [], rule: 'cgo', library: 'z', path: 'go/bridge.go', line: 13 }])
    // The C name is the link_name, and the library the #[link] attribute names.
    expect(ffiFrom(dataDir, 'rust/ffi:angle')).toEqual([{ resolution: 'resolved_external', to: 'm:cos', candidates: [], rule: 'rust_extern_c', library: 'm', path: 'rust/ffi.rs', line: 13 }])
    const out = callsOf(dataDir, symbolId(dataDir, 'rust/ffi:angle'), 'out')
    expect(out.map((r) => ({ resolution: r.resolution, basis: r.basis }))).toEqual([{ resolution: 'resolved_external', basis: 'inferred' }])
  })
})
