// Type declaration for .wasm file imports (handled by [[rules]] in wrangler.toml).
// Imported WASM modules are WebAssembly.Module instances at runtime, but we
// treat them as ArrayBuffer for passing to @bokuweb/zstd-wasm init().
declare module "*.wasm" {
  const value: ArrayBuffer;
  export default value;
}
