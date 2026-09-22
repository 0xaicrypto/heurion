// #1101: @napi-rs/canvas 是 pptx-react-viewer 的 Node 侧按需依赖（服务端
// EMF 光栅化路径）— 浏览器端从不动态加载它，但 rollup 构建时仍要能解析该
// import（spike #1102 已验证：stub 后 os/path/fs/node: 外部化警告一并消失）。
export default {};
