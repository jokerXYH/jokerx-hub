# 桌宠素材来源与许可

本站点（jokerx.top 中转站）的鲸鱼娘桌宠使用 Live2D 模型，来自开源项目：

| 项 | 内容 |
|---|---|
| 上游仓库 | [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) |
| 代码许可 | **MIT**（Copyright © 2026 Andersen216，全文见 `live2d/LICENSE`） |
| 美术许可 | **CC BY-NC-SA 4.0**（署名 · 非商业性使用 · 相同方式共享） |
| 美术版权 | 上善无形 / ZipZipPipe / 氵六青（逐项贡献见上游 `AUTHORS.md`、`PROVENANCE.md`） |
| 上游完整声明 | 见本目录 `live2d/NOTICE-upstream.md` |

## 第三方运行时

| 组件 | 许可 | 文件 |
|---|---|---|
| Live2D Cubism Core | Live2D 专有许可（免费随应用分发） | `live2d/vendor/live2dcubismcore.min.js` |
| PIXI.js 6.5.10 | MIT | `live2d/vendor/pixi.min.js` |
| @pixi/unsafe-eval 6.5.10 | MIT | `live2d/vendor/unsafe-eval.min.js`（站点 CSP 禁止 `unsafe-eval`，用它替换着色器代码生成） |
| pixi-live2d-display 0.4.0 | MIT | `live2d/vendor/cubism4.min.js` |

## 本站做了什么

- 原样搬运模型文件（`live2d/model/**`）与运行时，**没有重绘角色**；
- 为加快首屏加载，把两张贴图从 2048 PNG 缩到 1024 WebP（q88，1.86 MB → 0.37 MB），
  属于格式/分辨率压缩，不改画面内容；
- 自己写了外层交互（`live2d-pet.js` / `live2d-pet.css`）：按需加载、拖拽、点击随机动作、视线跟随、右键菜单；
- 站点本身**非商业**（无广告、无付费、无带货），符合 CC BY-NC-SA 的非商业条款。

## 声明

这是社区二创形象，非 DeepSeek 官方素材；`DeepSeek` 及相关名称、标志归其权利人所有。
若将来站点引入商业用途，需要重新取得美术授权或移除桌宠。
