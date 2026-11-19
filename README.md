# translationApp

Chrome 扩展：网页划词翻译 + YouTube 双语字幕。多翻译引擎可切换（Edge 免费端点 / OpenAI 兼容大模型），用户自带 key，无自有后端。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/PLAN.md](docs/PLAN.md) | 产品与技术决策、范围边界 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块清单、依赖方向、通信约定 |
| [docs/TODO.md](docs/TODO.md) | 任务队列与验收标准 |

## 环境要求

- Node.js ≥ 24、pnpm ≥ 11
- Chrome ≥ 88（Manifest V3）

## 开发

```bash
pnpm install        # 安装依赖并自动生成 .wxt 类型
pnpm dev            # 启动开发服务器，自动打开 Chrome 并加载扩展（HMR）
pnpm test           # vitest 单元测试
pnpm lint           # eslint
pnpm compile        # tsc --noEmit 类型检查
pnpm build          # 构建产物到 .output/chrome-mv3
pnpm zip            # 构建并打包 .output/translation-app-<版本>-chrome.zip
```

手动加载产物：`chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 `.output/chrome-mv3`。

## 目录结构

```
entrypoints/          # WXT 入口（background、popup、options、content script）
modules/              # 业务模块，见 docs/ARCHITECTURE.md
  translation-core/   # 翻译引擎与缓存（仅 background 运行）
  settings/           # 用户配置存取 + 设置页
  selection-translate/ # 划词翻译
  youtube-subtitles/  # YouTube 字幕获取
  subtitle-pipeline/  # 字幕重组、预翻译调度、渲染
docs/                 # 规划文档
tests/                # 跨模块测试；模块单测在各模块目录内
```

## 发布到 Chrome Web Store

### 1. 注册开发者账号（首次一次性）

1. 打开 [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)，用 Google 账号登录
2. 同意《开发者协议与政策》，支付**一次性注册费 $5**（信用卡）
3. 要求：账号必须开启**两步验证（2FA）**，否则无法发布
4. 建议：
   - 用专用邮箱注册（重要通知发到这里，且**注册后邮箱不可更改**）
   - 新发布者默认**最多发布 2 个扩展**，之后可在 Dashboard 申请提额（多数情况即时生效）
   - 中国大陆在支持注册的地区列表内

### 2. 发布前自检

```bash
pnpm zip
```

- [ ] 产物 `.output/translation-app-<version>-chrome.zip` 生成成功（包上限 **2 GB**）
- [ ] `package.json` 的 `version` 已按语义化递增（如 0.1.0 → 0.2.0），zip 文件名自带版本号可核对
- [ ] manifest 权限最小化：只保留当前版本实际用到的权限（对照 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）
- [ ] 无远程代码：所有 JS/WASM 打包在 zip 内，无 `eval`、无 CDN 脚本（MV3 硬性要求）
- [ ] 图标齐全：16×16（工具栏）、48×48（管理页）、128×128（商店）PNG
- [ ] `pnpm test`、`pnpm lint`、`pnpm compile` 全绿

### 3. 首次上架步骤

1. Dashboard → **Add new item** → 选择 zip → **Upload**；校验通过后进入编辑页
2. **Store listing** 标签：
   - 名称（≤75 字符）、简短描述（≤132 字符，搜索结果展示，最重要）、详细描述（≤16384 字符）
   - 截图至少 1 张，尺寸 **1280×800 或 640×400**（PNG/JPEG）
   - 选 1 个类别（工具）、主要语言
3. **Privacy** 标签（审核重点）：
   - 单一用途声明：翻译用户主动选中的网页文本与 YouTube 字幕
   - 数据披露：用户选中的文本/字幕会发送到用户自行配置的翻译服务（Edge 端点或大模型 API）；引擎 key、语言偏好存于本地 `chrome.storage`；**不出售、不与第三方共享**
   - 每个权限逐条填写用途说明——**理由含糊是审核被拒第一大原因**
   - 因申请了宽 host 权限（划词需 `*://*/*`），需提供**可公开访问的隐私政策 URL**
4. **Distribution** 标签：免费；可见性三选一——公开 / 不公开（直链可装）/ 私有（指定账号内测）
5. **Test instructions** 标签：仅当审核员需要额外说明时填写
6. 点 **Submit for review**：
   - 默认「审核通过即发布」；也可取消勾选改为**手动发布**——审核通过后有 **30 天**窗口手动发布，超期退回草稿需重新提审
   - 提交后发现 bug：用 **Cancel review** 撤回，换包重传再提交

### 4. 审核与被拒应对

- 审核时长视扩展而定，从数小时到数天；拒绝/下架邮件默认会发到注册邮箱
- 常见被拒原因与对策：
  - 权限过多 → 删 manifest 中未用权限
  - 权限理由含糊 → 每条权限写具体句子：做什么、为什么必须
  - 远程托管代码 → 全部打包
  - 元数据误导 → 名称/描述/截图与实际功能一致
  - 缺隐私政策 → 补公开 URL
- 被拒后按邮件说明修改，重新提交即可；有异议走申诉表单

### 5. 更新已发布版本

1. 修改 `package.json` 的 `version`（必须大于线上版本）
2. `pnpm zip` → Dashboard 打开对应 item → **Package** 标签上传新 zip
3. 信息有变则同步更新 Store listing / Privacy，再 **Submit for review**
4. 版本更新同样需要过审；审核期间用户继续用旧版本

### 6. 不上架分发（自用/内测）

直接把 `.output/translation-app-<version>-chrome.zip` 发给对方，解压后在 `chrome://extensions` 开发者模式加载。Chrome 不再支持商店外的 `.crx` 安装，正式分发只能走商店。

## 参考来源

- [发布扩展 | Chrome for Developers](https://developer.chrome.com/docs/webstore/publish)
- [注册开发者账号 | Chrome for Developers](https://developer.chrome.com/docs/webstore/register)
- [Privacy 声明填写 | Chrome for Developers](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Store listing 填写 | Chrome for Developers](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [审核流程 | Chrome for Developers](https://developer.chrome.com/docs/webstore/review-process)
