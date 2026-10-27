# 安装、升级与发布

## 两种交付方式

源码保留在仓库根目录，发布时统一编译为 ESM JavaScript + `.d.ts`。npm 与 uni_modules 共用公共代码，仅包元数据、Vite 入口默认路径不同。应用只能选择其中一种，避免出现两份 SDK 单例。

| 安装方式 | SDK 导入 | Vite 导入 | 默认探针路径 |
|---|---|---|---|
| `npm install gio-uniapp-autotracker` | `gio-uniapp-autotracker` | `gio-uniapp-autotracker/vite` | `gio-uniapp-autotracker/autotrack` |
| 复制解压后的 `uni_modules/gio-uniapp-autotracker` | `@/uni_modules/gio-uniapp-autotracker/index.js` | `./uni_modules/gio-uniapp-autotracker/vite.js` | `@/uni_modules/gio-uniapp-autotracker/autotrack.js` |

Vite 导入路径相对于项目根目录中的 `vite.config.ts`，插件放在 uni 插件前。非标准目录可使用 `gioUniappAutoTrack({ runtimeImport: '实际的 autotrack 入口' })`，该入口必须与主 SDK 来自同一份安装。

现有工程如果没有声明 `"type": "module"`，Vite 5 会按 CommonJS 加载配置，不能直接静态导入仅支持 ESM 的 npm 入口。使用下列异步配置即可保留工程原有模块类型，两种安装方式都适用：

```ts
import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

const uniPlugin = (uni as unknown as { default?: typeof uni }).default ?? uni
export default defineConfig(async () => {
  const { gioUniappAutoTrack } = await import('gio-uniapp-autotracker/vite')
  // uni_modules 改用 await import('./uni_modules/gio-uniapp-autotracker/vite.js')
  return { plugins: [gioUniappAutoTrack(), uniPlugin()] }
})
```

