// dsh 隔离启动器：SDK 用 `node <本文件> --profile … --patch …` 启动 dsh（dshBin 指向这里）。
// 这里经 sudo 调用 root 的 heurion-sandbox-exec，降到该平台用户专属的 uid 后再运行真正的 dsh；
// stdin / stdout（SDK 的 JSON-RPC）原样接通，信号转发给子进程，退出码原样返回。
// 纯 JS（不经 tsx），参数来自平台写进环境的 HEURION_SANDBOX_*。
import { spawn } from 'node:child_process'

const { HEURION_SANDBOX_UID: uid, HEURION_SANDBOX_WORKSPACE: ws, HEURION_SANDBOX_HOME: home, HEURION_DSH_BIN: dsh } = process.env
if (!uid || !ws || !home || !dsh) {
  process.stderr.write('sandbox-launch: 缺少 HEURION_SANDBOX_* / HEURION_DSH_BIN\n')
  process.exit(64)
}
const child = spawn('sudo', ['-n', '/usr/local/bin/heurion-sandbox-exec', uid, ws, home, '--', process.execPath, dsh, ...process.argv.slice(2)], { stdio: 'inherit' })
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig))
child.on('error', err => { process.stderr.write(`sandbox-launch: ${err.message}\n`); process.exit(70) })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
