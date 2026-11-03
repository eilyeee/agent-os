/**
 * pm2 常驻配置。先 pnpm build，再 pm2 start ecosystem.config.cjs。
 * 凭证仍然由 dotenv 从 .env 读取，不写进这里。
 */
module.exports = {
  apps: [
    {
      name: "agent-os",
      script: "dist/index.js",
      cwd: __dirname,
      interpreter: "node",
      // 单实例：会话与协作收件箱都在进程内存里，多实例会各持一份状态。
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5_000,
      // 长连接断线由 SDK 自动重连，不要因为空闲把进程判死。
      kill_timeout: 10_000,
      env: {
        NODE_ENV: "production",
        // 飞书是国内服务，直连约 17ms；而 pm2 会把启动时 shell 里的
        // http_proxy / all_proxy 一起继承下来，axios 在 Node 里默认认这些变量，
        // 于是每一次发消息、刷卡片都绕经本地代理再出国再回来，凭空多一个故障点。
        // 实测代价：长连接每 15–25 分钟断一批，日志里累计 351 次 reconnect，
        // 外加成片的 "Client network socket disconnected before secure TLS
        // connection was established"。
        // 这里只把飞书摘出代理；两个 CLI 引擎要连 Anthropic / OpenAI，
        // 仍然走代理（childEnvironment 不会剥掉代理变量）。
        no_proxy: ".feishu.cn,.larksuite.com,127.0.0.1,localhost",
        NO_PROXY: ".feishu.cn,.larksuite.com,127.0.0.1,localhost",
      },
      out_file: "logs/agent-os.out.log",
      error_file: "logs/agent-os.err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