已经使用 ESM 配置的工程可以继续静态导入；参见 [Vite 的 ESM 配置说明](https://vite.dev/guide/troubleshooting.html#this-package-is-esm-only)。App 运行时 `main.ts` 的 SDK 导入方式保持上表写法，无需动态导入。

Vue/Babel 解析器只存在于编译侧 `vite-runtime.js`，随包携带；App 根入口和探针入口不导入这些依赖。无需额外安装解析器。构建工具要求 Node ≥ 20.19；GitHub 发布环境固定 Node 22.14 与 npm 11.5.1。当前工具链以 Vue 3.4.21 / HBuilderX 5.24 为基准，微信与支付宝的 CLI 编译另以锁定的 DCloud `3.0.0-5020420260812001` 验证，并可通过 `GIO_UNI_COMPILER_ROOT` 复检 HBuilderX；其运行范围与真机状态见[小程序接入](./miniprogram.md)。不承诺 Vue2、Web、其他小程序、nvue 或 uni-app x 兼容。

升级 uni_modules 时完整替换模块目录，不能覆盖后留下旧文件；npm 按所需版本更新。升级 schema v2 必须清理应用编译缓存并完整重建 App，Vite 与运行时不得混用不同版本。正式构建中尚未验收的无埋点能力保持关闭，详情见 [无埋点验收](./autotrack-v2-release.md)。

## 本地构建与验证

```sh
pnpm install --frozen-lockfile
pnpm run release:prepare
```

以上命令不会发布 npm 或创建 Git 标签。`release:prepare` 先执行类型检查、全部代码测试和逐文件覆盖率门槛，再构建 SDK、生成压缩包并自动执行 `release:check`；任一步失败立即停止。单独运行代码测试使用 `pnpm run test:release`，完整功能矩阵及报告见[核心代码测试](./testing.md)。

`build:sdk` 用于开发时构建与同步 demo；`release:check` 可复检已有交付包，检查摘要并在仓库外执行真实压缩包的安装、类型、SDK 运行时和 Vite 转换验证，同时通过 Vite 5 真正加载两渠道的 CommonJS 异步配置与 ESM 静态配置，最后检查 demo 消费者类型和编译结构。

| 输出 | 内容 |
|---|---|
| `dist/npm` | 可发布 npm 包 |
| `dist/uni_modules/gio-uniapp-autotracker` | 可复制模块 |
| `demo/uni_modules/gio-uniapp-autotracker` | 与交付模块相同的 demo 依赖 |
| `dist/release/gio-uniapp-autotracker-版本.tgz` | npm pack 最终产物 |
| `dist/release/gio-uniapp-autotracker-版本-uni_modules.tgz` | 含 uni_modules 顶层目录的附件 |
| `dist/release/release.json` | 包版本、渠道、文件名、npm SHA-512 integrity 与模块 SHA-256 |

生成目录可以重复构建，会清除旧文件，不提交 Git。发布校验记录源码、测试、测试配置、工作流、锁文件、构建脚本及实际文件摘要；修改这些输入或产物后必须重新构建，不能只改元数据继续发布。两个渠道都包含 LICENSE 与第三方许可说明。

## 版本与自动发布

`package.json.version` 是唯一版本来源，运行时上报同一版本；调用方不能覆盖 `sdkVersion`。只接受规范 SemVer，不接受 build metadata，Git 标签必须精确为 `v${version}`。

| 包版本示例 | Git 标签 | npm 渠道 | GitHub Release |
|---|---|---|---|
| `1.0.0` | `v1.0.0` | `latest` | 正式版 |
| `1.1.0-beta.1` | `v1.1.0-beta.1` | `next` | 预发布 |
| `1.1.0-rc.1` | `v1.1.0-rc.1` | `next` | 预发布 |

`.github/workflows/test.yml` 在分支推送和 PR 上运行完整打包前检查。`.github/workflows/publish.yml` 监听 `v*` 标签，依次执行锁定依赖安装、代码测试及覆盖率、构建、压缩包消费者验证、保存 Actions 构件、发布 npm、创建 GitHub Release 并上传同一批压缩包与摘要。`release:publish` 自身也先执行代码测试和已有交付包检查。标签与包版本不一致时停止；仓库根仍保持 `private: true`，发布脚本只发布验证过的压缩包。

完成三端验收和发布身份准备后，再修改版本、提交变更并推送对应标签。当前不会自动替你创建或推送标签。工作流触发即授权其发布该标签对应版本，因此不要用正式标签试跑流程。

发布失败时可重跑同一工作流：已存在且 integrity 完全相同的 npm 版本跳过发布，继续补齐附件；同版本不同内容停止，不能覆盖。新发布的旧版本不能把渠道回退；已发布版本补附件时可保留已前进的渠道。registry 短暂同步延迟只重试读取验证，不重复执行 publish。若实际发布成功但本地收到失败，重跑会先核对已发布内容。GitHub Release 附件按同一版本重新上传。

## 首次发布身份准备

仓库在 growingio 组织下，并不自动拥有同名 npm 包。首次发布前需要包名可用或现有包维护者权限，并确认 GitHub 仓库公开，以满足公开 provenance 发布条件。

已有 npm 包时，由维护者在包设置中配置 Trusted Publisher：组织 `growingio`、仓库 `gio-uniapp-autotracker`、工作流文件名 `publish.yml`，当前不配置 Environment；若设置页区分 allowed actions，允许直接 `npm publish`。工作流使用 GitHub 托管 runner 和 `id-token: write`，不需要长期 npm token。要求与配置来源见 [npm Trusted Publishing 官方文档](https://docs.npmjs.com/trusted-publishers/)。

全新包如果尚无包设置页，需要维护者先完成一次受控的首次发布，再配置 Trusted Publisher；不能假定组织名相同就可以直接使用 OIDC。首次发布也必须使用上述验证过的 npm `.tgz`，保留版本渠道，不能从仓库根发布。登录、首次发布和 npm 网页配置均是外部操作，本轮代码修复不会执行。完成后，使用同版本同内容的标签流程可补齐 GitHub 附件；后续版本正常使用 OIDC。

## DCloud 插件市场

本期交付方式是 npm 与 GitHub Release 下载，暂不执行市场上架。模块保留 id、展示名、uni_modules 布局和平台声明；平台待验收处为 `-`，不支持处为 `x`，不把计划支持写成已验证支持。将来上架前再按照当时市场要求完善发布者信息、商品说明、截图、合规声明和经证据确认的兼容矩阵，并验证市场导入流程。

## 验收记录

构建与 mock collector 验证仅证明代码和受控链路。三端需要分别记录设备型号、系统/基座/SDK 版本、业务触发、真实请求及服务端收数；尤其核对宿主 dataset、picker 下标回退、标题更新、前后台与身份/会话边界。未取得证据的能力不能通过修改 `src/constants/platform.ts` 假装完成验收。
