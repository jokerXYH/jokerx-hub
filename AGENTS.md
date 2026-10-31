# 项目工作规则

## 双端发布

网站或子应用的功能、界面、配置变更完成后，默认必须同时更新两个地方：

1. **服务器**：按 `.secrets/宝塔面板-部署信息.md` 发布到 `/www/wwwroot/jokerx.top/`。后端文件变更后重启 `jokerx-attendance.service`。
2. **GitHub**：提交并推送到 `origin/main`，推送后检查 GitHub Actions。如果后续添加了 Actions 部署流程，还需确认对应运行成功。

完整生产仓、部署 Action 和 Android App 的发布流程记录在本机
`.secrets/宝塔面板-部署信息.md`；公开仓只镜像可公开的站点源码。App 版本变更还需按
私有仓流程构建签名 APK 并执行 `bt-deploy.cjs release`。

只有用户明确要求“仅本地修改”时才可跳过其中一端。交付前必须验证服务器文件和线上页面，并确认 GitHub 推送状态；任一端未完成都要明确报告。

禁止上传或提交 `.secrets/`、`config.json`、登录态、运行数据和本地虚拟环境。
